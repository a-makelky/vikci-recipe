import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const UNSUPPORTED_IMAGE_EXTENSIONS = new Set([".heic", ".heif"]);

type Mode = "front-back" | "front-back-filtered" | "fronts-only" | "mixed";

interface ImageFile {
  absolutePath: string;
  fileName: string;
  extension: string;
}

const helpText = `
Usage:
  npm run prepare-scans -- --input /path/to/phone-export-originals --output /path/to/ingest-jpg [--mode front-back|front-back-filtered|fronts-only|mixed] [--backs 2,8,14] [--start 1] [--dry-run] [--force]

Purpose:
  Rename a phone photo export into the stable recipe card names expected by the ingest pipeline.
`;

async function main() {
  const parsed = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      mode: { type: "string", default: "front-back" },
      backs: { type: "string" },
      start: { type: "string", default: "1" },
      "dry-run": { type: "boolean", default: false },
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
  const outputDir = parsed.values.output ? path.resolve(parsed.values.output) : "";
  if (!inputDir || !outputDir) {
    throw new Error(`Both --input and --output are required.\n\n${helpText.trim()}`);
  }

  const mode = parseMode(parsed.values.mode);
  const start = parseStart(parsed.values.start);
  const backs = parseBacks(parsed.values.backs, start);
  if (mode !== "mixed" && mode !== "front-back-filtered" && backs.size > 0) {
    throw new Error("--backs is only used with --mode mixed or --mode front-back-filtered.");
  }
  const images = await collectImageFiles(inputDir);
  if (images.unsupported.length > 0) {
    throw new Error(
      [
        "Unsupported iPhone image format found. Switch the phone camera/export to JPG, then export again.",
        ...images.unsupported.map((fileName) => `- ${fileName}`)
      ].join("\n")
    );
  }

  if (images.supported.length === 0) {
    throw new Error(`No supported image files found in ${inputDir}.`);
  }

  if ((mode === "front-back" || mode === "front-back-filtered") && images.supported.length % 2 !== 0) {
    throw new Error(
      `Front/back mode needs an even number of images. Found ${images.supported.length}. Reshoot or remove the extra image before preparing the batch.`
    );
  }

  const { mappings, cardCount } = createMappings(images.supported, outputDir, mode, start, backs);
  if (!parsed.values.force) {
    await assertDestinationsAreClear(mappings.map((mapping) => mapping.destinationPath));
  }

  await mkdir(outputDir, { recursive: true });
  const lines = ["source,destination"];
  for (const mapping of mappings) {
    lines.push(`${csv(mapping.sourcePath)},${csv(mapping.destinationPath)}`);
    console.log(`${path.basename(mapping.sourcePath)} -> ${path.basename(mapping.destinationPath)}`);
    if (!parsed.values["dry-run"]) {
      await copyFile(mapping.sourcePath, mapping.destinationPath);
    }
  }

  if (!parsed.values["dry-run"]) {
    await writeFile(path.join(outputDir, "_rename-map.csv"), `${lines.join("\n")}\n`, "utf8");
  }

  console.log(`Prepared ${cardCount} recipe card${cardCount === 1 ? "" : "s"} into ${outputDir}.`);
}

function parseMode(value: string | boolean | undefined): Mode {
  if (value === "front-back" || value === "front-back-filtered" || value === "fronts-only" || value === "mixed") {
    return value;
  }

  throw new Error(`Unsupported mode "${String(value)}". Use front-back, front-back-filtered, fronts-only, or mixed.`);
}

function parseStart(value: string | boolean | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--start must be a positive whole number.");
  }

  return parsed;
}

function parseBacks(value: string | boolean | undefined, start: number): Set<number> {
  if (!value) {
    return new Set();
  }
  if (typeof value !== "string") {
    throw new Error("--backs must be a comma-separated list of recipe numbers.");
  }

  const backs = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item));

  for (const recipeNumber of backs) {
    if (!Number.isInteger(recipeNumber) || recipeNumber < start) {
      throw new Error(`Invalid back-side recipe number "${recipeNumber}".`);
    }
  }

  return new Set(backs);
}

async function collectImageFiles(inputDir: string): Promise<{ supported: ImageFile[]; unsupported: string[] }> {
  const entries = await readdir(inputDir, { withFileTypes: true });
  const files: ImageFile[] = [];
  const unsupported: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      const absolutePath = path.join(inputDir, entry.name);
      const details = await stat(absolutePath);
      if (details.size > 0) {
        files.push({
          absolutePath,
          fileName: entry.name,
          extension
        });
      }
    } else if (UNSUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
      unsupported.push(entry.name);
    }
  }

  return {
    supported: files.sort(compareNaturalFileNames),
    unsupported: unsupported.sort(compareStrings)
  };
}

function createMappings(
  images: ImageFile[],
  outputDir: string,
  mode: Mode,
  start: number,
  backs: Set<number>
): { mappings: Array<{ sourcePath: string; destinationPath: string }>; cardCount: number } {
  if (mode === "mixed") {
    return createMixedMappings(images, outputDir, start, backs);
  }
  if (mode === "front-back-filtered") {
    return createFilteredFrontBackMappings(images, outputDir, start, backs);
  }

  const mappings = images.map((image, index) => {
    const cardIndex = mode === "front-back" ? start + Math.floor(index / 2) : start + index;
    const side = mode === "front-back" ? (index % 2 === 0 ? "front" : "back") : "front";
    return createMapping(image, outputDir, cardIndex, side);
  });

  return {
    mappings,
    cardCount: mode === "front-back" ? mappings.length / 2 : mappings.length
  };
}

function createFilteredFrontBackMappings(
  images: ImageFile[],
  outputDir: string,
  start: number,
  backs: Set<number>
): { mappings: Array<{ sourcePath: string; destinationPath: string }>; cardCount: number } {
  const mappings: Array<{ sourcePath: string; destinationPath: string }> = [];
  const cardCount = images.length / 2;
  const lastCardIndex = start + cardCount - 1;
  const missingBacks = [...backs].filter((recipeNumber) => recipeNumber > lastCardIndex);
  if (missingBacks.length > 0) {
    throw new Error(`Back-side recipe numbers were listed beyond the image set: ${missingBacks.join(", ")}.`);
  }

  for (let pairIndex = 0; pairIndex < cardCount; pairIndex += 1) {
    const cardIndex = start + pairIndex;
    const frontImage = images[pairIndex * 2]!;
    const backImage = images[pairIndex * 2 + 1]!;
    mappings.push(createMapping(frontImage, outputDir, cardIndex, "front"));
    if (backs.has(cardIndex)) {
      mappings.push(createMapping(backImage, outputDir, cardIndex, "back"));
    }
  }

  return { mappings, cardCount };
}

function createMixedMappings(
  images: ImageFile[],
  outputDir: string,
  start: number,
  backs: Set<number>
): { mappings: Array<{ sourcePath: string; destinationPath: string }>; cardCount: number } {
  const mappings: Array<{ sourcePath: string; destinationPath: string }> = [];
  let imageIndex = 0;
  let cardIndex = start;

  while (imageIndex < images.length) {
    mappings.push(createMapping(images[imageIndex]!, outputDir, cardIndex, "front"));
    imageIndex += 1;

    if (backs.has(cardIndex)) {
      if (imageIndex >= images.length) {
        throw new Error(`Recipe ${cardIndex} is marked as having a back, but there is no next image to use as its back.`);
      }
      mappings.push(createMapping(images[imageIndex]!, outputDir, cardIndex, "back"));
      imageIndex += 1;
    }

    cardIndex += 1;
  }

  const lastCardIndex = cardIndex - 1;
  const missingBacks = [...backs].filter((recipeNumber) => recipeNumber > lastCardIndex);
  if (missingBacks.length > 0) {
    throw new Error(`Back-side recipe numbers were listed beyond the image set: ${missingBacks.join(", ")}.`);
  }

  return {
    mappings,
    cardCount: lastCardIndex - start + 1
  };
}

function createMapping(image: ImageFile, outputDir: string, cardIndex: number, side: "front" | "back") {
  const normalizedExtension = image.extension === ".jpeg" ? ".jpg" : image.extension;
  return {
    sourcePath: image.absolutePath,
    destinationPath: path.join(outputDir, `recipe-${String(cardIndex).padStart(4, "0")}-${side}${normalizedExtension}`)
  };
}

async function assertDestinationsAreClear(destinations: string[]): Promise<void> {
  const existing: string[] = [];
  for (const destination of destinations) {
    try {
      await access(destination, constants.F_OK);
      existing.push(destination);
    } catch {
      // Missing files are expected.
    }
  }

  if (existing.length > 0) {
    throw new Error(
      [
        "Prepared filenames already exist. Move them aside or rerun with --force if replacement is intentional.",
        ...existing.map((filePath) => `- ${filePath}`)
      ].join("\n")
    );
  }
}

function compareNaturalFileNames(left: ImageFile, right: ImageFile): number {
  return left.fileName.localeCompare(right.fileName, undefined, { numeric: true, sensitivity: "base" });
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function csv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
