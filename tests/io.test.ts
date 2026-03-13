import assert from "node:assert/strict";
import test from "node:test";

import { serializeRecipeMarkdown } from "../scripts/lib/io";

test("serializeRecipeMarkdown writes frontmatter and body", () => {
  const output = serializeRecipeMarkdown(
    {
      id: "recipe-0002",
      title: "Kolache",
      summary: "",
      ingredients: ["2 cups flour"],
      instructions: ["Mix and bake."],
      notes: ["Use apricot jam."],
      source_name: "Vicki",
      source_family: "Makelky",
      course: "dessert",
      proteins: [],
      cuisine: "czech",
      dessert: true,
      tags: ["holiday"],
      card_type: "printed",
      ocr_confidence: "high",
      review_status: "approved",
      scan_assets: []
    },
    "Imported by test."
  );

  assert.match(output, /^---/);
  assert.match(output, /title: Kolache/);
  assert.match(output, /Imported by test\./);
});
