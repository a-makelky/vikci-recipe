import { createHash } from "node:crypto";

import type { StagedRecipe } from "../../src/lib/recipe-schema";
import { stagedRecipeSchema } from "../../src/lib/recipe-schema";
import { slugify, uniqueStrings } from "../../src/lib/recipes";

export interface ArtifactPatchInput {
  title?: string;
  summary?: string;
  source_name?: string;
  source_family?: string;
  course?: StagedRecipe["recipe"]["course"];
  cuisine?: string;
  card_type?: StagedRecipe["recipe"]["card_type"];
  ocr_confidence?: StagedRecipe["recipe"]["ocr_confidence"];
  dessert?: boolean;
  ingredients?: string[];
  instructions?: string[];
  notes?: string[];
  tags?: string[];
  proteins?: StagedRecipe["recipe"]["proteins"];
  slug?: string;
  review_status?: StagedRecipe["review"]["status"];
  review_reasons?: string[];
}

export function parseDelimitedList(
  value: string | undefined,
  delimiterPattern = /[|,]/g
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  return uniqueStrings(trimmed.split(delimiterPattern));
}

export function parseBooleanInput(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "0"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected boolean value like true/false, yes/no, or 1/0. Received "${value}".`);
}

export function deriveSplitArtifactId(sourceId: string, title: string): string {
  const slug = slugify(title) || "split";
  const digest = createHash("sha1").update(`${sourceId}:${slug}`).digest("hex").slice(0, 8);
  return `${sourceId}-${slug}-${digest}`;
}

export function applyArtifactPatch(artifact: StagedRecipe, patch: ArtifactPatchInput): StagedRecipe {
  const next = structuredClone(artifact);

  if (patch.title !== undefined) {
    next.recipe.title = patch.title.trim();
  }
  if (patch.summary !== undefined) {
    next.recipe.summary = patch.summary.trim();
  }
  if (patch.source_name !== undefined) {
    next.recipe.source_name = patch.source_name.trim();
  }
  if (patch.source_family !== undefined) {
    next.recipe.source_family = patch.source_family.trim();
  }
  if (patch.course !== undefined) {
    next.recipe.course = patch.course;
  }
  if (patch.cuisine !== undefined) {
    next.recipe.cuisine = patch.cuisine.trim();
  }
  if (patch.card_type !== undefined) {
    next.recipe.card_type = patch.card_type;
  }
  if (patch.ocr_confidence !== undefined) {
    next.recipe.ocr_confidence = patch.ocr_confidence;
  }
  if (patch.dessert !== undefined) {
    next.recipe.dessert = patch.dessert;
  }
  if (patch.ingredients !== undefined) {
    next.recipe.ingredients = uniqueStrings(patch.ingredients);
  }
  if (patch.instructions !== undefined) {
    next.recipe.instructions = uniqueStrings(patch.instructions);
  }
  if (patch.notes !== undefined) {
    next.recipe.notes = uniqueStrings(patch.notes);
  }
  if (patch.tags !== undefined) {
    next.recipe.tags = uniqueStrings(patch.tags).map((tag) => tag.toLowerCase());
  }
  if (patch.proteins !== undefined) {
    next.recipe.proteins = uniqueStrings(patch.proteins) as StagedRecipe["recipe"]["proteins"];
  }
  if (patch.slug !== undefined) {
    const slug = slugify(patch.slug) || next.id;
    next.slug = slug;
    next.recipe.slug = slug;
  }
  if (patch.review_status !== undefined) {
    next.review.status = patch.review_status;
    next.recipe.review_status = patch.review_status;
  }
  if (patch.review_reasons !== undefined) {
    next.review.reasons = uniqueStrings(patch.review_reasons);
  } else if (patch.review_status === "approved") {
    next.review.reasons = [];
  }

  if (next.review.status === "needs_review" && next.review.reasons.length === 0) {
    next.review.reasons = ["Marked for manual review."];
  }

  return stagedRecipeSchema.parse(next);
}
