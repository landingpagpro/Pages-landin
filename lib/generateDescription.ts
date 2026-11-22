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
  usedWebSearch: boolean;
}

interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
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

function decodeXmlEntities(str: string): string {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function buildDirectSearchPrompts(lang: SupportedLang, hintName: string): { systemInstruction: string; userPrompt: string } {
  const languageLabel =
    lang === "ar" ? "Arabic (العربية الفصحى التسويقية الواضحة)" : lang === "fr" ? "French (Français)" : "English";

  const productHint = hintName
    ? `\nUser's optional product title hint: "${hintName}". Always verify directly against the uploaded image first.`
    : "";

  const systemInstruction = [
    "You are an expert e-commerce product researcher and conversion copywriter.",
    "The uploaded photo is the primary source of truth. Carefully inspect the product in the photo, then use Google Search to search across e-commerce platforms and the web (Google, AliExpress, Alibaba, Pinterest, Amazon, and official brand stores) to find matching product listings and real descriptions.",
    `Write the entire output strictly in ${languageLabel}. Never mix languages (only keep exact brand/model names if standard).`,
    "Synthesize a compelling, accurate landing page description based on the real product descriptions found on the web. Do not include markdown URLs, citation brackets like [1], or HTML tags.",
  ].join(" ");

  const userPrompt = [
    `Identify the exact product visible in this image and search the web (Google, AliExpress, Alibaba, Pinterest, Amazon, and retail stores) for matching product descriptions and real specifications.${productHint}`,
    `Write everything strictly in ${languageLabel} using this exact format:`,
    "PRODUCT_NAME: <concise, accurate commercial product name>",
    "DESCRIPTION:",
    "<1-2 compelling opening lines explaining what the product is and its main benefit>",
    "",
    "<4-6 concise bullet points starting with • where each bullet has a **bold label** and real specs/benefits from the web listings>",
    "",
    "<1 short persuasive closing line highlighting quality and readiness to order>",
  ].join("\n");

  return { systemInstruction, userPrompt };
}

function getUpstreamErrorDetails(err: unknown): { status: number; code: string; rawMsg: string } {
  const rawMsg = err instanceof Error ? err.message : String(err);
  const directStatus = typeof (err as { status?: unknown })?.status === "number"
    ? (err as { status: number }).status
    : 0;

  let status = directStatus || 500;
  let code = "";

  try {
    const parsed = JSON.parse(rawMsg) as { error?: { code?: number; status?: string; message?: string } };
    if (parsed && parsed.error) {
      if (typeof parsed.error.code === "number") status = parsed.error.code;
      if (typeof parsed.error.status === "string") code = parsed.error.status;
    }
  } catch {
    if (/429|RESOURCE_EXHAUSTED|quota/i.test(rawMsg)) {
      status = 429;
      code = "RESOURCE_EXHAUSTED";
    } else if (/403|PERMISSION_DENIED/i.test(rawMsg)) {
      status = 403;
      code = "PERMISSION_DENIED";
    } else if (/400|API_KEY_INVALID/i.test(rawMsg)) {
      status = 400;
      code = "API_KEY_INVALID";
    }
  }

  return { status, code, rawMsg };
}

async function fetchBingRssResults(query: string, keywords: string[]): Promise<WebSearchItem[]> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(
      `https://www.bing.com/search?format=rss&q=${encodeURIComponent(cleanQuery)}`,
      {
        signal: controller.signal,
        headers: {
          "Accept": "application/rss+xml, application/xml, text/xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      }
    );
    clearTimeout(timer);

    if (!resp.ok) return [];
    const xml = await resp.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
    const parsed: WebSearchItem[] = [];

    for (const m of items) {
      const title = decodeXmlEntities((m[1].match(/<title>([\s\S]*?)<\/title>/i) || [, ""])[1]);
      const rawLink = decodeXmlEntities((m[1].match(/<link>([\s\S]*?)<\/link>/i) || [, ""])[1]);
      const snippet = decodeXmlEntities((m[1].match(/<description>([\s\S]*?)<\/description>/i) || [, ""])[1]);
      const safeUrl = sanitizeHttpUrl(rawLink);
      if (!safeUrl || !title) continue;

      try {
        const u = new URL(safeUrl);
        if (u.pathname === "/" && !u.search) continue; // skip generic root homepages
      } catch {
        continue;
      }

      if (keywords.length > 0) {
        const haystack = `${title} ${snippet} ${safeUrl}`.toLowerCase();
        const matchesCount = keywords.filter((kw) => haystack.includes(kw)).length;
        const minNeeded = keywords.length >= 2 ? 2 : 1;
        if (matchesCount < minNeeded) continue;
      }

      parsed.push({ title, url: safeUrl, snippet });
      if (parsed.length >= 5) break;
    }

    return parsed;
  } catch {
    return [];
  }
}

async function searchWebForProduct(productQuery: string): Promise<WebSearchItem[]> {
  const stopWords = new Set(["the", "and", "for", "with", "new", "pro", "hot", "sale", "best", "free", "shipping", "product"]);
  const keywords = productQuery
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w))
    .slice(0, 6);

  const queries = [
    productQuery,
    `${productQuery} product features description`,
    `${productQuery} amazon aliexpress alibaba pinterest`,
  ];

  const batches = await Promise.all(queries.map((q) => fetchBingRssResults(q, keywords)));
  const merged: WebSearchItem[] = [];
  const seenUrls = new Set<string>();

  for (const batch of batches) {
    for (const item of batch) {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        merged.push(item);
      }
      if (merged.length >= 6) break;
    }
    if (merged.length >= 6) break;
  }

  return merged;
}

async function identifyProductFromImage(
  ai: GoogleGenAI,
  imagePart: { inlineData: { mimeType: string; data: string } },
  hintName: string
): Promise<{ productName: string; searchQuery: string }> {
  const modelsToTry = ["gemini-3.1-flash-lite", "gemini-4-hydrogen"];
  const prompt = [
    "Look closely at this product photo.",
    hintName ? `Optional user note: "${hintName}" (trust what you visually see in the photo above all).` : "",
    "Identify the exact commercial product, brand, model, or product type.",
    "Return ONLY two lines in this exact format:",
    "NAME: <concise product name>",
    "SEARCH_QUERY: <3 to 7 clean English keywords to search this exact product on Google, AliExpress, Alibaba, Pinterest, and Amazon>",
  ]
    .filter(Boolean)
    .join("\n");

  for (const model of modelsToTry) {
    try {
      const resp = await ai.models.generateContent({
        model,
        contents: { parts: [imagePart, { text: prompt }] },
      });
      const text = (resp.text || "").trim();
      const nameMatch = text.match(/^NAME\s*:\s*(.+)$/im);
      const queryMatch = text.match(/^SEARCH_QUERY\s*:\s*(.+)$/im);
      const productName = nameMatch && nameMatch[1] ? nameMatch[1].trim() : "";
      const searchQuery = queryMatch && queryMatch[1] ? queryMatch[1].trim() : productName;
      if (searchQuery) {
        return { productName: productName || searchQuery, searchQuery };
      }
    } catch {
      /* Try next model */
    }
  }

  return { productName: hintName, searchQuery: hintName };
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
  const imagePart = {
    inlineData: {
      mimeType: parsedImage.mimeType,
      data: parsedImage.data,
    },
  };

  let lastError: unknown = null;

  // Step 1: Try native Google Search Grounding directly on multimodal models
  const groundingModels = ["gemini-4-hydrogen", "gemini-3.1-flash-lite"];
  for (const model of groundingModels) {
    try {
      const { systemInstruction, userPrompt } = buildDirectSearchPrompts(lang, hintName);
      const response = await ai.models.generateContent({
        model,
        contents: { parts: [imagePart, { text: userPrompt }] },
        config: { systemInstruction, tools: [{ googleSearch: {} }] },
      });

      const rawText = response.text || "";
      const parsed = parseStructuredAiText(rawText);
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
          if (sources.length >= 6) break;
        }
      }

      if (parsed.description && sources.length > 0) {
        return {
          productName: parsed.productName,
          description: parsed.description,
          sources,
          usedWebSearch: true,
        };
      }
    } catch (err: unknown) {
      lastError = err;
      const info = getUpstreamErrorDetails(err);
      if (info.status === 403 || (info.status === 400 && info.code === "API_KEY_INVALID")) {
        throw new GenerateDescError(
          info.status,
          "INVALID_API_KEY",
          "Invalid or unauthorized Gemini API key. Please check Settings > Secrets."
        );
      }
    }
  }

  // Step 2: 2-Stage Visual Identification + Multi-Source Web Search (Google/Bing, AliExpress, Alibaba, Pinterest, Amazon)
  try {
    const identified = await identifyProductFromImage(ai, imagePart, hintName);
    const webItems = identified.searchQuery ? await searchWebForProduct(identified.searchQuery) : [];

    const languageLabel =
      lang === "ar" ? "Arabic (العربية الفصحى التسويقية الواضحة)" : lang === "fr" ? "French (Français)" : "English";

    const webContext = webItems.length > 0
      ? webItems
          .map((item, idx) => `[${idx + 1}] ${item.title}\nSource: ${item.url}\nSnippet: ${item.snippet}`)
          .join("\n\n")
      : "";

    const synthesisPrompt = [
      `Analyze this product photo${identified.productName ? ` (identified as: ${identified.productName})` : ""}.`,
      webContext
        ? `Below are real product listings and descriptions found on the web for this product:\n\n${webContext}\n\nSynthesize a professional e-commerce landing page description using the real specs, materials, and benefits found in these web listings alongside what is visible in the photo.`
        : "Inspect all details visible in the photo and write an accurate, persuasive commercial description.",
      `Write everything strictly in ${languageLabel} using this exact format:`,
      "PRODUCT_NAME: <concise, accurate commercial product name>",
      "DESCRIPTION:",
      "<1-2 compelling opening lines explaining what the product is and its main benefit>",
      "",
      "<4-6 concise bullet points starting with • where each bullet has a **bold label** and real specs/benefits>",
      "",
      "<1 short persuasive closing line highlighting quality and readiness to order>",
    ].join("\n\n");

    const synthSystem = [
      "You are an expert e-commerce product researcher and conversion copywriter.",
      `Write the entire output strictly in ${languageLabel}. Never mix languages (except standard brand/model names).`,
      "Do not include markdown links, URLs, bracketed citations like [1], or HTML tags.",
    ].join(" ");

    const synthModels = ["gemini-3.1-flash-lite", "gemini-4-hydrogen"];
    for (const model of synthModels) {
      try {
        const resp = await ai.models.generateContent({
          model,
          contents: { parts: [imagePart, { text: synthesisPrompt }] },
          config: { systemInstruction: synthSystem },
        });
        const parsed = parseStructuredAiText(resp.text || "");
        if (parsed.description) {
          return {
            productName: parsed.productName || identified.productName,
            description: parsed.description,
            sources: webItems.map((w) => ({ title: w.title, url: w.url })),
            usedWebSearch: webItems.length > 0,
          };
        }
      } catch (err: unknown) {
        lastError = err;
      }
    }
  } catch (err: unknown) {
    lastError = err;
  }

  const finalInfo = getUpstreamErrorDetails(lastError);
  if (finalInfo.status === 429 || finalInfo.code === "RESOURCE_EXHAUSTED") {
    throw new GenerateDescError(
      429,
      "QUOTA_EXCEEDED",
      "Gemini API quota exceeded for the current key. Please check your plan or select a billing-enabled API key in Settings > Secrets."
    );
  }
  if (finalInfo.status === 403 || finalInfo.code === "PERMISSION_DENIED" || finalInfo.code === "API_KEY_INVALID") {
    throw new GenerateDescError(
      finalInfo.status,
      "INVALID_API_KEY",
      "Invalid or unauthorized Gemini API key. Please check Settings > Secrets."
    );
  }

  throw new GenerateDescError(
    502,
    "GENERATION_FAILED",
    "Could not generate description right now. Please try again."
  );
}
