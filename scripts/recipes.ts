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
  createSlugFromTitle,
  deriveRecipeId,
  ensureUniqueSlug,
  publishArtifact,
  writeStageArtifact
} from "./lib/publish";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = resolveRuntimeConfig(projectRoot);

const helpText = `
Usage:
  npm run recipes -- ingest --input /path/to/scans [--stage-only] [--with-google-fallback] [--report ./path/to/report.json]
  npm run recipes -- review
  npm run recipes -- show --id recipe-0001
  npm run recipes -- status
  npm run recipes -- approve --id recipe-0001
  npm run recipes -- publish --id recipe-0001

Commands:
  ingest   OCR one file or a directory of scans, stage artifacts, and publish approved entries.
  review   List staged recipes that still need manual review.
  show     Print a staged artifact with recipe fields and an OCR preview for manual review.
  status   Show repository counts for approved recipes, staged artifacts, and review queue items.
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
    case "status":
      await statusCommand();
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

      const artifact = stagedRecipeSchema.parse({
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
        }
      });

      const artifactPath = await writeStageArtifact(artifact, config.stagingDir);
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
        const published = await publishArtifact(artifact, config);
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

async function statusCommand() {
  const approvedRecipes = await listRecipeMarkdownFiles(path.join(config.projectRoot, "src/content/recipes"));
  const stagedArtifacts = await listJsonFiles(config.stagingDir);
  const reviewArtifacts = await listJsonFiles(config.reviewDir);
  const publicScanEntries = await readdir(config.publishedScanDir, { withFileTypes: true }).catch(() => []);
  const publishedScanSets = publicScanEntries.filter((entry) => entry.isDirectory()).length;

  console.log([
    "Recipe archive status",
    `- Approved recipes: ${approvedRecipes.length}`,
    `- Staged artifacts: ${stagedArtifacts.length}`,
    `- Review queue: ${reviewArtifacts.length}`,
    `- Published scan sets: ${publishedScanSets}`
  ].join("\n"));
}

async function approveCommand(args: string[], publishAfterApproval: boolean) {
  const artifact = await resolveArtifactFromArgs(args);
  artifact.review.status = "approved";
  artifact.review.reasons = [];
  artifact.recipe.review_status = "approved";

  await writeStageArtifact(artifact, config.stagingDir);
  const reviewCopy = path.join(config.reviewDir, `${artifact.id}.json`);
  if (await fileExists(reviewCopy)) {
    await unlink(reviewCopy);
  }

  console.log(`Approved ${artifact.id}`);
  if (publishAfterApproval) {
    const published = await publishArtifact(artifact, config);
    console.log(`Published recipe: ${published.recipePath}`);
  }
}

async function publishCommand(args: string[]) {
  const artifact = await resolveArtifactFromArgs(args);
  if (artifact.review.status !== "approved") {
    throw new Error(`Cannot publish ${artifact.id} because it is still marked ${artifact.review.status}.`);
  }

  const published = await publishArtifact(artifact, config);
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
  const lines = [
    `ID: ${artifact.id}`,
    `Title: ${artifact.recipe.title}`,
    `Slug: ${artifact.slug}`,
    `Review status: ${artifact.review.status}`,
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
