import type { ExtractedRecipe, RecipeFrontmatter, RecipeRecord, ScanAsset } from "./recipe-schema";

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function normalizeRecipeDraft(
  id: string,
  draft: ExtractedRecipe,
  scanAssets: ScanAsset[],
  defaultSourceName: string,
  defaultSourceFamily: string
): RecipeRecord {
  const slug = slugify(draft.title) || id;
  return {
    id,
    slug,
    title: draft.title.trim(),
    summary: draft.summary.trim(),
    ingredients: uniqueStrings(draft.ingredients),
    instructions: uniqueStrings(draft.instructions),
    notes: uniqueStrings(draft.notes),
    source_name: draft.source_name.trim() || defaultSourceName,
    source_family: draft.source_family.trim() || defaultSourceFamily,
    course: draft.course,
    proteins: uniqueStrings(draft.proteins) as RecipeFrontmatter["proteins"],
    cuisine: draft.cuisine.trim() || "unknown",
    dessert: draft.dessert,
    tags: uniqueStrings(draft.tags).map((tag) => tag.toLowerCase()),
    card_type: draft.card_type,
    ocr_confidence: draft.ocr_confidence,
    review_status: draft.ocr_confidence === "low" ? "needs_review" : "approved",
    scan_assets: scanAssets
  };
}

export function buildSearchText(recipe: Pick<RecipeFrontmatter, "title" | "summary" | "ingredients" | "instructions" | "notes" | "tags" | "source_name" | "source_family" | "cuisine">): string {
  return [
    recipe.title,
    recipe.summary,
    recipe.ingredients.join(" "),
    recipe.instructions.join(" "),
    recipe.notes.join(" "),
    recipe.tags.join(" "),
    recipe.source_name,
    recipe.source_family,
    recipe.cuisine
  ]
    .join(" ")
    .toLowerCase();
}
