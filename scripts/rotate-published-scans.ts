import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const runFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(projectRoot, "data/scan-rotations.json");
const logPath = path.join(projectRoot, "data/scan-rotations-applied.json");
const scansRoot = path.join(projectRoot, "public/scans");
const supportedImageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const allowedDegrees = new Set([90, 180, 270]);
const publishedScanNamePattern = /^(?:(?:front|back)-)?(?:original|preview)\.(?:jpe?g|png|webp)$/i;

interface RotationManifest {
  version: 1;
  rotations: RotationEntry[];
}

interface RotationEntry {
  slug: string;
  degrees: 90 | 180 | 270;
  files?: string[];
  reason?: string;
}

interface RotationLog {
  version: 1;
  entries: Record<string, RotationLogEntry>;
}

interface RotationLogEntry {
  slug: string;
  file: string;
  degrees: number;
  beforeHash: string;
  afterHash: string;
  appliedAt: string;
}

const helpText = `
Usage:
  npm run rotate-scans [-- --dry-run]

Purpose:
  Rotate published recipe scan image files listed in data/scan-rotations.json.
  The script records hashes so repeated runs skip files already rotated.
`;

async function main() {
  const parsed = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false }
    },
    allowPositionals: false
  });

  if (parsed.values.help) {
    console.log(helpText.trim());
    return;
  }

  const manifest = await readManifest();
  const log = await readLog();
  let changedLog = false;
  let applied = 0;
  let skipped = 0;

  for (const entry of manifest.rotations) {
    validateEntry(entry);
    const files = await resolveEntryFiles(entry);
    if (files.length === 0) {
      console.warn(`No image files found for ${entry.slug}.`);
      continue;
    }

    for (const absolutePath of files) {
      const file = path.relative(path.join(scansRoot, entry.slug), absolutePath);
      const logKey = `${entry.slug}/${file}`;
      const currentHash = await hashFile(absolutePath);
      const previous = log.entries[logKey];

      if (previous?.afterHash === currentHash && previous.degrees === entry.degrees) {
        console.log(`Already rotated: ${logKey}`);
        skipped += 1;
        continue;
      }

      if (previous?.afterHash === currentHash && previous.degrees !== entry.degrees) {
        console.log(`Applying additional rotation to ${logKey}: ${entry.degrees} degrees.`);
      } else if (previous && previous.beforeHash !== currentHash) {
        console.warn(`Skipping changed file to avoid double rotation: ${logKey}`);
        skipped += 1;
        continue;
      }

      if (parsed.values["dry-run"]) {
        console.log(`Would rotate ${logKey} by ${entry.degrees} degrees.`);
        continue;
      }

      const afterHash = await rotateImage(absolutePath, entry.degrees);
      log.entries[logKey] = {
        slug: entry.slug,
        file,
        degrees: entry.degrees,
        beforeHash: currentHash,
        afterHash,
        appliedAt: new Date().toISOString()
      };
      changedLog = true;
      applied += 1;
      console.log(`Rotated ${logKey} by ${entry.degrees} degrees.`);
    }
  }

  if (changedLog && !parsed.values["dry-run"]) {
    await writeLog(log);
  }

  console.log(`Scan rotation complete: ${applied} applied, ${skipped} skipped.`);
}

async function readManifest(): Promise<RotationManifest> {
  const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  if (parsed.version !== 1 || !Array.isArray(parsed.rotations)) {
    throw new Error("data/scan-rotations.json must contain { version: 1, rotations: [...] }.");
  }
  return parsed;
}

async function readLog(): Promise<RotationLog> {
  try {
    const parsed = JSON.parse(await readFile(logPath, "utf8"));
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
      return parsed;
    }
  } catch {
    // Missing or malformed logs should not block first-time rotation.
  }

  return { version: 1, entries: {} };
}

async function writeLog(log: RotationLog): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
}

function validateEntry(entry: RotationEntry): void {
  if (!entry.slug || typeof entry.slug !== "string") {
    throw new Error("Every scan rotation entry needs a slug.");
  }
  if (!allowedDegrees.has(entry.degrees)) {
    throw new Error(`Rotation for ${entry.slug} must be 90, 180, or 270 degrees.`);
  }
}

async function resolveEntryFiles(entry: RotationEntry): Promise<string[]> {
  const scanDir = path.join(scansRoot, entry.slug);
  const fileNames = entry.files ?? await listImageFiles(scanDir);
  return fileNames
    .filter((fileName) => supportedImageExtensions.has(path.extname(fileName).toLowerCase()))
    .map((fileName) => path.join(scanDir, fileName));
}

async function listImageFiles(scanDir: string): Promise<string[]> {
  const entries = await readdir(scanDir, { withFileTypes: true });
  return entries
    .filter((entry) => (
      entry.isFile() &&
      publishedScanNamePattern.test(entry.name) &&
      supportedImageExtensions.has(path.extname(entry.name).toLowerCase())
    ))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

async function rotateImage(filePath: string, degrees: number): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "vicki-scan-rotate-"));
  const tempPath = path.join(tempDir, path.basename(filePath));
  try {
    await runFile("sips", ["-r", String(degrees), filePath, "--out", tempPath]);
    const afterHash = await hashFile(tempPath);
    await rename(tempPath, filePath);
    return afterHash;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
