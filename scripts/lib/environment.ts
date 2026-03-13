import { readFileSync } from "node:fs";
import path from "node:path";

export interface RuntimeConfig {
  projectRoot: string;
  rawScanDir?: string;
  stagingDir: string;
  reviewDir: string;
  publishedScanDir: string;
  zaiApiKey?: string;
  zaiBaseUrl: string;
  zaiVisionModel: string;
  zaiStructuringModel: string;
  zaiOcrModel: string;
  googleCloudProject?: string;
  googleCloudLocation: string;
  googleCredentialsPath?: string;
  defaultSourceName: string;
  defaultSourceFamily: string;
}

export function loadProjectEnv(projectRoot: string): void {
  for (const fileName of [".env", ".env.local"]) {
    const filePath = path.join(projectRoot, fileName);
    try {
      const contents = readFileSync(filePath, "utf8");
      for (const line of contents.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }

        const separator = trimmed.indexOf("=");
        if (separator === -1) {
          continue;
        }

        const key = trimmed.slice(0, separator).trim();
        const rawValue = trimmed.slice(separator + 1).trim();
        const value = rawValue.replace(/^['"]|['"]$/g, "");
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    } catch (error) {
      // Skip missing env files without treating them as failures.
    }
  }
}

export function resolveRuntimeConfig(projectRoot: string): RuntimeConfig {
  loadProjectEnv(projectRoot);

  return {
    projectRoot,
    rawScanDir: process.env.RAW_SCAN_DIR,
    stagingDir: resolveProjectPath(projectRoot, process.env.STAGING_DIR || "data/staging/artifacts"),
    reviewDir: resolveProjectPath(projectRoot, process.env.REVIEW_DIR || "data/staging/review"),
    publishedScanDir: resolveProjectPath(projectRoot, process.env.PUBLISHED_SCAN_DIR || "public/scans"),
    zaiApiKey: process.env.ZAI_API_KEY,
    zaiBaseUrl: trimTrailingSlash(process.env.ZAI_BASE_URL || "https://api.z.ai/api/coding/paas/v4"),
    zaiVisionModel: process.env.ZAI_VISION_MODEL || process.env.ZAI_OCR_MODEL || "glm-4.6v",
    zaiStructuringModel: process.env.ZAI_STRUCTURING_MODEL || "glm-4.7-flash",
    zaiOcrModel: process.env.ZAI_OCR_MODEL || process.env.ZAI_VISION_MODEL || "glm-ocr",
    googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT,
    googleCloudLocation: process.env.GOOGLE_CLOUD_LOCATION || "us",
    googleCredentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    defaultSourceName: process.env.DEFAULT_SOURCE_NAME || "Vicki",
    defaultSourceFamily: process.env.DEFAULT_SOURCE_FAMILY || "Makelky"
  };
}

export function resolveProjectPath(projectRoot: string, value: string): string {
  if (path.isAbsolute(value)) {
    return value;
  }

  return path.join(projectRoot, value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}
