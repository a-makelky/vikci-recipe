import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRecipeDraft, slugify } from "../src/lib/recipes";
import { evaluateReviewReasons } from "../scripts/lib/ocr";
import { deriveRecipeId } from "../scripts/lib/publish";

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

test("evaluateReviewReasons flags OCR that appears to contain multiple recipes", () => {
  const reasons = evaluateReviewReasons(
    {
      title: "Cabbage Casserole",
      summary: "",
      ingredients: ["1 cabbage", "1 lb hamburger", "1 can tomato soup"],
      instructions: ["Layer ingredients.", "Bake until tender."],
      notes: [],
      source_name: "Mom",
      source_family: "Unknown",
      course: "main",
      proteins: ["beef"],
      cuisine: "american",
      dessert: false,
      tags: [],
      card_type: "mixed",
      ocr_confidence: "medium"
    },
    [
      "Cabbage Casserole",
      "Sliced Cabbage (1/2 head)",
      "",
      "Barbecued Hamburgers",
      "1 lb hamburger"
    ].join("\n")
  );

  assert.match(reasons.join(" "), /more than one recipe title/i);
  assert.match(reasons.join(" "), /Barbecued Hamburgers/);
});

test("evaluateReviewReasons ignores title fragments and source-name lines that overlap the extracted title", () => {
  const reasons = evaluateReviewReasons(
    {
      title: "Maggi Sampsel Sausage Souffle",
      summary: "",
      ingredients: ["1 lb sausage", "8 slices bread", "2 c. milk"],
      instructions: ["Fry sausage and drain.", "Bake until set."],
      notes: [],
      source_name: "Maggi",
      source_family: "Sampsel",
      course: "main",
      proteins: ["sausage"],
      cuisine: "american",
      dessert: false,
      tags: [],
      card_type: "handwritten",
      ocr_confidence: "medium"
    },
    [
      "Maggi",
      "Sampsel",
      "Sausage Souffle",
      "1 lb link sausage",
      "Bake @ 350°"
    ].join("\n")
  );

  assert.doesNotMatch(reasons.join(" "), /more than one recipe title/i);
});

test("deriveRecipeId stays stable within a batch root and avoids collisions across batches", () => {
  const january = deriveRecipeId(
    "/tmp/vicki/batch-01/recipe-0001.pdf",
    "/tmp/vicki"
  );
  const february = deriveRecipeId(
    "/tmp/vicki/batch-02/recipe-0001.pdf",
    "/tmp/vicki"
  );

  assert.match(january, /^batch-01-recipe-0001-[a-f0-9]{8}$/);
  assert.match(february, /^batch-02-recipe-0001-[a-f0-9]{8}$/);
  assert.notEqual(january, february);
});
