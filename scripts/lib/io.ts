import { constants, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import YAML from "yaml";

import type { RecipeFrontmatter, StagedRecipe } from "../../src/lib/recipe-schema";
import { recipeFrontmatterSchema, stagedRecipeSchema } from "../../src/lib/recipe-schema";

const SUPPORTED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".pdf", ".webp"]);

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function collectInputFiles(inputPath: string): Promise<string[]> {
  const details = await stat(inputPath);
  if (details.isFile()) {
    return SUPPORTED_EXTENSIONS.has(path.extname(inputPath).toLowerCase()) ? [inputPath] : [];
  }

  const entries = await readdir(inputPath, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map((entry) => collectInputFiles(path.join(inputPath, entry.name)))
  );

  return nestedFiles.flat().filter((filePath) => SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
}

export function inferMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  const contents = await readFile(filePath, "utf8");
  return JSON.parse(contents) as T;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readStagedRecipe(filePath: string): Promise<StagedRecipe> {
  const parsed = stagedRecipeSchema.parse(await readJson<unknown>(filePath));
  return parsed;
}

export function serializeRecipeMarkdown(recipe: RecipeFrontmatter, body = ""): string {
  const validated = recipeFrontmatterSchema.parse(recipe);
  const frontmatter = YAML.stringify(validated, {
    lineWidth: 0,
    defaultStringType: "PLAIN"
  });

  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return `---\n${frontmatter}---\n`;
  }

  return `---\n${frontmatter}---\n\n${trimmedBody}\n`;
}

export async function writeRecipeMarkdown(filePath: string, recipe: RecipeFrontmatter, body = ""): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, serializeRecipeMarkdown(recipe, body), "utf8");
}

export async function listJsonFiles(dirPath: string): Promise<string[]> {
  const exists = await fileExists(dirPath);
  if (!exists) {
    return [];
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const absolute = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return listJsonFiles(absolute);
      }
      return absolute.endsWith(".json") ? [absolute] : [];
    })
  );

  return nested.flat().sort();
}

export async function listRecipeMarkdownFiles(contentDir: string): Promise<string[]> {
  const exists = await fileExists(contentDir);
  if (!exists) {
    return [];
  }

  const entries = await readdir(contentDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(contentDir, entry.name))
    .sort();
}

export async function copyPublishedFile(sourcePath: string, destinationPath: string): Promise<void> {
  await ensureDir(path.dirname(destinationPath));
  await copyFile(sourcePath, destinationPath, constants.COPYFILE_FICLONE);
}

export async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}\n${stderr}`));
    });
  });
}
