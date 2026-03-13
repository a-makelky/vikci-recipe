import { z } from "zod";

export const COURSE_VALUES = [
  "appetizer",
  "beverage",
  "bread",
  "breakfast",
  "dessert",
  "main",
  "salad",
  "side",
  "snack",
  "soup",
  "other"
] as const;

export const PROTEIN_VALUES = [
  "beef",
  "bacon",
  "chicken",
  "fish",
  "ham",
  "pork",
  "sausage",
  "seafood",
  "turkey",
  "vegetarian",
  "other"
] as const;

export const CARD_TYPE_VALUES = ["handwritten", "printed", "mixed"] as const;
export const OCR_CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
export const REVIEW_STATUS_VALUES = ["approved", "needs_review"] as const;

export const scanAssetSchema = z.object({
  path: z.string(),
  label: z.string(),
  type: z.enum(["image", "pdf"]),
  role: z.enum(["preview", "original"]).default("original")
});

export const recipeDataSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().default(""),
  ingredients: z.array(z.string().min(1)).min(1),
  instructions: z.array(z.string().min(1)).min(1),
  notes: z.array(z.string().min(1)).default([]),
  source_name: z.string().min(1),
  source_family: z.string().min(1),
  course: z.enum(COURSE_VALUES),
  proteins: z.array(z.enum(PROTEIN_VALUES)).default([]),
  cuisine: z.string().min(1),
  dessert: z.boolean().default(false),
  tags: z.array(z.string().min(1)).default([]),
  card_type: z.enum(CARD_TYPE_VALUES),
  ocr_confidence: z.enum(OCR_CONFIDENCE_VALUES),
  review_status: z.enum(REVIEW_STATUS_VALUES),
  scan_assets: z.array(scanAssetSchema).default([])
});

export const recipeFrontmatterSchema = recipeDataSchema;
export const recipeRecordSchema = recipeDataSchema.extend({
  slug: z.string().min(1)
});

export const extractedRecipeSchema = z.object({
  title: z.string().min(1),
  summary: z.string().default(""),
  ingredients: z.array(z.string().min(1)).min(1),
  instructions: z.array(z.string().min(1)).min(1),
  notes: z.array(z.string().min(1)).default([]),
  source_name: z.string().default("Unknown"),
  source_family: z.string().default("Unknown"),
  course: z.enum(COURSE_VALUES).default("other"),
  proteins: z.array(z.enum(PROTEIN_VALUES)).default([]),
  cuisine: z.string().default("unknown"),
  dessert: z.boolean().default(false),
  tags: z.array(z.string().min(1)).default([]),
  card_type: z.enum(CARD_TYPE_VALUES).default("mixed"),
  ocr_confidence: z.enum(OCR_CONFIDENCE_VALUES).default("medium")
});

export const stagedRecipeSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  slug: z.string(),
  source: z.object({
    input_path: z.string(),
    file_name: z.string(),
    mime_type: z.string(),
    ingested_at: z.string()
  }),
  ocr: z.object({
    provider: z.enum(["glm-ocr", "google-vision"]),
    markdown: z.string(),
    raw_response: z.unknown(),
    fallback_used: z.boolean().default(false)
  }),
  recipe: extractedRecipeSchema.extend({
    id: z.string(),
    slug: z.string(),
    review_status: z.enum(REVIEW_STATUS_VALUES),
    scan_assets: z.array(scanAssetSchema).default([])
  }),
  review: z.object({
    status: z.enum(REVIEW_STATUS_VALUES),
    reasons: z.array(z.string()).default([])
  })
});

export type ScanAsset = z.infer<typeof scanAssetSchema>;
export type RecipeFrontmatter = z.infer<typeof recipeFrontmatterSchema>;
export type RecipeRecord = z.infer<typeof recipeRecordSchema>;
export type ExtractedRecipe = z.infer<typeof extractedRecipeSchema>;
export type StagedRecipe = z.infer<typeof stagedRecipeSchema>;
