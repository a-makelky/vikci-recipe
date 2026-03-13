import assert from "node:assert/strict";
import test from "node:test";

import { markArtifactPublished } from "../scripts/lib/publish";
import { deriveBatchKey, filterArtifactsByBatch, formatStatusSummary, summarizeArtifacts } from "../scripts/lib/status";
import type { StagedRecipe } from "../src/lib/recipe-schema";

type ArtifactOverrides = Partial<Omit<StagedRecipe, "source" | "ocr" | "recipe" | "review" | "publication">> & {
  source?: Partial<StagedRecipe["source"]>;
  ocr?: Partial<StagedRecipe["ocr"]>;
  recipe?: Partial<StagedRecipe["recipe"]>;
  review?: Partial<StagedRecipe["review"]>;
  publication?: Partial<StagedRecipe["publication"]>;
};

function createArtifact(
  id: string,
  inputPath: string,
  overrides: ArtifactOverrides = {}
): StagedRecipe {
  const base: StagedRecipe = {
    version: 1,
    id,
    slug: `${id}-slug`,
    source: {
      input_path: inputPath,
      file_name: inputPath.split("/").pop() ?? `${id}.pdf`,
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
      id,
      slug: `${id}-slug`,
      title: `Recipe ${id}`,
      summary: "",
      ingredients: ["1 cup sugar"],
      instructions: ["Mix."],
      notes: [],
      source_name: "Vicki",
      source_family: "Makelky",
      course: "dessert",
      proteins: [],
      cuisine: "american",
      dessert: true,
      tags: [],
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

  return {
    ...base,
    ...overrides,
    source: {
      ...base.source,
      ...overrides.source
    },
    ocr: {
      ...base.ocr,
      ...overrides.ocr
    },
    recipe: {
      ...base.recipe,
      ...overrides.recipe
    },
    review: {
      ...base.review,
      ...overrides.review
    },
    publication: {
      ...base.publication,
      ...overrides.publication
    }
  };
}

test("deriveBatchKey and filterArtifactsByBatch match batch names from scan paths", () => {
  const january = createArtifact("recipe-1", "/tmp/vicki/2026-03-batch-01/recipe-0001.pdf");
  const february = createArtifact("recipe-2", "/tmp/vicki/2026-04-batch-02/recipe-0001.pdf");

  assert.equal(deriveBatchKey(january.source.input_path), "2026-03-batch-01");
  assert.deepEqual(filterArtifactsByBatch([january, february], "batch-02").map((artifact) => artifact.id), ["recipe-2"]);
  assert.deepEqual(filterArtifactsByBatch([january, february], "2026-03-batch-01").map((artifact) => artifact.id), ["recipe-1"]);
});

test("summarizeArtifacts reports pilot metrics and stale publication drift", () => {
  const currentPublished = markArtifactPublished(
    createArtifact("recipe-1", "/tmp/vicki/batch-01/recipe-0001.pdf", {
      recipe: {
        card_type: "printed",
        ocr_confidence: "high"
      }
    })
  );
  const approvedUnpublished = createArtifact("recipe-2", "/tmp/vicki/batch-01/recipe-0002.pdf", {
    recipe: {
      card_type: "handwritten",
      ocr_confidence: "medium"
    }
  });
  const stalePublishedBase = markArtifactPublished(
    createArtifact("recipe-3", "/tmp/vicki/batch-01/recipe-0003.pdf", {
      recipe: {
        card_type: "mixed",
        ocr_confidence: "medium"
      }
    })
  );
  const stalePublished: StagedRecipe = {
    ...stalePublishedBase,
    recipe: {
      ...stalePublishedBase.recipe,
      ingredients: [...stalePublishedBase.recipe.ingredients, "1 tsp vanilla"]
    }
  };
  const needsReview = createArtifact("recipe-4", "/tmp/vicki/batch-02/recipe-0004.pdf", {
    recipe: {
      card_type: "handwritten",
      ocr_confidence: "low",
      review_status: "needs_review"
    },
    review: {
      status: "needs_review",
      reasons: ["OCR confidence is low.", "Instructions need manual cleanup."]
    }
  });

  const summary = summarizeArtifacts(
    [currentPublished, approvedUnpublished, stalePublished, needsReview],
    1,
    {
      approvedRecipesOnSite: 2,
      publishedScanSetsOnDisk: 2
    }
  );

  assert.equal(summary.scope.artifact_count, 4);
  assert.equal(summary.counts.approved_recipes_on_site, 2);
  assert.equal(summary.counts.published_scan_sets_on_disk, 2);
  assert.equal(summary.counts.approved_artifacts, 3);
  assert.equal(summary.counts.published_current, 1);
  assert.equal(summary.counts.approved_unpublished, 1);
  assert.equal(summary.counts.published_stale, 1);
  assert.equal(summary.counts.needs_review, 1);
  assert.equal(summary.counts.review_queue_copies, 1);
  assert.deepEqual(summary.breakdowns.ocr_confidence, {
    high: 1,
    medium: 2,
    low: 1
  });
  assert.deepEqual(summary.breakdowns.card_type, {
    handwritten: 2,
    mixed: 1,
    printed: 1
  });
  assert.deepEqual(summary.breakdowns.batches, {
    "batch-01": 3,
    "batch-02": 1
  });
  assert.deepEqual(summary.top_review_reasons, [
    { reason: "Instructions need manual cleanup.", count: 1 },
    { reason: "OCR confidence is low.", count: 1 }
  ]);

  const output = formatStatusSummary(summary);
  assert.match(output, /Published current: 1/);
  assert.match(output, /Published stale: 1/);
  assert.match(output, /OCR confidence: high 1, low 1, medium 2/);
});
