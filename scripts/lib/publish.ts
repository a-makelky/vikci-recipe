import path from "node:path";
import { basename } from "node:path";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import type { ScanAsset, StagedRecipe } from "../../src/lib/recipe-schema";
import { slugify } from "../../src/lib/recipes";
import type { RuntimeConfig } from "./environment";
import {
  copyPublishedFile,
  ensureDir,
  fileExists,
  listRecipeMarkdownFiles,
  runCommand,
  writeRecipeMarkdown,
  writeJson
} from "./io";
import { getScanSideLabel, stripScanSideSuffix } from "./source-files";

export async function publishArtifact(artifact: StagedRecipe, config: RuntimeConfig): Promise<{
  recipePath: string;
  assetPaths: string[];
}> {
  const sourcePaths = [artifact.source.input_path, ...artifact.source.related_input_paths];
  const assetInfo = await publishScanAssets(sourcePaths, artifact.recipe.slug, config);
  const recipe = {
    ...artifact.recipe,
    scan_assets: assetInfo.scanAssets
  };
  const recipePath = path.join(config.projectRoot, "src/content/recipes", `${recipe.slug}.md`);
  const { slug: _slug, ...frontmatter } = recipe;
  await writeRecipeMarkdown(recipePath, frontmatter, buildRecipeBody(artifact));
  return {
    recipePath,
    assetPaths: assetInfo.assetPaths
  };
}

export async function writeStageArtifact(
  artifact: StagedRecipe,
  destinationDir: string
): Promise<string> {
  const filePath = path.join(destinationDir, `${artifact.id}.json`);
  await writeJson(filePath, artifact);
  return filePath;
}

export async function removePublishedRecipe(slug: string, config: RuntimeConfig): Promise<void> {
  await rm(path.join(config.projectRoot, "src/content/recipes", `${slug}.md`), {
    force: true
  });
  await rm(path.join(config.publishedScanDir, slug), {
    force: true,
    recursive: true
  });
}

export function computePublicationHash(artifact: StagedRecipe): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        slug: artifact.slug,
        source_input_path: artifact.source.input_path,
        related_input_paths: artifact.source.related_input_paths,
        title: artifact.recipe.title,
        summary: artifact.recipe.summary,
        ingredients: artifact.recipe.ingredients,
        instructions: artifact.recipe.instructions,
        notes: artifact.recipe.notes,
        source_name: artifact.recipe.source_name,
        source_family: artifact.recipe.source_family,
        course: artifact.recipe.course,
        proteins: artifact.recipe.proteins,
        cuisine: artifact.recipe.cuisine,
        dessert: artifact.recipe.dessert,
        tags: artifact.recipe.tags,
        card_type: artifact.recipe.card_type,
        ocr_confidence: artifact.recipe.ocr_confidence,
        review_status: artifact.review.status,
        review_reasons: artifact.review.reasons
      })
    )
    .digest("hex");
}

export function isArtifactPublishCurrent(artifact: StagedRecipe): boolean {
  return (
    artifact.publication.is_published === true &&
    artifact.publication.published_slug === artifact.slug &&
    artifact.publication.published_hash === computePublicationHash(artifact)
  );
}

export function markArtifactPublished(artifact: StagedRecipe): StagedRecipe {
  return {
    ...artifact,
    publication: {
      is_published: true,
      published_slug: artifact.slug,
      published_at: new Date().toISOString(),
      published_hash: computePublicationHash(artifact)
    }
  };
}

export function markArtifactUnpublished(artifact: StagedRecipe): StagedRecipe {
  return {
    ...artifact,
    publication: {
      is_published: false
    }
  };
}

export async function ensureUniqueSlug(baseSlug: string, projectRoot: string): Promise<string> {
  const recipesDir = path.join(projectRoot, "src/content/recipes");
  const markdownFiles = await listRecipeMarkdownFiles(recipesDir);
  const slugs = new Set(markdownFiles.map((filePath) => path.basename(filePath, ".md")));
  if (!slugs.has(baseSlug)) {
    return baseSlug;
  }

  let counter = 2;
  while (slugs.has(`${baseSlug}-${counter}`)) {
    counter += 1;
  }

  return `${baseSlug}-${counter}`;
}

export function deriveRecipeId(filePath: string, rootPath?: string): string {
  const relativeSource = rootPath ? path.relative(rootPath, filePath) : path.basename(filePath);
  const normalizedRelative = relativeSource.startsWith("..") ? path.basename(filePath) : relativeSource;
  const parsed = path.parse(normalizedRelative);
  const strippedStem = stripScanSideSuffix(parsed.name);
  const usesPairedKey = strippedStem !== parsed.name;
  const slugStem = path.join(parsed.dir, usesPairedKey ? strippedStem : parsed.name);
  const digestSource = usesPairedKey ? path.join(parsed.dir, strippedStem) : normalizedRelative;
  const slugBase = slugify(slugStem.split(path.sep).join("-")) || "untitled";
  const digest = createHash("sha1").update(digestSource).digest("hex").slice(0, 8);
  return `${slugBase}-${digest}`;
}

export function createSlugFromTitle(title: string, id: string): string {
  return slugify(title) || id;
}

async function publishScanAssets(
  sourcePaths: string[],
  slug: string,
  config: RuntimeConfig
): Promise<{ scanAssets: ScanAsset[]; assetPaths: string[] }> {
  const scanDir = path.join(config.publishedScanDir, slug);
  await ensureDir(scanDir);

  const assetPaths: string[] = [];
  const originalAssets: ScanAsset[] = [];
  const previewAssets: ScanAsset[] = [];
  for (const [index, sourcePath] of sourcePaths.entries()) {
    const extension = path.extname(sourcePath).toLowerCase();
    const sideLabel = getScanSideLabel(sourcePath, index, sourcePaths.length);
    const labelPrefix = sourcePaths.length === 1 ? "" : `${capitalize(sideLabel)} `;
    const baseName = sourcePaths.length === 1 ? "original" : `${sideLabel}-original`;
    const originalDestination = path.join(scanDir, `${baseName}${extension}`);
    await copyPublishedFile(sourcePath, originalDestination);
    await stripJpegMetadata(originalDestination);

    const publicOriginalPath = toPublicPath(config.publishedScanDir, originalDestination);
    assetPaths.push(originalDestination);
    originalAssets.push({
      path: publicOriginalPath,
      label: `${labelPrefix}scan`.trim().replace(/^./, (value) => value.toUpperCase()),
      type: extension === ".pdf" ? "pdf" : "image",
      role: "original"
    });

    if (extension === ".pdf") {
      const previewDestination = path.join(scanDir, sourcePaths.length === 1 ? "preview.png" : `${sideLabel}-preview.png`);
      const previewCreated = await tryRenderPdfPreview(sourcePath, previewDestination);
      if (previewCreated) {
        assetPaths.push(previewDestination);
        previewAssets.push({
          path: toPublicPath(config.publishedScanDir, previewDestination),
          label: `${labelPrefix}preview`.trim().replace(/^./, (value) => value.toUpperCase()),
          type: "image",
          role: "preview"
        });
      }
      continue;
    }

    const previewDestination = path.join(scanDir, sourcePaths.length === 1 ? "preview.jpg" : `${sideLabel}-preview.jpg`);
    const previewCreated = await tryCreateImagePreview(sourcePath, previewDestination);
    if (previewCreated) {
      await stripJpegMetadata(previewDestination);
      assetPaths.push(previewDestination);
      previewAssets.push({
        path: toPublicPath(config.publishedScanDir, previewDestination),
        label: `${labelPrefix}preview`.trim().replace(/^./, (value) => value.toUpperCase()),
        type: "image",
        role: "preview"
      });
    } else {
      previewAssets.push({
        path: publicOriginalPath,
        label: `${labelPrefix}preview`.trim().replace(/^./, (value) => value.toUpperCase()),
        type: "image",
        role: "preview"
      });
    }
  }

  return { scanAssets: [...previewAssets, ...originalAssets], assetPaths };
}

function buildRecipeBody(artifact: StagedRecipe): string {
  if (!artifact.review.reasons.length) {
    return "";
  }

  return [
    "Imported through the OCR pipeline.",
    "",
    "Review notes:",
    ...artifact.review.reasons.map((reason) => `- ${reason}`)
  ].join("\n");
}

function toPublicPath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath).split(path.sep).join("/");
  return `/scans/${relative}`;
}

async function tryCreateImagePreview(sourcePath: string, destinationPath: string): Promise<boolean> {
  try {
    await runCommand("sips", ["-s", "format", "jpeg", "--resampleHeightWidthMax", "1600", sourcePath, "--out", destinationPath]);
    return await fileExists(destinationPath);
  } catch (error) {
    console.warn(`Unable to create image preview for ${basename(sourcePath)}: ${String(error)}`);
    return false;
  }
}

async function tryRenderPdfPreview(sourcePath: string, destinationPath: string): Promise<boolean> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "vicki-ql-"));
  try {
    await runCommand("qlmanage", ["-t", "-s", "1600", "-o", tempDir, sourcePath]);
    const files = await readdir(tempDir);
    const previewName = files.find((fileName) => fileName.endsWith(".png") || fileName.endsWith(".jpg"));
    if (!previewName) {
      return false;
    }

    await copyPublishedFile(path.join(tempDir, previewName), destinationPath);
    return true;
  } catch (error) {
    console.warn(`Unable to create PDF preview for ${basename(sourcePath)}: ${String(error)}`);
    return false;
  }
}

async function stripJpegMetadata(filePath: string): Promise<void> {
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".jpg" && extension !== ".jpeg") {
    return;
  }

  const tempPath = `${filePath}.stripped`;
  try {
    await runCommand("jpegtran", ["-copy", "none", "-optimize", "-outfile", tempPath, filePath]);
    await copyPublishedFile(tempPath, filePath);
  } catch (error) {
    console.warn(`Unable to strip JPEG metadata for ${basename(filePath)}: ${String(error)}`);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}
