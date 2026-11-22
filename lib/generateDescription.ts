import { GoogleGenAI } from "@google/genai";

const MAX_IMAGE_BASE64_LEN = 11_000_000;

export type SupportedLang = "en" | "ar" | "fr";

export interface GenerateDescInput {
  imageDataUrl?: unknown;
  lang?: unknown;
  productName?: unknown;
}

export interface GroundingSource {
  title: string;
  url: string;
}

export interface GenerateDescResult {
  productName: string;
  description: string;
  sources: GroundingSource[];
}

export class GenerateDescError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    throw new GenerateDescError(
      500,
      "MISSING_API_KEY",
      "Gemini API key is not configured in Settings > Secrets (or Vercel Environment Variables)."
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function parseImageDataUrl(raw: string): { mimeType: string; data: string } | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  const data = match[2].replace(/\s+/g, "");
  if (!data || data.length > MAX_IMAGE_BASE64_LEN) return null;
  return { mimeType, data };
}

function sanitizeHttpUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function parseStructuredAiText(rawText: string): { productName: string; description: string } {
  const text = (rawText || "").trim();
  if (!text) {
    return { productName: "", description: "" };
  }

  let extractedName = "";
  let extractedDesc = text;

  const nameMatch = text.match(/^(?:\*\*)?PRODUCT_NAME\s*:(?:\*\*)?\s*(.+)$/im);
  if (nameMatch && nameMatch[1]) {
    extractedName = nameMatch[1].replace(/^\*+|\*+$/g, "").trim();
  }

  const descMarkerMatch = text.match(/(?:^|\n)(?:\*\*)?DESCRIPTION\s*:(?:\*\*)?\s*\n?([\s\S]+)$/i);
  if (descMarkerMatch && descMarkerMatch[1]) {
    extractedDesc = descMarkerMatch[1].trim();
  } else if (nameMatch) {
    extractedDesc = text.replace(nameMatch[0], "").trim();
  }

  return {
    productName: extractedName,
    description: extractedDesc,
  };
}

function buildPrompts(lang: SupportedLang, hintName: string): { systemInstruction: string; userPrompt: string } {
  const languageLabel =
    lang === "ar" ? "Arabic (العربية الفصحى التسويقية الواضحة)" : lang === "fr" ? "French (Français)" : "English";

  const productHint = hintName
    ? `\nUser's optional product title hint: "${hintName}". Use the image + Google Search to verify and enrich exact details.`
    : "";

  const systemInstruction = [
    "You are an expert e-commerce product researcher and conversion copywriter.",
    "Always inspect the provided product image carefully (brand, model, packaging, visual features) and use Google Search to verify real product details, specifications, and authentic benefits.",
    `Write the entire output strictly in ${languageLabel}. Never mix languages (only keep exact brand/model names if standard).`,
    "Do not invent false specs that contradict what is visible or found via search. Do not include markdown URLs, source citations brackets like [1], or HTML tags.",
  ].join(" ");

  const userPrompt = [
    `Identify the exact product in this photo and search the web for its real specifications, key features, and benefits.${productHint}`,
    `Write everything strictly in ${languageLabel} using this exact format:`,
    "PRODUCT_NAME: <concise, accurate commercial product name>",
    "DESCRIPTION:",
    "<1-2 compelling opening lines explaining what the product is and its main benefit>",
    "",
    "<4-6 concise bullet points starting with • where each bullet has a **bold label** and real specs/benefits discovered from the image and web search>",
    "",
    "<1 short persuasive closing line highlighting quality and readiness to order>",
  ].join("\n");

  return { systemInstruction, userPrompt };
}

export async function generateDescriptionFromImage(input: GenerateDescInput): Promise<GenerateDescResult> {
  const rawImage = typeof input.imageDataUrl === "string" ? input.imageDataUrl : "";
  const parsedImage = parseImageDataUrl(rawImage);

  if (!parsedImage) {
    throw new GenerateDescError(400, "INVALID_IMAGE", "Please provide a valid product image.");
  }

  const rawLang = typeof input.lang === "string" ? input.lang : "en";
  const lang: SupportedLang = rawLang === "ar" || rawLang === "fr" ? rawLang : "en";
  const hintName = typeof input.productName === "string" ? input.productName.trim().slice(0, 180) : "";

  const ai = getGeminiClient();
  const { systemInstruction, userPrompt } = buildPrompts(lang, hintName);

  const response = await ai.models.generateContent({
    model: "gemini-4-hydrogen",
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: parsedImage.mimeType,
            data: parsedImage.data,
          },
        },
        { text: userPrompt },
      ],
    },
    config: {
      systemInstruction,
      tools: [{ googleSearch: {} }],
    },
  });

  const rawText = response.text || "";
  const parsed = parseStructuredAiText(rawText);

  if (!parsed.description) {
    throw new GenerateDescError(
      502,
      "EMPTY_RESPONSE",
      "Could not generate a description from this image. Please try another photo."
    );
  }

  const rawChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
  const sources: GroundingSource[] = [];
  const seenUrls = new Set<string>();

  if (Array.isArray(rawChunks)) {
    for (const chunk of rawChunks) {
      const web = (chunk as { web?: { uri?: string; title?: string } }).web;
      if (web && typeof web.uri === "string") {
        const safeUrl = sanitizeHttpUrl(web.uri);
        if (safeUrl && !seenUrls.has(safeUrl)) {
          seenUrls.add(safeUrl);
          sources.push({
            title: typeof web.title === "string" && web.title.trim() ? web.title.trim() : safeUrl,
            url: safeUrl,
          });
        }
      }
      if (sources.length >= 5) break;
    }
  }

  return {
    productName: parsed.productName,
    description: parsed.description,
    sources,
  };
}
