import assert from "node:assert/strict";
import test from "node:test";

import type { StagedRecipe } from "../src/lib/recipe-schema";
import { applyArtifactPatch, parseBooleanInput, parseDelimitedList } from "../scripts/lib/review";

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
      review_status: "needs_review",
      scan_assets: []
    },
    review: {
      status: "needs_review",
      reasons: ["Needs ingredient cleanup."]
    },
    publication: {
      is_published: false
    }
  };
}

test("parseDelimitedList supports empty and trimmed inputs", () => {
  assert.deepEqual(parseDelimitedList("a| b |c", /\|/g), ["a", "b", "c"]);
  assert.deepEqual(parseDelimitedList("  "), []);
  assert.equal(parseDelimitedList(undefined), undefined);
});

test("parseBooleanInput accepts common yes/no forms", () => {
  assert.equal(parseBooleanInput("true"), true);
  assert.equal(parseBooleanInput("No"), false);
  assert.equal(parseBooleanInput(undefined), undefined);
});

test("applyArtifactPatch updates recipe fields and clears review reasons on approval", () => {
  const updated = applyArtifactPatch(createArtifact(), {
    title: "Brownies Deluxe",
    ingredients: ["1 cup sugar", "2 eggs", "1 tsp vanilla"],
    tags: ["Chocolate", "Freezer-Friendly"],
    review_status: "approved"
  });

  assert.equal(updated.recipe.title, "Brownies Deluxe");
  assert.deepEqual(updated.recipe.ingredients, ["1 cup sugar", "2 eggs", "1 tsp vanilla"]);
  assert.deepEqual(updated.recipe.tags, ["chocolate", "freezer-friendly"]);
  assert.equal(updated.review.status, "approved");
  assert.deepEqual(updated.review.reasons, []);
});

test("applyArtifactPatch keeps needs-review artifacts reviewable when reasons are empty", () => {
  const updated = applyArtifactPatch(createArtifact(), {
    review_reasons: [],
    review_status: "needs_review"
  });

  assert.equal(updated.review.status, "needs_review");
  assert.deepEqual(updated.review.reasons, ["Marked for manual review."]);
});
