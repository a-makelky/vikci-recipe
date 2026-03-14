import assert from "node:assert/strict";
import test from "node:test";

import { decideExistingArtifactAction } from "../scripts/lib/ingest";
import { computePublicationHash } from "../scripts/lib/publish";
import type { StagedRecipe } from "../src/lib/recipe-schema";

function createArtifact(overrides: Partial<StagedRecipe> = {}): StagedRecipe {
  const base: StagedRecipe = {
    version: 1,
    id: "recipe-0001-abcd1234",
    slug: "sausage-souffle",
    source: {
      input_path: "/tmp/vicki/batch-01/recipe-0001-front.jpg",
      related_input_paths: [],
      file_name: "recipe-0001-front.jpg",
      mime_type: "image/jpeg",
      ingested_at: "2026-03-14T00:00:00.000Z"
    },
    ocr: {
      provider: "zai-vision",
      markdown: "OCR",
      raw_response: {},
      fallback_used: false
    },
    recipe: {
      id: "recipe-0001-abcd1234",
      slug: "sausage-souffle",
      title: "Sausage Souffle",
      summary: "",
      ingredients: ["1 lb sausage"],
      instructions: ["Bake"],
      notes: [],
      source_name: "Vicki",
      source_family: "Makelky",
      course: "breakfast",
      proteins: ["sausage"],
      cuisine: "american",
      dessert: false,
      tags: [],
      card_type: "handwritten",
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
      ...(overrides.source ?? {})
    },
    ocr: {
      ...base.ocr,
      ...(overrides.ocr ?? {})
    },
    recipe: {
      ...base.recipe,
      ...(overrides.recipe ?? {})
    },
    review: {
      ...base.review,
      ...(overrides.review ?? {})
    },
    publication: {
      ...base.publication,
      ...(overrides.publication ?? {})
    }
  };
}

test("decideExistingArtifactAction skips review artifacts by default", () => {
  const decision = decideExistingArtifactAction(
    createArtifact({
      recipe: {
        id: "recipe-0001-abcd1234",
        slug: "sausage-souffle",
        title: "Sausage Souffle",
        summary: "",
        ingredients: ["1 lb sausage"],
        instructions: ["Bake"],
        notes: [],
        source_name: "Vicki",
        source_family: "Makelky",
        course: "breakfast",
        proteins: ["sausage"],
        cuisine: "american",
        dessert: false,
        tags: [],
        card_type: "handwritten",
        ocr_confidence: "low",
        review_status: "needs_review",
        scan_assets: []
      },
      review: {
        status: "needs_review",
        reasons: ["Low confidence."]
      }
    }),
    false
  );

  assert.equal(decision.skip, true);
  assert.match(decision.reason, /review queue/i);
});

test("decideExistingArtifactAction skips current published artifacts by default", () => {
  const baseArtifact = createArtifact();
  const artifact = createArtifact({
    publication: {
      is_published: true,
      published_slug: "sausage-souffle",
      published_at: "2026-03-14T00:00:00.000Z",
      published_hash: computePublicationHash(baseArtifact)
    }
  });
  const decision = decideExistingArtifactAction(artifact, false);

  assert.equal(decision.skip, true);
  assert.match(decision.reason, /published and current/i);
});

test("decideExistingArtifactAction allows explicit reprocessing", () => {
  const decision = decideExistingArtifactAction(createArtifact(), true);

  assert.equal(decision.skip, false);
  assert.match(decision.reason, /reprocessing requested/i);
});
