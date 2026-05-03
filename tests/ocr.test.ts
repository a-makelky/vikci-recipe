import assert from "node:assert/strict";
import test from "node:test";

import { extractedRecipeSchema } from "../src/lib/recipe-schema";
import { detectRecipeSections, extractVisionMarkdown, parseStructuredRecipeResponse } from "../scripts/lib/ocr";

test("extractVisionMarkdown keeps plain OCR text unchanged", () => {
  const text = "Pasta Primavera\n1 can soup\n1/2 cup milk";
  assert.equal(extractVisionMarkdown(text), text);
});

test("extractVisionMarkdown strips fenced commentary wrapper from vision output", () => {
  const content = `
**Extracted Text**
\`\`\`
Serves
Here's what's cookin'
Pasta Primavera
1 can soup
\`\`\`

**Content Type**
Recipe card
`.trim();

  assert.equal(
    extractVisionMarkdown(content),
    ["Serves", "Here's what's cookin'", "Pasta Primavera", "1 can soup"].join("\n")
  );
});

test("extractVisionMarkdown strips trailing analysis headings from plain extracted text sections", () => {
  const content = `
**Extracted Text**
Here's what's cookin': Cabbage Casserole
Recipe from the kitchen of: Mom
Serves: 4

**Content Type**
Two handwritten recipe cards
`.trim();

  assert.equal(
    extractVisionMarkdown(content),
    ["Here's what's cookin': Cabbage Casserole", "Recipe from the kitchen of: Mom", "Serves: 4"].join("\n")
  );
});

test("detectRecipeSections groups multi-recipe OCR into titled sections", () => {
  const sections = detectRecipeSections([
    "Cabbage Casserole",
    "1/2 head cabbage",
    "1 lb hamburger",
    "",
    "Barbecued Hamburgers",
    "1 lb hamburger",
    "1 cup ketchup"
  ].join("\n"));

  assert.equal(sections.length, 2);
  assert.equal(sections[0]?.title, "Cabbage Casserole");
  assert.equal(sections[1]?.title, "Barbecued Hamburgers");
  assert.match(sections[1]?.markdown || "", /1 cup ketchup/);
});

test("detectRecipeSections ignores metadata and ingredient continuations from OCR", () => {
  const sections = detectRecipeSections([
    "White Queso Dip",
    "Prep Time",
    "Total Time",
    "1 cup milk",
    "4 teaspoons French's",
    "Worcestershire Sauce",
    "SWISS CHEESE",
    "GREEN ONION",
    "Mix until smooth."
  ].join("\n"));

  assert.deepEqual(sections.map((section) => section.title), ["White Queso Dip"]);
});

test("detectRecipeSections keeps real second recipe headings", () => {
  const sections = detectRecipeSections([
    "Here's what's cookin: Chip Dip",
    "1 pkg cream cheese",
    "2 tbsp mayonnaise",
    "ANOTHER DIP",
    "1 8oz cream cheese",
    "1 pkg onion soup mix"
  ].join("\n"));

  assert.equal(sections.length, 2);
  assert.equal(sections[1]?.title, "ANOTHER DIP");
});

test("detectRecipeSections treats a leading source name as context, not a recipe", () => {
  const sections = detectRecipeSections([
    "Fern Garrick",
    "Taco Dip",
    "Spread bean dip in bottom of pan."
  ].join("\n"));

  assert.deepEqual(sections.map((section) => section.title), ["Taco Dip"]);
});

test("extractedRecipeSchema normalizes unknown card types to mixed", () => {
  const parsed = extractedRecipeSchema.parse({
    title: "Shrimp Dip",
    ingredients: ["1 pkg cream cheese"],
    instructions: ["Mix and chill."],
    source_name: "Unknown",
    source_family: "Unknown",
    card_type: "Unknown",
    ocr_confidence: "medium"
  });

  assert.equal(parsed.card_type, "mixed");
});

test("parseStructuredRecipeResponse preserves incomplete extractions as low-confidence review drafts", () => {
  const parsed = parseStructuredRecipeResponse(
    JSON.stringify({
      title: "",
      ingredients: [],
      instructions: [],
      card_type: "other"
    }),
    ["Cheese Ball", "2 cups cheddar", "Mix with cream cheese."].join("\n"),
    "/tmp/IMG_0001.JPG"
  );

  assert.equal(parsed.title, "Cheese Ball");
  assert.equal(parsed.card_type, "mixed");
  assert.equal(parsed.ocr_confidence, "low");
  assert.match(parsed.instructions.join(" "), /Manual review required/);
});
