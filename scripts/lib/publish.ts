import path from "node:path";
import { basename } from "node:path";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

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

export async function publishArtifact(artifact: StagedRecipe, config: RuntimeConfig): Promise<{
  recipePath: string;
  assetPaths: string[];
}> {
  const assetInfo = await publishScanAssets(artifact.source.input_path, artifact.recipe.slug, config);
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

export function deriveRecipeId(filePath: string): string {
  const stem = path.basename(filePath, path.extname(filePath));
  if (/^recipe-\d+$/i.test(stem)) {
    return stem.toLowerCase();
  }

  return `recipe-${slugify(stem) || "untitled"}`;
}

export function createSlugFromTitle(title: string, id: string): string {
  return slugify(title) || id;
}

async function publishScanAssets(
  sourcePath: string,
  slug: string,
  config: RuntimeConfig
): Promise<{ scanAssets: ScanAsset[]; assetPaths: string[] }> {
  const extension = path.extname(sourcePath).toLowerCase();
  const scanDir = path.join(config.publishedScanDir, slug);
  await ensureDir(scanDir);

  const assetPaths: string[] = [];
  const scanAssets: ScanAsset[] = [];
  const originalDestination = path.join(scanDir, `original${extension}`);
  await copyPublishedFile(sourcePath, originalDestination);

  const publicOriginalPath = toPublicPath(config.publishedScanDir, originalDestination);
  assetPaths.push(originalDestination);
  scanAssets.push({
    path: publicOriginalPath,
    label: "Original scan",
    type: extension === ".pdf" ? "pdf" : "image",
    role: "original"
  });

  if (extension === ".pdf") {
    const previewDestination = path.join(scanDir, "preview.png");
    const previewCreated = await tryRenderPdfPreview(sourcePath, previewDestination);
    if (previewCreated) {
      assetPaths.push(previewDestination);
      scanAssets.unshift({
        path: toPublicPath(config.publishedScanDir, previewDestination),
        label: "Scan preview",
        type: "image",
        role: "preview"
      });
    }
  } else {
    const previewDestination = path.join(scanDir, "preview.jpg");
    const previewCreated = await tryCreateImagePreview(sourcePath, previewDestination);
    if (previewCreated) {
      assetPaths.push(previewDestination);
      scanAssets.unshift({
        path: toPublicPath(config.publishedScanDir, previewDestination),
        label: "Scan preview",
        type: "image",
        role: "preview"
      });
    } else {
      scanAssets.unshift({
        path: publicOriginalPath,
        label: "Scan preview",
        type: "image",
        role: "preview"
      });
    }
  }

  return { scanAssets, assetPaths };
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
