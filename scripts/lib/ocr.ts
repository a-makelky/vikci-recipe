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

export interface OcrResult {
  provider: "glm-ocr" | "google-vision";
  markdown: string;
  rawResponse: unknown;
  fallbackUsed: boolean;
}

export async function extractRecipeFromFile(
  filePath: string,
  config: RuntimeConfig,
  enableGoogleFallback: boolean
): Promise<OcrResult & { recipe: ExtractedRecipe }> {
  if (!config.zaiApiKey) {
    throw new Error("Missing ZAI_API_KEY. Add it to .env before running ingest.");
  }

  let ocr = await callGlmOcr(filePath, config);

  if (enableGoogleFallback && shouldAttemptGoogleFallback(ocr.markdown)) {
    try {
      ocr = await callGoogleVision(filePath, config);
    } catch (error) {
      console.warn(`Google Vision fallback skipped for ${path.basename(filePath)}: ${String(error)}`);
    }
  }

  const recipe = await structureRecipe(ocr.markdown, filePath, config);
  return { ...ocr, recipe };
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

async function structureRecipe(markdown: string, filePath: string, config: RuntimeConfig): Promise<ExtractedRecipe> {
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

  const response = await fetch(`${config.zaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.zaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.zaiStructuringModel,
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const details = await safeJson(response);
    throw new Error(`Recipe structuring failed with ${response.status}: ${JSON.stringify(details)}`);
  }

  const rawResponse = await response.json();
  const content = rawResponse.choices?.[0]?.message?.content;
  const parsed = extractedRecipeSchema.parse(JSON.parse(extractJson(String(content))));
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
