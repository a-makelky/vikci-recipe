import assert from "node:assert/strict";
import test from "node:test";

import { extractVisionMarkdown } from "../scripts/lib/ocr";

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
