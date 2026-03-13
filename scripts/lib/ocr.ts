import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSign } from "node:crypto";

import type { ExtractedRecipe } from "../../src/lib/recipe-schema";
import {
  CARD_TYPE_VALUES,
  COURSE_VALUES,
  OCR_CONFIDENCE_VALUES,
  PROTEIN_VALUES,
  extractedRecipeSchema
} from "../../src/lib/recipe-schema";
import type { RuntimeConfig } from "./environment";
import { inferMimeType, readJson } from "./io";
import { getScanSideLabel } from "./source-files";

export interface OcrResult {
  provider: "zai-vision" | "glm-ocr" | "google-vision";
  markdown: string;
  rawResponse: unknown;
  fallbackUsed: boolean;
}

export interface RecipeOcrSection {
  title: string;
  markdown: string;
  startLine: number;
  endLine: number;
}

export async function extractRecipeFromFile(
  filePath: string,
  config: RuntimeConfig,
  enableGoogleFallback: boolean
): Promise<OcrResult & { recipe: ExtractedRecipe }> {
  if (!config.zaiApiKey) {
    throw new Error("Missing ZAI_API_KEY. Add it to .env before running ingest.");
  }

  const ocr = await extractOcrFromFile(filePath, config, enableGoogleFallback);

  const recipe = await structureRecipeFromMarkdown(ocr.markdown, filePath, config);
  return { ...ocr, recipe };
}

export async function extractRecipeFromSourceFiles(
  filePaths: string[],
  config: RuntimeConfig,
  enableGoogleFallback: boolean
): Promise<OcrResult & { recipe: ExtractedRecipe }> {
  if (filePaths.length === 1) {
    return extractRecipeFromFile(filePaths[0]!, config, enableGoogleFallback);
  }

  if (!config.zaiApiKey) {
    throw new Error("Missing ZAI_API_KEY. Add it to .env before running ingest.");
  }

  const ocrResults = await Promise.all(filePaths.map((filePath) => extractOcrFromFile(filePath, config, enableGoogleFallback)));
  const combinedOcr = combineOcrResults(filePaths, ocrResults);
  const recipe = await structureRecipeFromMarkdown(
    combinedOcr.markdown,
    filePaths.map((filePath) => path.basename(filePath)).join(" + "),
    config
  );

  return {
    ...combinedOcr,
    recipe
  };
}

export function evaluateReviewReasons(recipe: ExtractedRecipe, ocrMarkdown: string): string[] {
  const reasons: string[] = [];
  if (recipe.ocr_confidence === "low") {
    reasons.push("Model marked this recipe as low confidence.");
  }
  if (recipe.title.trim().length < 3) {
    reasons.push("Recipe title looks incomplete.");
  }
  if (recipe.ingredients.length < 3) {
    reasons.push("Very few ingredients were extracted.");
  }
  if (recipe.instructions.length < 2) {
    reasons.push("Very few instructions were extracted.");
  }
  if (ocrMarkdown.trim().length < 120) {
    reasons.push("OCR output was unusually short.");
  }

  const additionalTitles = findAdditionalRecipeTitles(recipe.title, ocrMarkdown);
  if (additionalTitles.length > 0) {
    reasons.push(`OCR text appears to contain more than one recipe title: ${additionalTitles.join(", ")}`);
  }

  return reasons;
}

function shouldAttemptGoogleFallback(markdown: string): boolean {
  const lowered = markdown.toLowerCase();
  return (
    markdown.trim().length < 120 ||
    lowered.includes("illegible") ||
    lowered.includes("uncertain") ||
    lowered.includes("[image]") ||
    lowered.includes("unable to read")
  );
}

async function extractOcrFromFile(
  filePath: string,
  config: RuntimeConfig,
  enableGoogleFallback: boolean
): Promise<OcrResult> {
  let ocr = await callPrimaryOcr(filePath, config);

  if (enableGoogleFallback && shouldAttemptGoogleFallback(ocr.markdown)) {
    try {
      ocr = await callGoogleVision(filePath, config);
    } catch (error) {
      console.warn(`Google Vision fallback skipped for ${path.basename(filePath)}: ${String(error)}`);
    }
  }

  return ocr;
}

function combineOcrResults(filePaths: string[], results: OcrResult[]): OcrResult {
  const combinedMarkdown = results
    .map((result, index) => {
      const label = capitalize(getScanSideLabel(filePaths[index]!, index, filePaths.length));
      return [`${label} scan`, result.markdown].join("\n");
    })
    .join("\n\n");

  return {
    provider: results[0]?.provider ?? "zai-vision",
    markdown: combinedMarkdown,
    rawResponse: results.map((result, index) => ({
      file_path: filePaths[index],
      provider: result.provider,
      raw_response: result.rawResponse,
      fallback_used: result.fallbackUsed
    })),
    fallbackUsed: results.some((result) => result.fallbackUsed)
  };
}

async function callGlmOcr(filePath: string, config: RuntimeConfig): Promise<OcrResult> {
  const buffer = await readFile(filePath);
  const mimeType = inferMimeType(filePath);
  const rawBase64 = buffer.toString("base64");

  const response = await fetch(`${config.zaiBaseUrl}/layout_parsing`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.zaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.zaiOcrModel,
      file: `data:${mimeType};base64,${rawBase64}`
    })
  });

  if (!response.ok) {
    const details = await safeJson(response);
    throw new Error(`GLM-OCR request failed with ${response.status}: ${JSON.stringify(details)}`);
  }

  const rawResponse = await response.json();
  const markdown = typeof rawResponse.md_results === "string" ? rawResponse.md_results : "";
  if (!markdown.trim()) {
    throw new Error(`GLM-OCR did not return md_results for ${path.basename(filePath)}`);
  }

  return {
    provider: "glm-ocr",
    markdown,
    rawResponse,
    fallbackUsed: false
  };
}

async function callPrimaryOcr(filePath: string, config: RuntimeConfig): Promise<OcrResult> {
  const mimeType = inferMimeType(filePath);

  if (!usesCodingPlanEndpoint(config.zaiBaseUrl)) {
    return callGlmOcr(filePath, config);
  }

  if (mimeType === "application/pdf") {
    throw new Error(
      "Z.ai Coding Plan OCR in this repo currently supports local image files only. Export PDF pages as JPG/PNG, or override ZAI_BASE_URL to the paid GLM-OCR endpoint if you need direct PDF OCR."
    );
  }

  return callZaiVisionOcr(filePath, config);
}

async function callZaiVisionOcr(filePath: string, config: RuntimeConfig): Promise<OcrResult> {
  const buffer = await readFile(filePath);
  const mimeType = inferMimeType(filePath);
  const rawBase64 = buffer.toString("base64");
  const rawResponse = await callZaiChatCompletions(config, {
    model: config.zaiVisionModel,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: [
          "You are an OCR engine for handwritten and printed recipe cards.",
          "Return only the transcription visible in the image.",
          "Preserve line breaks and reading order.",
          "Do not summarize, explain, label sections, or add markdown fences.",
          "If text is uncertain, write [unclear].",
          "If multiple recipe cards are visible, transcribe all visible text in reading order."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${rawBase64}`
            }
          },
          {
            type: "text",
            text: "Transcribe every visible word from this recipe card image. Return only the transcription."
          }
        ]
      }
    ]
  }, "Z.ai vision OCR");

  const markdown = extractVisionMarkdown(getChatCompletionText(rawResponse));
  if (!markdown.trim()) {
    throw new Error(`Z.ai vision OCR returned no transcription for ${path.basename(filePath)}`);
  }

  return {
    provider: "zai-vision",
    markdown,
    rawResponse,
    fallbackUsed: false
  };
}

export async function structureRecipeFromMarkdown(
  markdown: string,
  filePath: string,
  config: RuntimeConfig
): Promise<ExtractedRecipe> {
  const systemPrompt = [
    "You convert OCR output from handwritten and printed recipe cards into strict JSON.",
    "Preserve original wording where possible and do not invent missing content.",
    "If something is unclear, keep the field conservative and lower the ocr_confidence."
  ].join(" ");

  const userPrompt = `
Return a JSON object with exactly these keys:
- title: string
- summary: string
- ingredients: string[]
- instructions: string[]
- notes: string[]
- source_name: string
- source_family: string
- course: one of ${COURSE_VALUES.join(", ")}
- proteins: array of ${PROTEIN_VALUES.join(", ")}
- cuisine: string
- dessert: boolean
- tags: string[]
- card_type: one of ${CARD_TYPE_VALUES.join(", ")}
- ocr_confidence: one of ${OCR_CONFIDENCE_VALUES.join(", ")}

Rules:
- Do not add commentary outside JSON.
- Preserve ingredient wording from the card.
- Keep source_name and source_family as "Unknown" if the card does not say.
- Use notes for handwriting in margins, oven temperatures, yield hints, or substitutions.
- Use "other" for course or proteins only when the recipe truly does not fit a listed value.
- Set ocr_confidence to low if title, ingredients, or instructions are incomplete or uncertain.

Source file: ${path.basename(filePath)}

OCR markdown:
${markdown}
`;

  const rawResponse = await callZaiChatCompletions(config, {
    model: config.zaiStructuringModel,
    temperature: 0.1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  }, "Recipe structuring");

  const parsed = extractedRecipeSchema.parse(JSON.parse(extractJson(getChatCompletionText(rawResponse))));
  return parsed;
}

async function callGoogleVision(filePath: string, config: RuntimeConfig): Promise<OcrResult> {
  if (inferMimeType(filePath) === "application/pdf") {
    throw new Error("Google Vision fallback currently supports local image files only. Use GLM-OCR for PDFs.");
  }
  if (!config.googleCredentialsPath || !config.googleCloudProject) {
    throw new Error("Missing Google Vision credentials. Set GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_CLOUD_PROJECT.");
  }

  const accessToken = await getGoogleAccessToken(config.googleCredentialsPath);
  const buffer = await readFile(filePath);
  const body = {
    requests: [
      {
        image: {
          content: buffer.toString("base64")
        },
        features: [
          {
            type: "DOCUMENT_TEXT_DETECTION"
          }
        ]
      }
    ]
  };

  const response = await fetch("https://vision.googleapis.com/v1/images:annotate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "x-goog-user-project": config.googleCloudProject
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const details = await safeJson(response);
    throw new Error(`Google Vision request failed with ${response.status}: ${JSON.stringify(details)}`);
  }

  const rawResponse = await response.json();
  const markdown = rawResponse.responses?.[0]?.fullTextAnnotation?.text || "";
  if (!markdown.trim()) {
    throw new Error("Google Vision returned no OCR text.");
  }

  return {
    provider: "google-vision",
    markdown,
    rawResponse,
    fallbackUsed: true
  };
}

async function getGoogleAccessToken(credentialsPath: string): Promise<string> {
  const credentials = await readJson<{
    client_email: string;
    private_key: string;
    token_uri?: string;
  }>(credentialsPath);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: credentials.token_uri || "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedClaimSet = base64Url(JSON.stringify(claimSet));
  const signer = createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedClaimSet}`);
  signer.end();

  const signature = signer.sign(credentials.private_key, "base64url");
  const assertion = `${encodedHeader}.${encodedClaimSet}.${signature}`;
  const response = await fetch(claimSet.aud, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  if (!response.ok) {
    const details = await safeJson(response);
    throw new Error(`Failed to obtain Google access token: ${JSON.stringify(details)}`);
  }

  const rawResponse = await response.json();
  if (typeof rawResponse.access_token !== "string") {
    throw new Error("Google access token response did not include access_token.");
  }

  return rawResponse.access_token;
}

function extractJson(content: string): string {
  const fenced = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start !== -1 && end !== -1) {
    return content.slice(start, end + 1);
  }

  throw new Error(`Unable to parse JSON from model response: ${content}`);
}

function base64Url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

function usesCodingPlanEndpoint(baseUrl: string): boolean {
  return baseUrl.includes("/api/coding/paas/v4");
}

async function callZaiChatCompletions(
  config: RuntimeConfig,
  body: object,
  operationName: string
): Promise<any> {
  const url = `${config.zaiBaseUrl}/chat/completions`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.zaiApiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Vicki Recipe Archive"
      },
      body: JSON.stringify(body)
    });

    if (response.ok) {
      return response.json();
    }

    const details = await safeJson(response);
    if (!isRetryableZaiStatus(response.status) || attempt === 2) {
      throw new Error(`${operationName} failed with ${response.status}: ${JSON.stringify(details)}`);
    }

    const retryDelayMs = 1000 * (attempt + 1);
    console.warn(`${operationName} returned ${response.status}; retrying in ${retryDelayMs}ms`);
    await sleep(retryDelayMs);
  }

  throw new Error(`${operationName} failed after retries.`);
}

function getChatCompletionText(rawResponse: any): string {
  const content = rawResponse?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }

        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return String(content ?? "");
}

export function extractVisionMarkdown(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const extractedFence =
    normalized.match(/\*\*Extracted Text\*\*\s*```(?:\w+)?\s*([\s\S]*?)```/i) ||
    normalized.match(/^```(?:\w+)?\s*([\s\S]*?)```$/);
  if (extractedFence?.[1]) {
    return extractedFence[1].trim();
  }

  const extractedSection = normalized.match(
    /\*\*Extracted Text\*\*\s*:?\s*([\s\S]*?)(?:\n\s*\*\*[A-Z][\s\S]*?\*\*|$)/i
  );
  if (extractedSection?.[1]) {
    return extractedSection[1].trim();
  }

  return normalized;
}

function findAdditionalRecipeTitles(recipeTitle: string, ocrMarkdown: string): string[] {
  const normalizedTitle = normalizeTitleCandidate(recipeTitle);
  return detectRecipeSections(ocrMarkdown)
    .map((section) => section.title)
    .filter((title) => normalizeTitleCandidate(title) !== normalizedTitle);
}

export function detectRecipeSections(ocrMarkdown: string): RecipeOcrSection[] {
  const lines = ocrMarkdown.replace(/\r\n/g, "\n").split("\n");
  const candidates: Array<{ index: number; title: string; normalized: string }> = [];
  const seen = new Set<string>();

  for (const [index, line] of lines.entries()) {
    const candidate = line.trim();
    if (!isRecipeTitleCandidate(candidate)) {
      continue;
    }

    const normalized = normalizeTitleCandidate(candidate);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    candidates.push({ index, title: candidate, normalized });
  }

  return candidates
    .map((candidate, index) => {
      const endIndexExclusive = index + 1 < candidates.length ? candidates[index + 1].index : lines.length;
      const sectionLines = trimBlankLines(lines.slice(candidate.index, endIndexExclusive));
      return {
        title: candidate.title,
        markdown: sectionLines.join("\n").trim(),
        startLine: candidate.index + 1,
        endLine: endIndexExclusive
      };
    })
    .filter((section) => section.markdown.length > 0);
}

function isRecipeTitleCandidate(line: string): boolean {
  if (line.length < 6 || line.length > 40) {
    return false;
  }

  if (/[0-9]/.test(line) || /[():,+#]/.test(line)) {
    return false;
  }

  if (!/^[A-Za-z'& -]+$/.test(line)) {
    return false;
  }

  if (/\b(recipe|kitchen|serves|prep|cook|bake|ingredient|instruction)\b/i.test(line)) {
    return false;
  }

  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) {
    return false;
  }

  const titleCaseWords = words.filter((word) => /^[A-Z][A-Za-z'&-]*$/.test(word));
  return titleCaseWords.length >= Math.max(2, words.length - 1);
}

function normalizeTitleCandidate(line: string): string {
  return line.trim().toLowerCase().replace(/\s+/g, " ");
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && !lines[start]?.trim()) {
    start += 1;
  }

  while (end > start && !lines[end - 1]?.trim()) {
    end -= 1;
  }

  return lines.slice(start, end);
}

function isRetryableZaiStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}
