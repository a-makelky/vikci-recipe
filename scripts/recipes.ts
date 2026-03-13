import path from "node:path";
import { readdir } from "node:fs/promises";
import { unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { StagedRecipe } from "../src/lib/recipe-schema";
import { extractedRecipeSchema, stagedRecipeSchema } from "../src/lib/recipe-schema";
import { normalizeRecipeDraft } from "../src/lib/recipes";
import { resolveRuntimeConfig } from "./lib/environment";
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
import { evaluateReviewReasons, extractRecipeFromFile } from "./lib/ocr";
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
import { applyArtifactPatch, parseBooleanInput, parseDelimitedList } from "./lib/review";
import { filterArtifactsByBatch, formatStatusSummary, summarizeArtifacts } from "./lib/status";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = resolveRuntimeConfig(projectRoot);

const helpText = `
Usage:
  npm run recipes -- ingest --input /path/to/scans [--stage-only] [--with-google-fallback] [--report ./path/to/report.json]
  npm run recipes -- review
  npm run recipes -- show --id recipe-0001
  npm run recipes -- update --id recipe-0001 [--title \"...\"] [--ingredients \"a|b|c\"] [--publish]
  npm run recipes -- republish-stale
  npm run recipes -- status [--batch batch-01] [--json]
  npm run recipes -- approve --id recipe-0001
  npm run recipes -- publish --id recipe-0001

Commands:
  ingest   OCR one file or a directory of scans, stage artifacts, and publish approved entries.
  review   List staged recipes that still need manual review.
  show     Print a staged artifact with recipe fields and an OCR preview for manual review.
  update   Patch a staged artifact's recipe fields without hand-editing the raw JSON.
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
    failed: 0,
    files: [] as Array<{
      file_path: string;
      id?: string;
      title?: string;
      status: "published" | "staged" | "needs_review" | "failed";
      artifact_path?: string;
      recipe_path?: string;
      message?: string;
    }>
  };

  for (const filePath of files) {
    console.log(`\nProcessing ${filePath}`);
    try {
      const extraction = await extractRecipeFromFile(filePath, config, parsed.values["with-google-fallback"]);
      const id = deriveRecipeId(filePath, idRoot);
      const existingArtifactPath = path.join(config.stagingDir, `${id}.json`);
      const existingArtifact = (await fileExists(existingArtifactPath)) ? await readStagedRecipe(existingArtifactPath) : null;
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
          input_path: filePath,
          file_name: path.basename(filePath),
          mime_type: inferMimeType(filePath),
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
          file_path: filePath,
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
          file_path: filePath,
          id: artifact.id,
          title: artifact.recipe.title,
          status: "published",
          artifact_path: artifactPath,
          recipe_path: published.recipePath
        });
      } else {
        report.staged_only += 1;
        report.files.push({
          file_path: filePath,
          id: artifact.id,
          title: artifact.recipe.title,
          status: "staged",
          artifact_path: artifactPath,
          message: "Staged only; publish skipped by flag."
        });
      }
    } catch (error) {
      console.error(`Failed to process ${filePath}: ${String(error)}`);
      report.processed += 1;
      report.failed += 1;
      report.files.push({
        file_path: filePath,
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
    allowPositionals: true
  });

  if (parsed.values.artifact) {
    return readStagedRecipe(path.resolve(parsed.values.artifact));
  }

  if (!parsed.values.id) {
    throw new Error("Pass --id recipe-0001 or --artifact /path/to/staged.json.");
  }

  const candidates = [
    path.join(config.stagingDir, `${parsed.values.id}.json`),
    path.join(config.reviewDir, `${parsed.values.id}.json`)
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return readStagedRecipe(candidate);
    }
  }

  throw new Error(`No artifact found for ${parsed.values.id}`);
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
