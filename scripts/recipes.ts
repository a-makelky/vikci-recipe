import path from "node:path";
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
  readStagedRecipe
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
  npm run recipes -- ingest --input /path/to/scans [--stage-only] [--with-google-fallback]
  npm run recipes -- review
  npm run recipes -- approve --id recipe-0001
  npm run recipes -- publish --id recipe-0001

Commands:
  ingest   OCR one file or a directory of scans, stage artifacts, and publish approved entries.
  review   List staged recipes that still need manual review.
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
      "with-google-fallback": { type: "boolean", default: false }
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

  for (const filePath of files) {
    console.log(`\nProcessing ${filePath}`);
    try {
      const extraction = await extractRecipeFromFile(filePath, config, parsed.values["with-google-fallback"]);
      const id = deriveRecipeId(filePath);
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

      if (artifact.review.status === "needs_review") {
        await writeStageArtifact(artifact, config.reviewDir);
        console.log(`Needs review: ${artifact.review.reasons.join(" ")}`);
        continue;
      }

      if (!parsed.values["stage-only"]) {
        const published = await publishArtifact(artifact, config);
        console.log(`Published recipe: ${published.recipePath}`);
      }
    } catch (error) {
      console.error(`Failed to process ${filePath}: ${String(error)}`);
    }
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
    for (const reason of artifact.review.reasons) {
      console.log(`  - ${reason}`);
    }
  }
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

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
