import path from "node:path";
import { readdir } from "node:fs/promises";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { StagedRecipe } from "../src/lib/recipe-schema";
import { extractedRecipeSchema, stagedRecipeSchema } from "../src/lib/recipe-schema";
import { normalizeRecipeDraft } from "../src/lib/recipes";
import { resolveRuntimeConfig } from "./lib/environment";
import { decideExistingArtifactAction } from "./lib/ingest";
import {
  collectInputFiles,
  ensureDir,
  fileExists,
  inferMimeType,
  listJsonFiles,
  listRecipeMarkdownFiles,
  readStagedRecipe,
  writeJson
} from "./lib/io";
import { detectRecipeSections, evaluateReviewReasons, extractRecipeFromSourceFiles, structureRecipeFromMarkdown } from "./lib/ocr";
import {
  computePublicationHash,
  createSlugFromTitle,
  deriveRecipeId,
  ensureUniqueSlug,
  isArtifactPublishCurrent,
  markArtifactPublished,
  markArtifactUnpublished,
  publishArtifact,
  removePublishedRecipe,
  writeStageArtifact
} from "./lib/publish";
import { applyArtifactPatch, deriveSplitArtifactId, parseBooleanInput, parseDelimitedList } from "./lib/review";
import { groupPairedScanFiles } from "./lib/source-files";
import { filterArtifactsByBatch, formatStatusSummary, summarizeArtifacts } from "./lib/status";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = resolveRuntimeConfig(projectRoot);

const helpText = `
Usage:
  npm run recipes -- ingest --input /path/to/scans [--stage-only] [--with-google-fallback] [--reprocess-existing] [--report ./path/to/report.json]
  npm run recipes -- review
  npm run recipes -- show --id recipe-0001
  npm run recipes -- update --id recipe-0001 [--title \"...\"] [--ingredients \"a|b|c\"] [--publish]
  npm run recipes -- split --id recipe-0001 [--title \"Second Recipe\"] [--trim-current] [--manual]
  npm run recipes -- reprocess --id recipe-0001 [--with-google-fallback] [--publish]
  npm run recipes -- republish-stale
  npm run recipes -- status [--batch batch-01] [--json]
  npm run recipes -- approve --id recipe-0001
  npm run recipes -- publish --id recipe-0001

Commands:
  ingest   OCR one file or a directory of scans, stage artifacts, and publish approved entries.
  review   List staged recipes that still need manual review.
  show     Print a staged artifact with recipe fields and an OCR preview for manual review.
  update   Patch a staged artifact's recipe fields without hand-editing the raw JSON.
  split    Preview or create split artifacts when one OCR scan contains multiple recipes.
  reprocess  Re-run OCR/structuring for an artifact from its source scan or current OCR section.
  republish-stale  Rebuild approved recipes whose published pages are out of date with their staged artifact.
  status   Show repository counts, OCR breakdowns, and optional batch-filtered pilot metrics.
  approve  Mark a staged recipe as approved and publish it to the site.
  publish  Re-publish an already approved staged recipe and refresh its public assets.
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(helpText.trim());
    return;
  }

  switch (command) {
    case "ingest":
      await ingestCommand(rest);
      break;
    case "review":
      await reviewCommand();
      break;
    case "show":
      await showCommand(rest);
      break;
    case "update":
      await updateCommand(rest);
      break;
    case "split":
      await splitCommand(rest);
      break;
    case "reprocess":
      await reprocessCommand(rest);
      break;
    case "republish-stale":
      await republishStaleCommand();
      break;
    case "status":
      await statusCommand(rest);
      break;
    case "approve":
      await approveCommand(rest, true);
      break;
    case "publish":
      await publishCommand(rest);
      break;
    default:
      throw new Error(`Unknown command "${command}".\n\n${helpText}`);
  }
}

async function ingestCommand(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      input: { type: "string" },
      "stage-only": { type: "boolean", default: false },
      "with-google-fallback": { type: "boolean", default: false },
      "reprocess-existing": { type: "boolean", default: false },
      report: { type: "string" }
    },
    allowPositionals: true
  });

  const inputPath = parsed.values.input ? path.resolve(parsed.values.input) : config.rawScanDir;
  if (!inputPath) {
    throw new Error("Pass --input /path/to/scans or set RAW_SCAN_DIR in .env.");
  }

  const files = await collectInputFiles(inputPath);
  if (files.length === 0) {
    console.log(`No supported scan files found in ${inputPath}`);
    return;
  }
  const sourceGroups = groupPairedScanFiles(files);

  await ensureDir(config.stagingDir);
  await ensureDir(config.reviewDir);
  await ensureDir(config.publishedScanDir);

  const idRoot = resolveIdRoot(inputPath);
  const report = {
    started_at: new Date().toISOString(),
    input_path: inputPath,
    processed: 0,
    published: 0,
    staged_only: 0,
    needs_review: 0,
    skipped_existing: 0,
    failed: 0,
    files: [] as Array<{
      file_path: string;
      id?: string;
      title?: string;
      status: "published" | "staged" | "needs_review" | "failed" | "skipped";
      artifact_path?: string;
      recipe_path?: string;
      message?: string;
    }>
  };

  for (const sourceGroup of sourceGroups) {
    const primaryPath = sourceGroup.primaryPath;
    const sourceLabel = sourceGroup.filePaths.join(" + ");
    const id = deriveRecipeId(primaryPath, idRoot);
    const existingArtifactPath = path.join(config.stagingDir, `${id}.json`);
    const existingArtifact = (await fileExists(existingArtifactPath)) ? await readStagedRecipe(existingArtifactPath) : null;

    if (existingArtifact) {
      const decision = decideExistingArtifactAction(existingArtifact, parsed.values["reprocess-existing"]);
      if (decision.skip) {
        console.log(`\nSkipping ${sourceLabel}`);
        console.log(`Existing artifact: ${existingArtifact.id}`);
        console.log(decision.reason);
        report.skipped_existing += 1;
        report.files.push({
          file_path: sourceLabel,
          id: existingArtifact.id,
          title: existingArtifact.recipe.title,
          status: "skipped",
          artifact_path: existingArtifactPath,
          message: decision.reason
        });
        continue;
      }
    }

    console.log(`\nProcessing ${sourceLabel}`);
    try {
      const extraction = await extractRecipeFromSourceFiles(
        sourceGroup.filePaths,
        config,
        parsed.values["with-google-fallback"]
      );
      const baseSlug = createSlugFromTitle(extraction.recipe.title, id);
      const slug = existingArtifact?.slug || (await ensureUniqueSlug(baseSlug, config.projectRoot));
      const normalized = normalizeRecipeDraft(
        id,
        extractedRecipeSchema.parse(extraction.recipe),
        [],
        config.defaultSourceName,
        config.defaultSourceFamily
      );

      normalized.slug = slug;
      const reviewReasons = evaluateReviewReasons(normalized, extraction.markdown);
      normalized.review_status = reviewReasons.length > 0 ? "needs_review" : "approved";

      let artifact = stagedRecipeSchema.parse({
        version: 1,
        id,
        slug,
        source: {
          input_path: primaryPath,
          related_input_paths: sourceGroup.filePaths.filter((filePath) => filePath !== primaryPath),
          file_name: path.basename(primaryPath),
          mime_type: inferMimeType(primaryPath),
          ingested_at: new Date().toISOString()
        },
        ocr: {
          provider: extraction.provider,
          markdown: extraction.markdown,
          raw_response: extraction.rawResponse,
          fallback_used: extraction.fallbackUsed
        },
        recipe: {
          ...normalized,
          id,
          slug
        },
        review: {
          status: normalized.review_status,
          reasons: reviewReasons
        },
        publication: existingArtifact?.publication
      });

      if (!parsed.values["stage-only"] && artifact.review.status === "needs_review" && artifact.publication.is_published && artifact.publication.published_slug) {
        const previousPublishedSlug = artifact.publication.published_slug;
        await removePublishedRecipe(previousPublishedSlug, config);
        artifact = markArtifactUnpublished(artifact);
        console.log(`Unpublished recipe: ${previousPublishedSlug}`);
      }

      let artifactPath = await writeStageArtifact(artifact, config.stagingDir);
      console.log(`Staged artifact: ${artifactPath}`);
      report.processed += 1;

      if (artifact.review.status === "needs_review") {
        await writeStageArtifact(artifact, config.reviewDir);
        console.log(`Needs review: ${artifact.review.reasons.join(" ")}`);
        report.needs_review += 1;
        report.files.push({
          file_path: sourceLabel,
          id: artifact.id,
          title: artifact.recipe.title,
          status: "needs_review",
          artifact_path: artifactPath,
          message: artifact.review.reasons.join(" ")
        });
        continue;
      }

      if (!parsed.values["stage-only"]) {
        if (artifact.publication.is_published && artifact.publication.published_slug && artifact.publication.published_slug !== artifact.slug) {
          await removePublishedRecipe(artifact.publication.published_slug, config);
          console.log(`Removed old slug: ${artifact.publication.published_slug}`);
        }
        const published = await publishArtifact(artifact, config);
        artifact = markArtifactPublished(artifact);
        artifactPath = await writeStageArtifact(artifact, config.stagingDir);
        console.log(`Published recipe: ${published.recipePath}`);
        report.published += 1;
        report.files.push({
          file_path: sourceLabel,
          id: artifact.id,
          title: artifact.recipe.title,
          status: "published",
          artifact_path: artifactPath,
          recipe_path: published.recipePath
        });
      } else {
        report.staged_only += 1;
        report.files.push({
          file_path: sourceLabel,
          id: artifact.id,
          title: artifact.recipe.title,
          status: "staged",
          artifact_path: artifactPath,
          message: "Staged only; publish skipped by flag."
        });
      }
    } catch (error) {
      console.error(`Failed to process ${sourceLabel}: ${String(error)}`);
      report.processed += 1;
      report.failed += 1;
      report.files.push({
        file_path: sourceLabel,
        status: "failed",
        message: String(error)
      });
    }
  }

  const completedAt = new Date().toISOString();
  console.log([
    "",
    "Batch summary",
    `- Processed: ${report.processed}`,
    `- Skipped existing: ${report.skipped_existing}`,
    `- Published: ${report.published}`,
    `- Staged only: ${report.staged_only}`,
    `- Needs review: ${report.needs_review}`,
    `- Failed: ${report.failed}`
  ].join("\n"));

  if (parsed.values.report) {
    const reportPath = path.resolve(parsed.values.report);
    await writeJson(reportPath, {
      ...report,
      completed_at: completedAt
    });
    console.log(`Report written to ${reportPath}`);
  }
}

async function reviewCommand() {
  const files = await listJsonFiles(config.reviewDir);
  if (files.length === 0) {
    console.log("No recipes are currently waiting for review.");
    return;
  }

  console.log(`Recipes waiting for review (${files.length})`);
  for (const filePath of files) {
    const artifact = await readStagedRecipe(filePath);
    console.log(`- ${artifact.id} (${artifact.recipe.title})`);
    console.log(`  source: ${artifact.source.input_path}`);
    for (const relatedSource of artifact.source.related_input_paths) {
      console.log(`  related source: ${relatedSource}`);
    }
    console.log(`  artifact: ${filePath}`);
    for (const reason of artifact.review.reasons) {
      console.log(`  - ${reason}`);
    }
  }
}

async function showCommand(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      id: { type: "string" },
      artifact: { type: "string" },
      ocr: { type: "boolean", default: false }
    },
    allowPositionals: true
  });

  const artifact = await resolveArtifactFromArgs(args);
  console.log(formatArtifactSummary(artifact, parsed.values.ocr));
}

async function updateCommand(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      id: { type: "string" },
      artifact: { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
      slug: { type: "string" },
      "source-name": { type: "string" },
      "source-family": { type: "string" },
      course: { type: "string" },
      cuisine: { type: "string" },
      "card-type": { type: "string" },
      "ocr-confidence": { type: "string" },
      dessert: { type: "string" },
      ingredients: { type: "string" },
      instructions: { type: "string" },
      notes: { type: "string" },
      tags: { type: "string" },
      proteins: { type: "string" },
      "review-status": { type: "string" },
      "review-reasons": { type: "string" },
      publish: { type: "boolean", default: false }
    },
    allowPositionals: true
  });

  const artifact = await resolveArtifactFromArgs(args);
  let nextArtifact = applyArtifactPatch(artifact, {
    title: parsed.values.title,
    summary: parsed.values.summary,
    slug: parsed.values.slug,
    source_name: parsed.values["source-name"],
    source_family: parsed.values["source-family"],
    course: parsed.values.course as StagedRecipe["recipe"]["course"] | undefined,
    cuisine: parsed.values.cuisine,
    card_type: parsed.values["card-type"] as StagedRecipe["recipe"]["card_type"] | undefined,
    ocr_confidence: parsed.values["ocr-confidence"] as StagedRecipe["recipe"]["ocr_confidence"] | undefined,
    dessert: parseBooleanInput(parsed.values.dessert),
    ingredients: parseDelimitedList(parsed.values.ingredients, /\|/g),
    instructions: parseDelimitedList(parsed.values.instructions, /\|/g),
    notes: parseDelimitedList(parsed.values.notes, /\|/g),
    tags: parseDelimitedList(parsed.values.tags, /[|,]/g),
    proteins: parseDelimitedList(parsed.values.proteins, /[|,]/g) as StagedRecipe["recipe"]["proteins"] | undefined,
    review_status: parsed.values["review-status"] as StagedRecipe["review"]["status"] | undefined,
    review_reasons: parseDelimitedList(parsed.values["review-reasons"], /\|/g)
  });

  if (nextArtifact.review.status !== "approved" && artifact.publication.is_published && artifact.publication.published_slug) {
    const previousPublishedSlug = artifact.publication.published_slug;
    await removePublishedRecipe(previousPublishedSlug, config);
    nextArtifact = markArtifactUnpublished(nextArtifact);
    console.log(`Unpublished recipe: ${previousPublishedSlug}`);
  }

  await persistArtifact(nextArtifact);
  console.log(`Updated ${nextArtifact.id}`);
  console.log(formatArtifactSummary(nextArtifact, false));

  if (parsed.values.publish) {
    if (nextArtifact.review.status !== "approved") {
      throw new Error(`Cannot publish ${nextArtifact.id} because it is marked ${nextArtifact.review.status}.`);
    }

    if (artifact.publication.is_published && artifact.publication.published_slug && artifact.publication.published_slug !== nextArtifact.slug) {
      await removePublishedRecipe(artifact.publication.published_slug, config);
      console.log(`Removed old slug: ${artifact.publication.published_slug}`);
    }
    const published = await publishArtifact(nextArtifact, config);
    nextArtifact = markArtifactPublished(nextArtifact);
    await persistArtifact(nextArtifact);
    console.log(`Published recipe: ${published.recipePath}`);
  }
}

async function splitCommand(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      id: { type: "string" },
      artifact: { type: "string" },
      title: { type: "string" },
      "trim-current": { type: "boolean", default: false },
      manual: { type: "boolean", default: false },
      publish: { type: "boolean", default: false }
    },
    allowPositionals: true
  });

  let sourceArtifact = await resolveArtifactFromArgs(args);
  const sections = detectRecipeSections(sourceArtifact.ocr.markdown);
  if (sections.length < 2) {
    console.log([
      `Detected ${sections.length} recipe section(s) in ${sourceArtifact.id}.`,
      "No split candidates were found beyond the current recipe title."
    ].join("\n"));
    return;
  }

  if (!parsed.values.title) {
    console.log(formatSplitSectionPreview(sourceArtifact, sections));
    return;
  }

  const selectedSection = selectRecipeSection(sections, parsed.values.title);
  if (!selectedSection) {
    throw new Error(
      `No OCR section matched "${parsed.values.title}". Available titles: ${sections.map((section) => section.title).join(", ")}`
    );
  }

  const splitId = deriveSplitArtifactId(sourceArtifact.id, selectedSection.title);
  const existingSplit = await findArtifactById(splitId);
  if (existingSplit) {
    throw new Error(`Split artifact ${splitId} already exists. Use show/update on it instead of creating it again.`);
  }

  const structuredRecipe = parsed.values.manual
    ? buildManualSplitDraft(sourceArtifact, selectedSection)
    : await structureRecipeFromMarkdown(
        selectedSection.markdown,
        `${path.basename(sourceArtifact.source.input_path)} :: ${selectedSection.title}`,
        config
      );
  const normalizedRecipe = normalizeRecipeDraft(
    splitId,
    extractedRecipeSchema.parse(structuredRecipe),
    [],
    config.defaultSourceName,
    config.defaultSourceFamily
  );
  const baseSlug = createSlugFromTitle(normalizedRecipe.title, splitId);
  const splitSlug = await ensureUniqueSlugForArtifact(baseSlug, splitId);
  normalizedRecipe.slug = splitSlug;

  const reviewReasons = evaluateReviewReasons(normalizedRecipe, selectedSection.markdown);
  normalizedRecipe.review_status = reviewReasons.length > 0 ? "needs_review" : "approved";

  let splitArtifact = stagedRecipeSchema.parse({
    version: 1,
    id: splitId,
    slug: splitSlug,
    source: {
      ...sourceArtifact.source,
      ingested_at: new Date().toISOString()
    },
    ocr: {
      provider: sourceArtifact.ocr.provider,
      markdown: selectedSection.markdown,
      raw_response: {
        derived_from_artifact_id: sourceArtifact.id,
        section_title: selectedSection.title,
        section_start_line: selectedSection.startLine,
        section_end_line: selectedSection.endLine
      },
      fallback_used: sourceArtifact.ocr.fallback_used
    },
    recipe: {
      ...normalizedRecipe,
      id: splitId,
      slug: splitSlug
    },
    review: {
      status: normalizedRecipe.review_status,
      reasons: reviewReasons
    },
    publication: {
      is_published: false
    }
  });

  await persistArtifact(splitArtifact);
  console.log(`Created split artifact: ${splitArtifact.id}`);
  console.log(formatArtifactSummary(splitArtifact, false));

  if (parsed.values.publish) {
    if (splitArtifact.review.status !== "approved") {
      throw new Error(`Cannot publish ${splitArtifact.id} because it is marked ${splitArtifact.review.status}.`);
    }

    const published = await publishArtifact(splitArtifact, config);
    splitArtifact = markArtifactPublished(splitArtifact);
    await persistArtifact(splitArtifact);
    console.log(`Published recipe: ${published.recipePath}`);
  }

  if (parsed.values["trim-current"]) {
    sourceArtifact = await trimArtifactToOwnSection(sourceArtifact, sections);
    console.log(`Trimmed source artifact to its own OCR section: ${sourceArtifact.id}`);
  }
}

async function statusCommand(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      batch: { type: "string" },
      json: { type: "boolean", default: false }
    },
    allowPositionals: true
  });

  const approvedRecipes = parsed.values.batch
    ? undefined
    : await listRecipeMarkdownFiles(path.join(config.projectRoot, "src/content/recipes"));
  const stagedArtifactPaths = await listJsonFiles(config.stagingDir);
  const stagedArtifacts = await Promise.all(stagedArtifactPaths.map((filePath) => readStagedRecipe(filePath)));
  const reviewArtifactPaths = await listJsonFiles(config.reviewDir);
  const reviewArtifacts = await Promise.all(reviewArtifactPaths.map((filePath) => readStagedRecipe(filePath)));
  const filteredArtifacts = filterArtifactsByBatch(stagedArtifacts, parsed.values.batch);
  const filteredReviewArtifacts = filterArtifactsByBatch(reviewArtifacts, parsed.values.batch);
  const publicScanEntries = parsed.values.batch
    ? []
    : await readdir(config.publishedScanDir, { withFileTypes: true }).catch(() => []);
  const publishedScanSets = publicScanEntries.filter((entry) => entry.isDirectory()).length;

  const summary = summarizeArtifacts(
    filteredArtifacts,
    filteredReviewArtifacts.length,
    parsed.values.batch
      ? undefined
      : {
          approvedRecipesOnSite: approvedRecipes?.length ?? 0,
          publishedScanSetsOnDisk: publishedScanSets
        },
    parsed.values.batch
  );

  if (parsed.values.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(formatStatusSummary(summary));
}

async function reprocessCommand(args: string[]) {
  const parsed = parseArgs({
    args,
    options: {
      id: { type: "string" },
      artifact: { type: "string" },
      "with-google-fallback": { type: "boolean", default: false },
      publish: { type: "boolean", default: false }
    },
    allowPositionals: true
  });

  const artifact = await resolveArtifactFromArgs(args);
  const sourceFiles = [artifact.source.input_path, ...artifact.source.related_input_paths];
  const reprocessFromCurrentSection = artifact.source.related_input_paths.length === 0 && isDerivedArtifactOcr(artifact.ocr.raw_response);

  const extraction = reprocessFromCurrentSection
    ? {
        provider: artifact.ocr.provider,
        markdown: artifact.ocr.markdown,
        rawResponse: artifact.ocr.raw_response,
        fallbackUsed: artifact.ocr.fallback_used,
        recipe: await structureRecipeFromMarkdown(artifact.ocr.markdown, path.basename(artifact.source.input_path), config)
      }
    : await extractRecipeFromSourceFiles(sourceFiles, config, parsed.values["with-google-fallback"]);

  let nextArtifact = rebuildArtifactFromExtraction(artifact, extraction);

  if (nextArtifact.review.status !== "approved" && artifact.publication.is_published && artifact.publication.published_slug) {
    const previousPublishedSlug = artifact.publication.published_slug;
    await removePublishedRecipe(previousPublishedSlug, config);
    nextArtifact = markArtifactUnpublished(nextArtifact);
    console.log(`Unpublished recipe: ${previousPublishedSlug}`);
  }

  await persistArtifact(nextArtifact);
  console.log(`Reprocessed ${nextArtifact.id}`);
  console.log(formatArtifactSummary(nextArtifact, false));

  if (parsed.values.publish) {
    if (nextArtifact.review.status !== "approved") {
      throw new Error(`Cannot publish ${nextArtifact.id} because it is marked ${nextArtifact.review.status}.`);
    }

    if (artifact.publication.is_published && artifact.publication.published_slug && artifact.publication.published_slug !== nextArtifact.slug) {
      await removePublishedRecipe(artifact.publication.published_slug, config);
      console.log(`Removed old slug: ${artifact.publication.published_slug}`);
    }

    const published = await publishArtifact(nextArtifact, config);
    nextArtifact = markArtifactPublished(nextArtifact);
    await persistArtifact(nextArtifact);
    console.log(`Published recipe: ${published.recipePath}`);
  }
}

async function republishStaleCommand() {
  const stagedArtifactPaths = await listJsonFiles(config.stagingDir);
  const stagedArtifacts = await Promise.all(stagedArtifactPaths.map((filePath) => readStagedRecipe(filePath)));
  const staleArtifacts = stagedArtifacts.filter(
    (artifact) => artifact.review.status === "approved" && artifact.publication.is_published && !isArtifactPublishCurrent(artifact)
  );

  if (staleArtifacts.length === 0) {
    console.log("No approved published artifacts are stale.");
    return;
  }

  console.log(`Republishing ${staleArtifacts.length} stale artifact(s)`);
  for (let artifact of staleArtifacts) {
    if (artifact.publication.published_slug && artifact.publication.published_slug !== artifact.slug) {
      await removePublishedRecipe(artifact.publication.published_slug, config);
      console.log(`Removed old slug: ${artifact.publication.published_slug}`);
    }

    const published = await publishArtifact(artifact, config);
    artifact = markArtifactPublished(artifact);
    await persistArtifact(artifact);
    console.log(`Republished ${artifact.id}: ${published.recipePath}`);
  }
}

async function approveCommand(args: string[], publishAfterApproval: boolean) {
  let artifact = await resolveArtifactFromArgs(args);
  artifact.review.status = "approved";
  artifact.review.reasons = [];
  artifact.recipe.review_status = "approved";

  await persistArtifact(artifact);

  console.log(`Approved ${artifact.id}`);
  if (publishAfterApproval) {
    if (artifact.publication.is_published && artifact.publication.published_slug && artifact.publication.published_slug !== artifact.slug) {
      await removePublishedRecipe(artifact.publication.published_slug, config);
      console.log(`Removed old slug: ${artifact.publication.published_slug}`);
    }
    const published = await publishArtifact(artifact, config);
    artifact = markArtifactPublished(artifact);
    await persistArtifact(artifact);
    console.log(`Published recipe: ${published.recipePath}`);
  }
}

async function publishCommand(args: string[]) {
  let artifact = await resolveArtifactFromArgs(args);
  if (artifact.review.status !== "approved") {
    throw new Error(`Cannot publish ${artifact.id} because it is still marked ${artifact.review.status}.`);
  }

  if (artifact.publication.is_published && artifact.publication.published_slug && artifact.publication.published_slug !== artifact.slug) {
    await removePublishedRecipe(artifact.publication.published_slug, config);
    console.log(`Removed old slug: ${artifact.publication.published_slug}`);
  }
  const published = await publishArtifact(artifact, config);
  artifact = markArtifactPublished(artifact);
  await persistArtifact(artifact);
  console.log(`Published recipe: ${published.recipePath}`);
}

async function resolveArtifactFromArgs(args: string[]): Promise<StagedRecipe> {
  const parsed = parseArgs({
    args,
    options: {
      id: { type: "string" },
      artifact: { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  const artifactPath = typeof parsed.values.artifact === "string" ? parsed.values.artifact : undefined;
  const artifactId = typeof parsed.values.id === "string" ? parsed.values.id : undefined;

  if (artifactPath) {
    return readStagedRecipe(path.resolve(artifactPath));
  }

  if (!artifactId) {
    throw new Error("Pass --id recipe-0001 or --artifact /path/to/staged.json.");
  }

  const candidates = [
    path.join(config.stagingDir, `${artifactId}.json`),
    path.join(config.reviewDir, `${artifactId}.json`)
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return readStagedRecipe(candidate);
    }
  }

  throw new Error(`No artifact found for ${artifactId}`);
}

async function findArtifactById(id: string): Promise<StagedRecipe | null> {
  const candidates = [
    path.join(config.stagingDir, `${id}.json`),
    path.join(config.reviewDir, `${id}.json`)
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return readStagedRecipe(candidate);
    }
  }

  return null;
}

async function persistArtifact(artifact: StagedRecipe): Promise<void> {
  await writeStageArtifact(artifact, config.stagingDir);
  const reviewCopy = path.join(config.reviewDir, `${artifact.id}.json`);
  if (artifact.review.status === "needs_review") {
    await writeStageArtifact(artifact, config.reviewDir);
    return;
  }

  if (await fileExists(reviewCopy)) {
    await unlink(reviewCopy);
  }
}

function resolveIdRoot(inputPath: string): string {
  if (config.rawScanDir) {
    const relativeToRaw = path.relative(config.rawScanDir, inputPath);
    if (relativeToRaw && !relativeToRaw.startsWith("..") && !path.isAbsolute(relativeToRaw)) {
      return config.rawScanDir;
    }
  }

  if (config.rawScanDir && inputPath === config.rawScanDir) {
    return config.rawScanDir;
  }

  return path.extname(inputPath) ? path.dirname(inputPath) : inputPath;
}

function formatSplitSectionPreview(artifact: StagedRecipe, sections: ReturnType<typeof detectRecipeSections>): string {
  const lines = [
    `Detected ${sections.length} recipe section(s) in ${artifact.id}:`,
    ...sections.flatMap((section) => {
      const previewLines = section.markdown
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 4);

      return [
        `- ${section.title} (lines ${section.startLine}-${section.endLine})`,
        ...previewLines.map((line) => `  ${line}`)
      ];
    }),
    "",
    `Create a split artifact with: npm run recipes -- split --id ${artifact.id} --title "Recipe Title"`
  ];

  return lines.join("\n");
}

function selectRecipeSection(
  sections: ReturnType<typeof detectRecipeSections>,
  title: string
): ReturnType<typeof detectRecipeSections>[number] | undefined {
  const normalizedLookup = normalizeLookupValue(title);
  return sections.find((section) => normalizeLookupValue(section.title) === normalizedLookup);
}

async function trimArtifactToOwnSection(
  artifact: StagedRecipe,
  sections: ReturnType<typeof detectRecipeSections>
): Promise<StagedRecipe> {
  const ownSection = selectRecipeSection(sections, artifact.recipe.title);
  if (!ownSection) {
    throw new Error(`Could not find an OCR section matching the current title "${artifact.recipe.title}".`);
  }

  let nextArtifact = stagedRecipeSchema.parse({
    ...artifact,
    ocr: {
      ...artifact.ocr,
      markdown: ownSection.markdown,
      raw_response: {
        trimmed_from_artifact_id: artifact.id,
        section_title: ownSection.title,
        section_start_line: ownSection.startLine,
        section_end_line: ownSection.endLine
      }
    },
    review: {
      status: "approved",
      reasons: []
    },
    recipe: {
      ...artifact.recipe,
      review_status: "approved"
    }
  });

  const reviewReasons = evaluateReviewReasons(nextArtifact.recipe, ownSection.markdown);
  nextArtifact = stagedRecipeSchema.parse({
    ...nextArtifact,
    review: {
      status: reviewReasons.length > 0 ? "needs_review" : "approved",
      reasons: reviewReasons
    },
    recipe: {
      ...nextArtifact.recipe,
      review_status: reviewReasons.length > 0 ? "needs_review" : "approved"
    }
  });

  if (nextArtifact.review.status !== "approved" && artifact.publication.is_published && artifact.publication.published_slug) {
    const previousPublishedSlug = artifact.publication.published_slug;
    await removePublishedRecipe(previousPublishedSlug, config);
    nextArtifact = markArtifactUnpublished(nextArtifact);
    console.log(`Unpublished recipe: ${previousPublishedSlug}`);
  }

  await persistArtifact(nextArtifact);
  return nextArtifact;
}

async function ensureUniqueSlugForArtifact(baseSlug: string, artifactId: string): Promise<string> {
  const publishedSlugPath = (slug: string) => path.join(config.projectRoot, "src/content/recipes", `${slug}.md`);
  const stagedArtifactPaths = await listJsonFiles(config.stagingDir);
  const reviewArtifactPaths = await listJsonFiles(config.reviewDir);
  const reservedSlugs = new Set<string>();

  for (const filePath of [...stagedArtifactPaths, ...reviewArtifactPaths]) {
    const artifact = await readStagedRecipe(filePath);
    if (artifact.id !== artifactId) {
      reservedSlugs.add(artifact.slug);
    }
  }

  let candidate = baseSlug;
  let counter = 2;
  while (reservedSlugs.has(candidate) || (await fileExists(publishedSlugPath(candidate)))) {
    candidate = `${baseSlug}-${counter}`;
    counter += 1;
  }

  return candidate;
}

function normalizeLookupValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildManualSplitDraft(
  sourceArtifact: StagedRecipe,
  section: ReturnType<typeof detectRecipeSections>[number]
) {
  const detailLines = section.markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(1);

  return extractedRecipeSchema.parse({
    title: section.title,
    summary: "",
    ingredients: detailLines.length > 0 ? detailLines : ["Manual review required from OCR section."],
    instructions: ["Manual review required before approval."],
    notes: [
      `Created as a manual split draft from ${sourceArtifact.id}.`,
      "Update ingredients and instructions from the OCR text before approval."
    ],
    source_name: sourceArtifact.recipe.source_name || config.defaultSourceName,
    source_family: sourceArtifact.recipe.source_family || config.defaultSourceFamily,
    course: "other",
    proteins: [],
    cuisine: sourceArtifact.recipe.cuisine || "unknown",
    dessert: false,
    tags: [],
    card_type: sourceArtifact.recipe.card_type,
    ocr_confidence: "low"
  });
}

function rebuildArtifactFromExtraction(
  artifact: StagedRecipe,
  extraction: Awaited<ReturnType<typeof extractRecipeFromSourceFiles>>
): StagedRecipe {
  const normalized = normalizeRecipeDraft(
    artifact.id,
    extractedRecipeSchema.parse(extraction.recipe),
    [],
    config.defaultSourceName,
    config.defaultSourceFamily
  );

  normalized.slug = artifact.slug;
  const reviewReasons = evaluateReviewReasons(normalized, extraction.markdown);
  normalized.review_status = reviewReasons.length > 0 ? "needs_review" : "approved";

  return stagedRecipeSchema.parse({
    ...artifact,
    ocr: {
      provider: extraction.provider,
      markdown: extraction.markdown,
      raw_response: extraction.rawResponse,
      fallback_used: extraction.fallbackUsed
    },
    recipe: {
      ...normalized,
      id: artifact.id,
      slug: artifact.slug
    },
    review: {
      status: normalized.review_status,
      reasons: reviewReasons
    }
  });
}

function isDerivedArtifactOcr(rawResponse: unknown): boolean {
  if (!rawResponse || typeof rawResponse !== "object") {
    return false;
  }

  return "derived_from_artifact_id" in rawResponse || "trimmed_from_artifact_id" in rawResponse;
}

function formatArtifactSummary(artifact: StagedRecipe, includeOcr: boolean): string {
  const publicationStatus = artifact.publication.is_published
    ? isArtifactPublishCurrent(artifact)
      ? "current"
      : "stale"
    : "unpublished";
  const lines = [
    `ID: ${artifact.id}`,
    `Title: ${artifact.recipe.title}`,
    `Slug: ${artifact.slug}`,
    `Review status: ${artifact.review.status}`,
    `Publication status: ${publicationStatus}`,
    `Published slug: ${artifact.publication.published_slug || "none"}`,
    `Published hash: ${artifact.publication.published_hash || "none"}`,
    `Current hash: ${computePublicationHash(artifact)}`,
    `OCR provider: ${artifact.ocr.provider}${artifact.ocr.fallback_used ? " (fallback used)" : ""}`,
    `Source file: ${artifact.source.input_path}`,
    `Related source files: ${artifact.source.related_input_paths.join(" | ") || "none"}`,
    `Course: ${artifact.recipe.course}`,
    `Cuisine: ${artifact.recipe.cuisine}`,
    `Dessert: ${artifact.recipe.dessert ? "yes" : "no"}`,
    `Proteins: ${artifact.recipe.proteins.join(", ") || "none"}`,
    `Tags: ${artifact.recipe.tags.join(", ") || "none"}`,
    `Notes: ${artifact.recipe.notes.length ? artifact.recipe.notes.join(" | ") : "none"}`,
    "",
    "Ingredients:",
    ...artifact.recipe.ingredients.map((ingredient) => `- ${ingredient}`),
    "",
    "Instructions:",
    ...artifact.recipe.instructions.map((instruction, index) => `${index + 1}. ${instruction}`)
  ];

  if (artifact.review.reasons.length > 0) {
    lines.push("", "Review reasons:", ...artifact.review.reasons.map((reason) => `- ${reason}`));
  }

  if (includeOcr) {
    lines.push("", "OCR markdown:", artifact.ocr.markdown);
  }

  return lines.join("\n");
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
