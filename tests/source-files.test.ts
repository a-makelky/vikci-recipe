import assert from "node:assert/strict";
import test from "node:test";

import { deriveRecipeId } from "../scripts/lib/publish";
import { groupPairedScanFiles } from "../scripts/lib/source-files";

test("groupPairedScanFiles merges front and back images into one source group", () => {
  const groups = groupPairedScanFiles([
    "/tmp/vicki/2026-03-batch-01/recipe-0002-back.jpg",
    "/tmp/vicki/2026-03-batch-01/recipe-0001-front.jpg",
    "/tmp/vicki/2026-03-batch-01/recipe-0002-front.jpg",
    "/tmp/vicki/2026-03-batch-01/recipe-0001-back.jpg",
    "/tmp/vicki/2026-03-batch-01/recipe-0003.jpg"
  ]);

  assert.deepEqual(groups, [
    {
      primaryPath: "/tmp/vicki/2026-03-batch-01/recipe-0001-front.jpg",
      filePaths: [
        "/tmp/vicki/2026-03-batch-01/recipe-0001-front.jpg",
        "/tmp/vicki/2026-03-batch-01/recipe-0001-back.jpg"
      ]
    },
    {
      primaryPath: "/tmp/vicki/2026-03-batch-01/recipe-0002-front.jpg",
      filePaths: [
        "/tmp/vicki/2026-03-batch-01/recipe-0002-front.jpg",
        "/tmp/vicki/2026-03-batch-01/recipe-0002-back.jpg"
      ]
    },
    {
      primaryPath: "/tmp/vicki/2026-03-batch-01/recipe-0003.jpg",
      filePaths: ["/tmp/vicki/2026-03-batch-01/recipe-0003.jpg"]
    }
  ]);
});

test("deriveRecipeId stays stable across front and back scan pairs", () => {
  const front = deriveRecipeId("/tmp/vicki/2026-03-batch-01/recipe-0001-front.jpg", "/tmp/vicki");
  const back = deriveRecipeId("/tmp/vicki/2026-03-batch-01/recipe-0001-back.jpg", "/tmp/vicki");

  assert.equal(front, back);
  assert.match(front, /^2026-03-batch-01-recipe-0001-[a-f0-9]{8}$/);
});
