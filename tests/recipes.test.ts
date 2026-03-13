import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRecipeDraft, slugify } from "../src/lib/recipes";
import { evaluateReviewReasons } from "../scripts/lib/ocr";

test("slugify normalizes recipe titles", () => {
  assert.equal(slugify("Grandma's Sauerkraut Balls!"), "grandma-s-sauerkraut-balls");
});

test("normalizeRecipeDraft applies defaults and keeps scan assets", () => {
  const recipe = normalizeRecipeDraft(
    "recipe-0001",
    {
      title: "Chicken Noodle Bake",
      summary: "",
      ingredients: ["2 cups noodles", "1 can cream soup", "2 cups noodles"],
      instructions: ["Mix everything.", "Bake until hot."],
      notes: ["Family favorite"],
      source_name: "",
      source_family: "",
      course: "main",
      proteins: ["chicken"],
      cuisine: "american",
      dessert: false,
      tags: ["weeknight", "weeknight"],
      card_type: "mixed",
      ocr_confidence: "medium"
    },
    [{ path: "/scans/chicken/original.pdf", label: "Original scan", role: "original", type: "pdf" }],
    "Vicki",
    "Makelky"
  );

  assert.equal(recipe.slug, "chicken-noodle-bake");
  assert.equal(recipe.source_name, "Vicki");
  assert.deepEqual(recipe.ingredients, ["2 cups noodles", "1 can cream soup"]);
  assert.deepEqual(recipe.tags, ["weeknight"]);
  assert.equal(recipe.scan_assets.length, 1);
});

test("evaluateReviewReasons flags thin OCR output", () => {
  const reasons = evaluateReviewReasons(
    {
      title: "Pie",
      summary: "",
      ingredients: ["crust"],
      instructions: ["Bake."],
      notes: [],
      source_name: "Unknown",
      source_family: "Unknown",
      course: "dessert",
      proteins: [],
      cuisine: "american",
      dessert: true,
      tags: [],
      card_type: "handwritten",
      ocr_confidence: "low"
    },
    "short"
  );

  assert.ok(reasons.length >= 3);
});
