import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import YAML from "yaml";

import { recipeFrontmatterSchema, type RecipeFrontmatter, type StagedRecipe } from "../../src/lib/recipe-schema";
import type { RuntimeConfig } from "./environment";
import { fileExists, listJsonFiles, listRecipeMarkdownFiles, readStagedRecipe } from "./io";
import { isArtifactPublishCurrent } from "./publish";

export type VerificationSeverity = "error" | "warning";

export interface VerificationIssue {
  severity: VerificationSeverity;
  code: string;
  message: string;
  file?: string;
}

export interface VerificationSummary {
  passed: boolean;
  counts: {
    recipe_markdown: number;
    staged_artifacts: number;
    published_scan_dirs: number;
    errors: number;
    warnings: number;
  };
  issues: VerificationIssue[];
}

interface RecipeMarkdownRecord {
  slug: string;
  filePath: string;
  data: RecipeFrontmatter;
}

export async function verifyArchive(config: RuntimeConfig): Promise<VerificationSummary> {
  const recipePaths = await listRecipeMarkdownFiles(path.join(config.projectRoot, "src/content/recipes"));
  const recipes = await Promise.all(recipePaths.map((filePath) => readRecipeMarkdownRecord(filePath)));
  const artifactPaths = await listJsonFiles(config.stagingDir);
  const artifacts = await Promise.all(artifactPaths.map((filePath) => readStagedRecipe(filePath)));
  const scanDirs = await listPublishedScanDirs(config.publishedScanDir);

  const issues: VerificationIssue[] = [];
  const artifactsById = new Map<string, StagedRecipe>();
  const artifactsBySlug = new Map<string, StagedRecipe>();
  const recipeSlugs = new Set(recipes.map((recipe) => recipe.slug));
  const recipeIds = new Map<string, RecipeMarkdownRecord[]>();

  for (const artifact of artifacts) {
    if (artifactsById.has(artifact.id)) {
      issues.push({
        severity: "error",
        code: "duplicate_artifact_id",
        message: `Multiple staged artifacts use id ${artifact.id}.`
      });
    }
    artifactsById.set(artifact.id, artifact);
    artifactsBySlug.set(artifact.slug, artifact);

    if (artifact.slug !== artifact.recipe.slug) {
      issues.push({
        severity: "error",
        code: "artifact_slug_mismatch",
        message: `${artifact.id} has artifact slug ${artifact.slug} but recipe slug ${artifact.recipe.slug}.`
      });
    }

    if (artifact.review.status !== artifact.recipe.review_status) {
      issues.push({
        severity: "error",
        code: "review_status_mismatch",
        message: `${artifact.id} has review status ${artifact.review.status} but recipe status ${artifact.recipe.review_status}.`
      });
    }

    const sourcePaths = [artifact.source.input_path, ...artifact.source.related_input_paths];
    for (const sourcePath of sourcePaths) {
      if (!(await fileExists(sourcePath))) {
        issues.push({
          severity: "warning",
          code: "missing_source_scan",
          message: `${artifact.id} points at a source scan that is not available: ${sourcePath}.`
        });
      }
    }

    if (artifact.review.status === "approved") {
      if (!artifact.publication.is_published) {
        issues.push({
          severity: "error",
          code: "approved_unpublished",
          message: `${artifact.id} is approved but not published.`
        });
      } else if (!isArtifactPublishCurrent(artifact)) {
        issues.push({
          severity: "error",
          code: "published_stale",
          message: `${artifact.id} is published but its public copy is stale.`
        });
      }
    }

    if (artifact.publication.is_published && artifact.publication.published_slug && !recipeSlugs.has(artifact.publication.published_slug)) {
      issues.push({
        severity: "error",
        code: "missing_published_markdown",
        message: `${artifact.id} says it published ${artifact.publication.published_slug}, but that recipe page is missing.`
      });
    }
  }

  for (const recipe of recipes) {
    const existing = recipeIds.get(recipe.data.id) ?? [];
    existing.push(recipe);
    recipeIds.set(recipe.data.id, existing);

    if (!artifactsById.has(recipe.data.id)) {
      issues.push({
        severity: "warning",
        code: "markdown_without_artifact",
        message: `${recipe.slug} is published but has no matching staged artifact.`,
        file: recipe.filePath
      });
    } else {
      const artifact = artifactsById.get(recipe.data.id)!;
      const mismatchedFields = findMarkdownArtifactMismatches(recipe.data, artifact);
      if (mismatchedFields.length > 0) {
        issues.push({
          severity: "error",
          code: "markdown_artifact_mismatch",
          message: `${recipe.slug} differs from its staged artifact in: ${mismatchedFields.join(", ")}.`,
          file: recipe.filePath
        });
      }
    }

    if (recipe.data.scan_assets.length === 0) {
      issues.push({
        severity: "warning",
        code: "recipe_without_scan_assets",
        message: `${recipe.slug} has no scan assets attached.`,
        file: recipe.filePath
      });
    }

    for (const asset of recipe.data.scan_assets) {
      const assetPath = resolvePublicAssetPath(config.projectRoot, recipe.filePath, asset.path);
      if (!assetPath || (await fileExists(assetPath))) {
        continue;
      }

      issues.push({
        severity: "error",
        code: "missing_scan_asset",
        message: `${recipe.slug} references missing scan asset ${asset.path}.`,
        file: recipe.filePath
      });
    }
  }

  for (const [id, records] of recipeIds.entries()) {
    if (records.length > 1) {
      issues.push({
        severity: "error",
        code: "duplicate_recipe_id",
        message: `Multiple recipe pages use id ${id}: ${records.map((record) => record.slug).join(", ")}.`
      });
    }
  }

  for (const scanDir of scanDirs) {
    if (!recipeSlugs.has(scanDir)) {
      issues.push({
        severity: "warning",
        code: "scan_dir_without_markdown",
        message: `public/scans/${scanDir} exists but no matching recipe page was found.`
      });
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;

  return {
    passed: errors === 0,
    counts: {
      recipe_markdown: recipes.length,
      staged_artifacts: artifacts.length,
      published_scan_dirs: scanDirs.length,
      errors,
      warnings
    },
    issues
  };
}

export function formatVerificationSummary(summary: VerificationSummary): string {
  const lines = [
    "Recipe archive verification",
    `- Recipe markdown files: ${summary.counts.recipe_markdown}`,
    `- Staged artifacts: ${summary.counts.staged_artifacts}`,
    `- Published scan folders: ${summary.counts.published_scan_dirs}`,
    `- Errors: ${summary.counts.errors}`,
    `- Warnings: ${summary.counts.warnings}`
  ];

  if (summary.issues.length > 0) {
    lines.push("", "Issues:");
    for (const issue of summary.issues) {
      const fileSuffix = issue.file ? ` (${issue.file})` : "";
      lines.push(`- [${issue.severity}] ${issue.code}: ${issue.message}${fileSuffix}`);
    }
  }

  return lines.join("\n");
}

async function readRecipeMarkdownRecord(filePath: string): Promise<RecipeMarkdownRecord> {
  const contents = await readFile(filePath, "utf8");
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) {
    throw new Error(`Recipe markdown is missing frontmatter: ${filePath}`);
  }

  return {
    slug: path.basename(filePath, ".md"),
    filePath,
    data: recipeFrontmatterSchema.parse(YAML.parse(match[1]))
  };
}

async function listPublishedScanDirs(scanRoot: string): Promise<string[]> {
  if (!(await fileExists(scanRoot))) {
    return [];
  }

  const entries = await readdir(scanRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function resolvePublicAssetPath(projectRoot: string, recipeFilePath: string, assetPath: string): string | null {
  if (/^https?:\/\//i.test(assetPath)) {
    return null;
  }

  if (assetPath.startsWith("/")) {
    return path.join(projectRoot, "public", assetPath.slice(1));
  }

  return path.resolve(path.dirname(recipeFilePath), assetPath);
}

function findMarkdownArtifactMismatches(recipe: RecipeFrontmatter, artifact: StagedRecipe): string[] {
  const comparableFields: Array<keyof RecipeFrontmatter> = [
    "title",
    "summary",
    "ingredients",
    "instructions",
    "notes",
    "source_name",
    "source_family",
    "course",
    "proteins",
    "cuisine",
    "dessert",
    "tags",
    "card_type",
    "ocr_confidence",
    "review_status"
  ];

  return comparableFields.filter((field) => {
    const artifactValue = field === "review_status" ? artifact.review.status : artifact.recipe[field];
    return JSON.stringify(recipe[field]) !== JSON.stringify(artifactValue);
  });
}
