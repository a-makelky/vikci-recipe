import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { serializeRecipeMarkdown } from "./lib/io";
import { resolveRuntimeConfig } from "./lib/environment";
import { ensureUniqueSlug } from "./lib/publish";
import { groupPairedScanFiles, getScanSideLabel } from "./lib/source-files";
import { slugify } from "../src/lib/recipes";
import type { RecipeFrontmatter, ScanAsset } from "../src/lib/recipe-schema";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

interface CurationRow {
  source: string;
  destination: string;
  note: string;
}

const helpText = `
Usage:
  npm run publish-scan-only -- --input /path/to/ingest-jpg [--category Drinks] [--report data/staging/report.json] [--force]

Purpose:
  Publish scan-first recipe pages immediately, without waiting for OCR.
`;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = resolveRuntimeConfig(projectRoot);
const COURSE_BY_CATEGORY: Record<string, RecipeFrontmatter["course"]> = {
  appetizer: "appetizer",
  appetizers: "appetizer",
  bread: "bread",
  breads: "bread",
  dessert: "dessert",
  desserts: "dessert",
  drink: "beverage",
  drinks: "beverage",
  beverage: "beverage",
  beverages: "beverage",
  breakfast: "breakfast",
  main: "main",
  mains: "main",
  salad: "salad",
  salads: "salad",
  side: "side",
  sides: "side",
  snack: "snack",
  snacks: "snack",
  soup: "soup",
  soups: "soup"
};

async function main() {
  const parsed = parseArgs({
    options: {
      input: { type: "string" },
      category: { type: "string", default: "Uncategorized" },
      report: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false }
    },
    allowPositionals: false
  });

  if (parsed.values.help) {
    console.log(helpText.trim());
    return;
  }

  const inputDir = parsed.values.input ? path.resolve(parsed.values.input) : "";
  if (!inputDir) {
    throw new Error(`--input is required.\n\n${helpText.trim()}`);
  }

  const category = String(parsed.values.category || "Uncategorized").trim();
  const files = await collectInputImages(inputDir);
  if (files.length === 0) {
    throw new Error(`No supported image files found in ${inputDir}.`);
  }

  const curationRows = await readCurationRows(path.join(inputDir, "_curation-map.csv"));
  const notesByDestination = new Map(curationRows.map((row) => [row.destination, row.note]));
  const groups = groupPairedScanFiles(files);
  const alreadyPublishedSourcePaths = await collectAlreadyPublishedSourcePaths();
  const report = {
    started_at: new Date().toISOString(),
    input_path: inputDir,
    category,
    published: [] as Array<{ title: string; slug: string; files: string[] }>,
    skipped: [] as Array<{ title: string; slug: string; reason: string; files: string[] }>
  };

  for (const group of groups) {
    const title = titleForGroup(group.filePaths, notesByDestination);
    if (group.filePaths.some((filePath) => alreadyPublishedSourcePaths.has(filePath))) {
      report.skipped.push({
        title,
        slug: path.basename(group.primaryPath, path.extname(group.primaryPath)),
        reason: "This source scan already has a published OCR recipe.",
        files: group.filePaths
      });
      continue;
    }

    const baseSlug = slugify(title) || slugify(path.basename(group.primaryPath, path.extname(group.primaryPath)));
    const slug = parsed.values.force
      ? baseSlug
      : await ensureUniqueSlug(baseSlug, config.projectRoot);

    const recipePath = path.join(config.projectRoot, "src/content/recipes", `${slug}.md`);
    if (parsed.values.force) {
      await rm(path.join(config.publishedScanDir, slug), { force: true, recursive: true });
      await rm(recipePath, { force: true });
    }

    const scanAssets = await publishScanAssets(group.filePaths, slug);
    const recipe: RecipeFrontmatter = {
      id: `scan-only-${slug}`,
      title,
      summary: "Scan is available. Transcription is still pending.",
      ingredients: ["Transcription pending. Read from the original scan."],
      instructions: ["Transcription pending. Read from the original scan."],
      notes: [
        "Published as a scan-first archive entry for Mother's Day.",
        "OCR and structured cleanup can be added later."
      ],
      source_name: config.defaultSourceName,
      source_family: config.defaultSourceFamily,
      course: courseForCategory(category),
      proteins: [],
      cuisine: "unknown",
      dessert: false,
      tags: [category.toLowerCase(), "scan-first", "needs transcription"],
      card_type: "mixed",
      ocr_confidence: "low",
      review_status: "needs_transcription",
      scan_assets: scanAssets
    };

    await mkdir(path.dirname(recipePath), { recursive: true });
    await writeFile(
      recipePath,
      serializeRecipeMarkdown(recipe, [
        "This recipe is live as an image-first archive entry.",
        "",
        "The original card scan is the source of truth until transcription is reviewed."
      ].join("\n")),
      "utf8"
    );

    report.published.push({ title, slug, files: group.filePaths });
    console.log(`Published scan-only page: ${title}`);
  }

  if (parsed.values.report) {
    const reportPath = path.resolve(parsed.values.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({ ...report, completed_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  }

  console.log(`Scan-only publish complete: ${report.published.length} published, ${report.skipped.length} skipped.`);
}

async function collectAlreadyPublishedSourcePaths(): Promise<Set<string>> {
  const paths = new Set<string>();
  let entries;
  try {
    entries = await readdir(config.stagingDir, { withFileTypes: true });
  } catch {
    return paths;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const artifact = JSON.parse(await readFile(path.join(config.stagingDir, entry.name), "utf8"));
      if (!artifact?.publication?.is_published) {
        continue;
      }

      for (const sourcePath of [artifact.source?.input_path, ...(artifact.source?.related_input_paths ?? [])]) {
        if (typeof sourcePath === "string") {
          paths.add(sourcePath);
        }
      }
    } catch {
      // Ignore malformed staging artifacts; they should not block scan-first publishing.
    }
  }

  return paths;
}

async function collectInputImages(inputDir: string): Promise<string[]> {
  const entries = await readdir(inputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(inputDir, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right), undefined, { numeric: true }));
}

async function readCurationRows(filePath: string): Promise<CurationRow[]> {
  try {
    const contents = await readFile(filePath, "utf8");
    return contents
      .split(/\r?\n/)
      .slice(1)
      .map(parseCsvLine)
      .filter((row): row is string[] => row.length >= 3)
      .map(([source, destination, note]) => ({
        source: source ?? "",
        destination: destination ?? "",
        note: note ?? ""
      }));
  } catch {
    return [];
  }
}

function parseCsvLine(line: string): string[] {
  if (!line.trim()) {
    return [];
  }

  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (character === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
    } else if (character === '"') {
      inQuotes = !inQuotes;
    } else if (character === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function titleForGroup(filePaths: string[], notesByDestination: Map<string, string>): string {
  const front = filePaths.find((filePath) => path.basename(filePath).includes("-front")) ?? filePaths[0]!;
  const note = notesByDestination.get(path.basename(front)) || path.basename(front, path.extname(front));
  return normalizeTitle(note);
}

function normalizeTitle(value: string): string {
  return value
    .replace(/\b(front|visible side|side|card|clipping|recipe|quantity chart|continuation)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (character) => character.toUpperCase());
}

function courseForCategory(category: string): RecipeFrontmatter["course"] {
  return COURSE_BY_CATEGORY[category.trim().toLowerCase()] ?? "other";
}

async function publishScanAssets(sourcePaths: string[], slug: string): Promise<ScanAsset[]> {
  const scanDir = path.join(config.publishedScanDir, slug);
  await mkdir(scanDir, { recursive: true });
  const previewAssets: ScanAsset[] = [];
  const originalAssets: ScanAsset[] = [];

  for (const [index, sourcePath] of sourcePaths.entries()) {
    const extension = path.extname(sourcePath).toLowerCase() === ".jpeg" ? ".jpg" : path.extname(sourcePath).toLowerCase();
    const sideLabel = getScanSideLabel(sourcePath, index, sourcePaths.length);
    const originalName = sourcePaths.length === 1 ? `original${extension}` : `${sideLabel}-original${extension}`;
    const previewName = sourcePaths.length === 1 ? "preview.jpg" : `${sideLabel}-preview.jpg`;
    const originalDestination = path.join(scanDir, originalName);
    const previewDestination = path.join(scanDir, previewName);
    await copyFile(sourcePath, originalDestination);
    await copyFile(sourcePath, previewDestination);

    const labelPrefix = sourcePaths.length === 1 ? "" : `${capitalize(sideLabel)} `;
    previewAssets.push({
      path: publicScanPath(previewDestination),
      label: `${labelPrefix}preview`.trim().replace(/^./, (value) => value.toUpperCase()),
      type: "image",
      role: "preview"
    });
    originalAssets.push({
      path: publicScanPath(originalDestination),
      label: `${labelPrefix}scan`.trim().replace(/^./, (value) => value.toUpperCase()),
      type: "image",
      role: "original"
    });
  }

  return [...previewAssets, ...originalAssets];
}

function publicScanPath(filePath: string): string {
  return `/scans/${path.relative(config.publishedScanDir, filePath).split(path.sep).join("/")}`;
}

function capitalize(value: string): string {
  return value.replace(/^./, (character) => character.toUpperCase());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
