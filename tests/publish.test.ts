import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuntimeConfig } from "../scripts/lib/environment";
import {
  computePublicationHash,
  isArtifactPublishCurrent,
  markArtifactPublished,
  markArtifactUnpublished,
  removePublishedRecipe
} from "../scripts/lib/publish";
import type { StagedRecipe } from "../src/lib/recipe-schema";

function createArtifact(): StagedRecipe {
  return {
    version: 1,
    id: "batch-01-recipe-0001-abcd1234",
    slug: "fudgy-brownies",
    source: {
      input_path: "/tmp/vicki/batch-01/recipe-0001.pdf",
      file_name: "recipe-0001.pdf",
      mime_type: "application/pdf",
      ingested_at: "2026-03-13T00:00:00.000Z"
    },
    ocr: {
      provider: "glm-ocr",
      markdown: "OCR body",
      raw_response: {},
      fallback_used: false
    },
    recipe: {
      id: "batch-01-recipe-0001-abcd1234",
      slug: "fudgy-brownies",
      title: "Fudgy Brownies",
      summary: "Chocolate brownies.",
      ingredients: ["1 cup sugar", "2 eggs"],
      instructions: ["Mix", "Bake"],
      notes: ["Use butter"],
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
}

function createConfig(projectRoot: string): RuntimeConfig {
  return {
    projectRoot,
    rawScanDir: undefined,
    stagingDir: path.join(projectRoot, "data/staging/artifacts"),
    reviewDir: path.join(projectRoot, "data/staging/review"),
    publishedScanDir: path.join(projectRoot, "public/scans"),
    zaiApiKey: undefined,
    zaiBaseUrl: "https://api.z.ai/api/paas/v4",
    zaiStructuringModel: "glm-4.7-flash",
    zaiOcrModel: "glm-ocr",
    googleCloudProject: undefined,
    googleCloudLocation: "us",
    googleCredentialsPath: undefined,
    defaultSourceName: "Vicki",
    defaultSourceFamily: "Makelky"
  };
}

test("markArtifactPublished and markArtifactUnpublished update publication state", () => {
  const artifact = createArtifact();
  const published = markArtifactPublished(artifact);
  assert.equal(published.publication.is_published, true);
  assert.equal(published.publication.published_slug, "fudgy-brownies");
  assert.ok(published.publication.published_at);
  assert.equal(published.publication.published_hash, computePublicationHash(artifact));
  assert.equal(isArtifactPublishCurrent(published), true);

  const unpublished = markArtifactUnpublished(published);
  assert.equal(unpublished.publication.is_published, false);
  assert.equal(unpublished.publication.published_slug, undefined);
  assert.equal(isArtifactPublishCurrent(unpublished), false);
});

test("isArtifactPublishCurrent detects drift after approved artifact changes", () => {
  const artifact = createArtifact();
  const published = markArtifactPublished(artifact);
  const drifted = {
    ...published,
    recipe: {
      ...published.recipe,
      ingredients: [...published.recipe.ingredients, "1 tsp vanilla"]
    }
  };

  assert.equal(isArtifactPublishCurrent(drifted), false);
});

test("removePublishedRecipe removes both markdown and scan assets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vicki-publish-test-"));
  const config = createConfig(root);
  const recipePath = path.join(root, "src/content/recipes/fudgy-brownies.md");
  const scanDir = path.join(root, "public/scans/fudgy-brownies");
  await mkdir(path.dirname(recipePath), { recursive: true });
  await mkdir(scanDir, { recursive: true });
  await writeFile(recipePath, "recipe");
  await writeFile(path.join(scanDir, "original.pdf"), "pdf");

  await removePublishedRecipe("fudgy-brownies", config);

  await assert.rejects(() => readFile(recipePath));
  await assert.rejects(() => readFile(path.join(scanDir, "original.pdf")));
});
