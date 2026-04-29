import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuntimeConfig } from "../scripts/lib/environment";
import { writeJson, writeRecipeMarkdown } from "../scripts/lib/io";
import { markArtifactPublished } from "../scripts/lib/publish";
import { verifyArchive } from "../scripts/lib/verify";
import type { RecipeFrontmatter, StagedRecipe } from "../src/lib/recipe-schema";

function createConfig(projectRoot: string): RuntimeConfig {
  return {
    projectRoot,
    rawScanDir: undefined,
    stagingDir: path.join(projectRoot, "data/staging/artifacts"),
    reviewDir: path.join(projectRoot, "data/staging/review"),
    publishedScanDir: path.join(projectRoot, "public/scans"),
    zaiApiKey: undefined,
    zaiBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    zaiVisionModel: "glm-4.6v",
    zaiStructuringModel: "glm-4.7-flash",
    zaiOcrModel: "glm-ocr",
    googleCloudProject: undefined,
    googleCloudLocation: "us",
    googleCredentialsPath: undefined,
    defaultSourceName: "Vicki",
    defaultSourceFamily: "Makelky"
  };
}

function createRecipe(): RecipeFrontmatter {
  return {
    id: "batch-01-recipe-0001-abcd1234",
    title: "Fudgy Brownies",
    summary: "Chocolate brownies.",
    ingredients: ["1 cup sugar", "2 eggs", "1/2 cup cocoa"],
    instructions: ["Mix.", "Bake."],
    notes: [],
    source_name: "Vicki",
    source_family: "Makelky",
    course: "dessert",
    proteins: [],
    cuisine: "american",
    dessert: true,
    tags: ["chocolate"],
    card_type: "mixed",
    ocr_confidence: "medium",
    review_status: "approved",
    scan_assets: [
      {
        path: "/scans/fudgy-brownies/preview.jpg",
        label: "Preview",
        type: "image",
        role: "preview"
      }
    ]
  };
}

function createArtifact(sourcePath: string): StagedRecipe {
  const recipe = createRecipe();
  const artifact: StagedRecipe = {
    version: 1,
    id: recipe.id,
    slug: "fudgy-brownies",
    source: {
      input_path: sourcePath,
      related_input_paths: [],
      file_name: path.basename(sourcePath),
      mime_type: "image/jpeg",
      ingested_at: "2026-03-13T00:00:00.000Z"
    },
    ocr: {
      provider: "zai-vision",
      markdown: "Fudgy Brownies\n1 cup sugar",
      raw_response: {},
      fallback_used: false
    },
    recipe: {
      ...recipe,
      slug: "fudgy-brownies",
      scan_assets: []
    },
    review: {
      status: "approved",
      reasons: []
    },
    publication: {
      is_published: false
    }
  };

  return markArtifactPublished(artifact);
}

test("verifyArchive passes when markdown, scan assets, and artifacts line up", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vicki-verify-pass-"));
  const config = createConfig(root);
  const sourcePath = path.join(root, "raw/recipe-0001.jpg");
  const recipePath = path.join(root, "src/content/recipes/fudgy-brownies.md");
  const assetPath = path.join(root, "public/scans/fudgy-brownies/preview.jpg");
  const artifactPath = path.join(config.stagingDir, `${createRecipe().id}.json`);

  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.dirname(assetPath), { recursive: true });
  await writeFile(sourcePath, "jpg");
  await writeFile(assetPath, "jpg");
  await writeRecipeMarkdown(recipePath, createRecipe());
  await writeJson(artifactPath, createArtifact(sourcePath));

  const summary = await verifyArchive(config);
  assert.equal(summary.passed, true);
  assert.equal(summary.counts.errors, 0);
  assert.equal(summary.counts.warnings, 0);
});

test("verifyArchive reports missing artifacts and missing scan assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vicki-verify-fail-"));
  const config = createConfig(root);
  const recipePath = path.join(root, "src/content/recipes/fudgy-brownies.md");
  await writeRecipeMarkdown(recipePath, createRecipe());

  const summary = await verifyArchive(config);
  assert.equal(summary.passed, false);
  assert.equal(summary.counts.errors, 1);
  assert.equal(summary.counts.warnings, 1);
  assert.deepEqual(summary.issues.map((issue) => issue.code).sort(), [
    "markdown_without_artifact",
    "missing_scan_asset"
  ]);
});
