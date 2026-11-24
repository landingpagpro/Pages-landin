import crypto from "node:crypto";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

const MAX_IMAGE_BASE64_LEN = 11_000_000;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 120;

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
  usedSimilarProducts?: boolean;
}

interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

interface CacheEntry {
  result: GenerateDescResult;
  expiresAt: number;
}

const resultCache = new Map<string, CacheEntry>();
const inFlightRequests = new Map<string, Promise<GenerateDescResult>>();

export class GenerateDescError extends Error {
  statusCode: number;
  code: string;
  sources?: GroundingSource[];

  constructor(statusCode: number, code: string, message: string, sources?: GroundingSource[]) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    if (sources && sources.length > 0) {
      this.sources = sources;
    }
  }
}

function getGeminiApiKeys(): string[] {
  const rawSources = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEYS,
    process.env.GEMINI_API_KEY_BACKUP,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ];

  const keys: string[] = [];
  const seen = new Set<string>();

  for (const src of rawSources) {
    if (!src) continue;
    const parts = src.split(/[\s,;]+/);
    for (const part of parts) {
      const cleaned = part.trim();
      if (!cleaned || cleaned === "MY_GEMINI_API_KEY" || seen.has(cleaned)) continue;
      seen.add(cleaned);
      keys.push(cleaned);
    }
  }

  if (keys.length === 0) {
    throw new GenerateDescError(
      500,
      "MISSING_API_KEY",
      "Gemini API key is not configured in Settings > Secrets (or Vercel Environment Variables)."
    );
  }

  return keys;
}

function createGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function buildCacheKey(lang: SupportedLang, hintName: string, mimeType: string, base64Data: string): string {
  return crypto
    .createHash("sha256")
    .update(lang)
    .update("|")
    .update(hintName.toLowerCase())
    .update("|")
    .update(mimeType)
    .update("|")
    .update(base64Data)
    .digest("hex");
}

function getCachedResult(cacheKey: string): GenerateDescResult | null {
  const entry = resultCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    resultCache.delete(cacheKey);
    return null;
  }
  return entry.result;
}

function setCachedResult(cacheKey: string, result: GenerateDescResult): void {
  if (resultCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = resultCache.keys().next().value;
    if (oldestKey) resultCache.delete(oldestKey);
  }
  resultCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + CACHE_TTL_MS,
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

function buildStructuredDescFormatInstructions(lang: SupportedLang): string {
  if (lang === "ar") {
    return [
      "اكتب كامل المخرجات باللغة العربية الفصحى التسويقية الغنية والواضحة باستخدام هذا القالب المنظم تماماً (اجعل الوصف غنياً ومفصلاً ومقنعاً للمشتري بطول إجمالي يقارب 220 إلى 350 كلمة عبر الأقسام الخمسة كلها بالترتيب):",
      "PRODUCT_NAME: <اسم تجاري مختصر ودقيق للمنتج>",
      "DESCRIPTION:",
      "**📌 تعريف بالمنتج:**",
      "<فقرة تسويقية غنية من 2 إلى 4 جمل تشرح بوضوح ماهية المنتج، جودته وتصميمه، لمن يناسب، ولماذا يعد خياراً مثالياً للاستخدام اليومي>",
      "",
      "**✨ المميزات:**",
      "• <ميزة 1: عنوان فرعي قصير مع شرح وافٍ للخاصية أو التقنية>",
      "• <ميزة 2: عنوان فرعي قصير مع شرح وافٍ للتصميم أو الأداء>",
      "• <ميزة 3: عنوان فرعي قصير مع شرح وافٍ للمتانة أو الجودة>",
      "• <ميزة 4: ميزة إضافية مهمة مستخلصة من المواصفات أو الصورة>",
      "",
      "**💡 الفوائد:**",
      "• <فائدة 1: النتيجة الفعلية والقيمة التي يحصل عليها الزبون في حياته اليومية>",
      "• <فائدة 2: كيف يحل المنتج مشكلة حقيقية أو يوفر الوقت والجهد>",
      "• <فائدة 3: راحة وأمان ونتائج ملموسة تدوم طويلاً>",
      "• <فائدة 4: قيمة إضافية تعزز ثقة الزبون عند الشراء>",
      "",
      "**📋 طريقة الاستعمال:**",
      "• <الخطوة 1: شرح واضح ومفصل لبداية الاستخدام أو التحضير>",
      "• <الخطوة 2: طريقة الاستخدام أو التشغيل الصحيحة خطوة بخطوة>",
      "• <الخطوة 3: نصيحة عملية أو عناية إضافية لتحقيق أفضل نتيجة ممكنة>",
      "",
      "**🧪 المكونات:**",
      "• <المكون/العنصر 1: ذكر المكونات والتركيبة الفعلية ودورها إذا كان منتجاً تجميلياً أو صحياً أو غذائياً أو عطراً، أو المواد المصنّعة عالية الجودة ومحتويات العلبة والمواصفات الفنية إذا كان جهازاً أو إكسسواراً>",
      "• <المكون/العنصر 2: تفاصيل إضافية دقيقة دون اختراع أي مواد كيميائية غير حقيقية>",
      "• <المكون/العنصر 3: بقية المحتويات المرفقة في العلبة أو الخصائص المادية للمنتج>",
    ].join("\n");
  }
  if (lang === "fr") {
    return [
      "Rédigez tout strictement en français riche, détaillé et persuasif en suivant exactement cette structure (visez environ 220 à 350 mots au total répartis sur les 5 sections dans l'ordre) :",
      "PRODUCT_NAME: <nom commercial concis et précis du produit>",
      "DESCRIPTION:",
      "**📌 Présentation du produit :**",
      "<Paragraphe complet de 2 à 4 phrases présentant clairement le produit, sa conception, à qui il s'adresse et sa valeur ajoutée>",
      "",
      "**✨ Caractéristiques :**",
      "• <Caractéristique 1 : titre court + explication détaillée technique ou de fabrication>",
      "• <Caractéristique 2 : titre court + détail sur la performance ou le design>",
      "• <Caractéristique 3 : titre court + détail sur la qualité ou la praticité>",
      "• <Caractéristique 4 : atout supplémentaire tiré des spécifications ou de l'image>",
      "",
      "**💡 Avantages :**",
      "• <Avantage 1 : résultat concret et valeur réelle au quotidien>",
      "• <Avantage 2 : problème résolu ou gain de temps et de confort>",
      "• <Avantage 3 : durabilité, fiabilité et satisfaction à long terme>",
      "• <Avantage 4 : argument convaincant supplémentaire pour l'acheteur>",
      "",
      "**📋 Mode d'emploi :**",
      "• <Étape 1 : préparation ou mise en route détaillée>",
      "• <Étape 2 : utilisation étape par étape simple et précise>",
      "• <Étape 3 : conseil pratique ou d'entretien pour un résultat optimal>",
      "",
      "**🧪 Ingrédients et composition :**",
      "• <Élément 1 : ingrédients/formule réels et leur rôle pour cosmétiques, soins, parfums ou alimentation, OU matériaux, spécifications et contenu complet du coffret pour appareils/accessoires>",
      "• <Élément 2 : précisions complémentaires sans inventer de composants fictifs>",
      "• <Élément 3 : éléments inclus dans la boîte ou finitions matérielles>",
    ].join("\n");
  }
  return [
    "Write everything strictly in rich, detailed, high-converting English using this exact structured format (aim for a thorough 220–350 words across ALL 5 sections in order):",
    "PRODUCT_NAME: <concise, accurate commercial product name>",
    "DESCRIPTION:",
    "**📌 Product Overview:**",
    "<A rich 2–4 sentence introduction clearly explaining what the product is, its build quality, who it is designed for, and why buyers love it>",
    "",
    "**✨ Key Features:**",
    "• <Feature 1: short bold-style label and thorough explanation of spec or design>",
    "• <Feature 2: detailed performance or craftsmanship highlight>",
    "• <Feature 3: practical engineering or usability detail>",
    "• <Feature 4: additional standout specification visible or verified>",
    "",
    "**💡 Benefits:**",
    "• <Benefit 1: tangible everyday result and customer value>",
    "• <Benefit 2: how it saves time, effort, or solves a real pain point>",
    "• <Benefit 3: long-lasting comfort, reliability, and peace of mind>",
    "• <Benefit 4: strong conversion point highlighting overall value>",
    "",
    "**📋 How to Use:**",
    "• <Step 1: clear preparation or setup instruction>",
    "• <Step 2: detailed step-by-step usage guidance>",
    "• <Step 3: best-practice care or usage tip for optimal results>",
    "",
    "**🧪 Ingredients & Contents:**",
    "• <Item 1: real active ingredients/formula and role if skincare, cosmetics, food, health, or fragrance — OR real materials, technical specs, and full box contents if electronics, accessories, or homeware>",
    "• <Item 2: verified additional components or materials without fabricating fake chemicals>",
    "• <Item 3: included accessories or finish details>",
  ].join("\n");
}

function buildDirectSearchPrompts(lang: SupportedLang, hintName: string): { systemInstruction: string; userPrompt: string } {
  const languageLabel =
    lang === "ar" ? "Arabic (العربية الفصحى التسويقية الغنية والواضحة)" : lang === "fr" ? "French (Français)" : "English";

  const productHint = hintName
    ? `\nUser's optional product title hint: "${hintName}". Always verify directly against the uploaded image first.`
    : "";

  const systemInstruction = [
    "You are an expert e-commerce product researcher and conversion copywriter.",
    "The uploaded photo is the primary source of truth. Carefully inspect the product in the photo, then use Google Search to search across e-commerce platforms and the web (Google, AliExpress, Alibaba, Pinterest, Amazon, and official brand stores) to find matching product listings, real ingredients/materials, how-to-use instructions, features, and benefits.",
    "If the exact product or brand cannot be found online (for example, unbranded, local, custom, or rare products), immediately search for closely similar products in the same category, style, material, and function, and synthesize a structured persuasive description from those similar products combined with the visual details in the photo.",
    "Never refuse or apologize that the exact product was not found.",
    `Write the entire output strictly in ${languageLabel}. Never mix languages (only keep exact brand/model names if standard).`,
    "Write a thorough, rich, high-converting landing page description (around 220 to 350 words) organized into the 5 required sections: Product Overview, Features, Benefits, How to Use, and Ingredients/Contents. Avoid overly brief or superficial one-line answers. Do not include markdown URLs, citation brackets like [1], or HTML tags.",
  ].join(" ");

  const userPrompt = [
    `Identify the product visible in this image and search the web (Google, AliExpress, Alibaba, Pinterest, Amazon, and retail stores) for its full product definition, detailed features, customer benefits, step-by-step usage instructions, and ingredients/materials/contents. If the exact product is not found, search for closely similar products in the same category and generate a complete, rich 5-section commercial description modeled after them and what is visible in the photo.${productHint}`,
    buildStructuredDescFormatInstructions(lang),
  ].join("\n\n");

  return { systemInstruction, userPrompt };
}

interface ErrorDetails {
  status: number;
  code: string;
  rawMsg: string;
  isDailyOrZeroQuota: boolean;
  isTransientRateLimit: boolean;
}

function getUpstreamErrorDetails(err: unknown): ErrorDetails {
  const rawMsg = err instanceof Error ? err.message : String(err);
  const directStatus = typeof (err as { status?: unknown })?.status === "number"
    ? (err as { status: number }).status
    : 0;

  let status = directStatus || 500;
  let code = "";
  let parsedMessage = rawMsg;

  try {
    const parsed = JSON.parse(rawMsg) as { error?: { code?: number; status?: string; message?: string } };
    if (parsed && parsed.error) {
      if (typeof parsed.error.code === "number") status = parsed.error.code;
      if (typeof parsed.error.status === "string") code = parsed.error.status;
      if (typeof parsed.error.message === "string") parsedMessage = parsed.error.message;
    }
  } catch {
    if (/429|RESOURCE_EXHAUSTED|quota/i.test(rawMsg)) {
      status = 429;
      code = "RESOURCE_EXHAUSTED";
    } else if (/503|UNAVAILABLE|overloaded/i.test(rawMsg)) {
      status = 503;
      code = "UNAVAILABLE";
    } else if (/403|PERMISSION_DENIED/i.test(rawMsg)) {
      status = 403;
      code = "PERMISSION_DENIED";
    } else if (/400|API_KEY_INVALID/i.test(rawMsg)) {
      status = 400;
      code = "API_KEY_INVALID";
    }
  }

  const combined = `${code} ${parsedMessage} ${rawMsg}`;
  const isDailyOrZeroQuota = /PerDay|limit:\s*0|daily|free_tier_requests.*limit:\s*0|billing/i.test(combined);
  const isQuotaError = status === 429 || code === "RESOURCE_EXHAUSTED" || /RESOURCE_EXHAUSTED|quota/i.test(combined);
  const isTransientRateLimit =
    status === 503 ||
    code === "UNAVAILABLE" ||
    (isQuotaError && !isDailyOrZeroQuota);

  return {
    status,
    code,
    rawMsg: parsedMessage,
    isDailyOrZeroQuota,
    isTransientRateLimit,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGenerateContentWithRetry(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI["models"]["generateContent"]>[0],
  allowBackoffRetry = true
) {
  const maxAttempts = allowBackoffRetry ? 2 : 1;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err: unknown) {
      lastErr = err;
      const details = getUpstreamErrorDetails(err);

      // Fail fast on invalid/unauthorized key or hard daily limit so we can immediately rotate model or key
      if (
        details.status === 403 ||
        details.code === "PERMISSION_DENIED" ||
        details.code === "API_KEY_INVALID" ||
        details.isDailyOrZeroQuota
      ) {
        throw err;
      }

      if (details.isTransientRateLimit && attempt < maxAttempts - 1) {
        const jitterMs = Math.floor(Math.random() * 350);
        await sleep(950 * Math.pow(2, attempt) + jitterMs);
        continue;
      }

      throw err;
    }
  }

  throw lastErr;
}

async function fetchBingRssResults(
  query: string,
  keywords: string[],
  minMatchesOverride?: number
): Promise<WebSearchItem[]> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
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
        const minNeeded =
          typeof minMatchesOverride === "number"
            ? minMatchesOverride
            : (keywords.length >= 2 ? 2 : 1);
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

function extractSearchKeywords(queryText: string): string[] {
  const stopWords = new Set(["the", "and", "for", "with", "new", "pro", "hot", "sale", "best", "free", "shipping", "product"]);
  return queryText
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w))
    .slice(0, 6);
}

function mergeWebBatches(batches: WebSearchItem[][], limit = 5): WebSearchItem[] {
  const merged: WebSearchItem[] = [];
  const seenUrls = new Set<string>();
  for (const batch of batches) {
    for (const item of batch) {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        merged.push(item);
      }
      if (merged.length >= limit) break;
    }
    if (merged.length >= limit) break;
  }
  return merged;
}

async function searchWebForProduct(
  productQuery: string,
  similarQuery?: string
): Promise<{ items: WebSearchItem[]; usedSimilarProducts: boolean }> {
  const exactTrimmed = (productQuery || "").trim();
  if (exactTrimmed) {
    const exactKeywords = extractSearchKeywords(exactTrimmed);
    const exactQueries = [
      exactTrimmed,
      `${exactTrimmed} features benefits ingredients how to use`,
    ];
    const exactBatches = await Promise.all(exactQueries.map((q) => fetchBingRssResults(q, exactKeywords)));
    const exactMerged = mergeWebBatches(exactBatches, 5);
    if (exactMerged.length > 0) {
      return { items: exactMerged, usedSimilarProducts: false };
    }
  }

  const fallbackQuery = (similarQuery || exactTrimmed || "").trim();
  if (fallbackQuery) {
    const similarKeywords = extractSearchKeywords(fallbackQuery);
    const similarQueries = [
      fallbackQuery,
      `${fallbackQuery} amazon aliexpress`,
    ];
    const similarBatches = await Promise.all(
      similarQueries.map((q) => fetchBingRssResults(q, similarKeywords, 1))
    );
    const similarMerged = mergeWebBatches(similarBatches, 5);
    if (similarMerged.length > 0) {
      return { items: similarMerged, usedSimilarProducts: true };
    }
  }

  return { items: [], usedSimilarProducts: Boolean(fallbackQuery) };
}

function extractGroundingSources(response: {
  candidates?: Array<{
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
}): GroundingSource[] {
  const rawChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
  const sources: GroundingSource[] = [];
  const seenUrls = new Set<string>();

  if (Array.isArray(rawChunks)) {
    for (const chunk of rawChunks) {
      const web = chunk?.web;
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
  return sources;
}

async function generateWithSingleKey(
  ai: GoogleGenAI,
  imagePart: { inlineData: { mimeType: string; data: string } },
  lang: SupportedLang,
  hintName: string
): Promise<{ result?: GenerateDescResult; lastError?: unknown; keyInvalidError?: ErrorDetails }> {
  let lastError: unknown = null;

  let sawStep1Quota = false;

  // Step 1 (Single-Call Quota-Optimal Path):
  // Call primary multimodal model with Google Search grounding and LOW thinking to minimize tokens & API calls.
  // Accept any complete structured description even if groundingChunks is empty (avoids wasting 2-4 extra calls).
  const groundingModels = ["gemini-4-hydrogen", "gemini-3.1-flash-lite"];
  for (const model of groundingModels) {
    try {
      const { systemInstruction, userPrompt } = buildDirectSearchPrompts(lang, hintName);
      const response = await callGenerateContentWithRetry(ai, {
        model,
        contents: { parts: [imagePart, { text: userPrompt }] },
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          tools: [{ googleSearch: {} }],
        },
      }, !sawStep1Quota);

      const parsed = parseStructuredAiText(response.text || "");
      if (parsed.description && parsed.description.trim().length >= 80) {
        let sources = extractGroundingSources(response);
        let usedWebSearch = sources.length > 0;

        // If model answered richly without emitting groundingChunks, attach free Bing RSS links if available
        if (sources.length === 0 && (parsed.productName || hintName)) {
          const freeWeb = await searchWebForProduct(hintName || parsed.productName, parsed.productName || hintName);
          if (freeWeb.items.length > 0) {
            sources = freeWeb.items.map((w) => ({ title: w.title, url: w.url }));
            usedWebSearch = true;
          }
        }

        return {
          result: {
            productName: parsed.productName || hintName,
            description: parsed.description,
            sources,
            usedWebSearch,
          },
        };
      }
    } catch (err: unknown) {
      lastError = err;
      const info = getUpstreamErrorDetails(err);
      if (info.status === 429 || info.code === "RESOURCE_EXHAUSTED") {
        sawStep1Quota = true;
      }
      if (info.status === 403 || info.code === "PERMISSION_DENIED" || info.code === "API_KEY_INVALID") {
        return { lastError, keyInvalidError: info };
      }
    }
  }

  // Step 2 (Lightweight Fallback WITHOUT googleSearch tool — often uses separate quota & works if search grounding hits limits):
  // Uses free Bing RSS web search (skipping any extra identification API call when hintName is already known).
  try {
    const webRes = hintName
      ? await searchWebForProduct(hintName, hintName)
      : { items: [], usedSimilarProducts: false };
    const webItems = webRes.items;
    const usedSimilarProducts = webRes.usedSimilarProducts;

    const languageLabel =
      lang === "ar" ? "Arabic (العربية الفصحى التسويقية الواضحة)" : lang === "fr" ? "French (Français)" : "English";

    const webContext = webItems.length > 0
      ? webItems
          .map((item, idx) => `[${idx + 1}] ${item.title}\nSource: ${item.url}\nSnippet: ${item.snippet}`)
          .join("\n\n")
      : "";

    const contextInstruction = webContext
      ? (usedSimilarProducts
          ? `Exact listings for this specific item were not found online, so below are real web listings for closely similar products in the same category:\n\n${webContext}\n\nSynthesize a professional e-commerce landing page description modeled after these similar products while staying completely accurate to the design, colors, and features visible in the user's photo.`
          : `Below are real product listings and descriptions found on the web for this product:\n\n${webContext}\n\nSynthesize a professional e-commerce landing page description using the real specs, materials, and benefits found in these web listings alongside what is visible in the photo.`)
      : "Inspect the product carefully in the photo (brand, label text, packaging, materials, category, and design) and write an accurate, persuasive 5-section commercial description modeled after leading products in the exact same category. Never state that the product was not found.";

    const synthesisPrompt = [
      `Analyze this product photo${hintName ? ` (product title hint: ${hintName})` : ""}.`,
      contextInstruction,
      buildStructuredDescFormatInstructions(lang),
    ].join("\n\n");

    const synthSystem = [
      "You are an expert e-commerce product researcher and conversion copywriter.",
      `Write the entire output strictly in ${languageLabel}. Never mix languages (except standard brand/model names).`,
      "Write a rich, thorough, persuasive landing page description (around 220 to 350 words) including all 5 sections in order: Product Overview, Key Features, Benefits, How to Use, and Ingredients/Contents.",
      "Avoid overly short or generic one-line bullets; provide clear, helpful, detailed commercial copy.",
      "Never apologize or say the product could not be found; always produce a strong structured commercial description.",
      "Do not include markdown links, URLs, bracketed citations like [1], or HTML tags.",
    ].join(" ");

    const synthModels = ["gemini-3.1-flash-lite", "gemini-4-hydrogen"];
    for (const model of synthModels) {
      try {
        const resp = await callGenerateContentWithRetry(ai, {
          model,
          contents: { parts: [imagePart, { text: synthesisPrompt }] },
          config: {
            systemInstruction: synthSystem,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        }, !sawStep1Quota);
        const parsed = parseStructuredAiText(resp.text || "");
        if (parsed.description) {
          return {
            result: {
              productName: parsed.productName || hintName,
              description: parsed.description,
              sources: webItems.map((w) => ({ title: w.title, url: w.url })),
              usedWebSearch: webItems.length > 0,
              usedSimilarProducts: webItems.length > 0 ? usedSimilarProducts : false,
            },
          };
        }
      } catch (err: unknown) {
        lastError = err;
        const info = getUpstreamErrorDetails(err);
        if (info.status === 403 || info.code === "PERMISSION_DENIED" || info.code === "API_KEY_INVALID") {
          return { lastError, keyInvalidError: info };
        }
      }
    }
  } catch (err: unknown) {
    lastError = err;
  }

  return { lastError };
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

  const cacheKey = buildCacheKey(lang, hintName, parsedImage.mimeType, parsedImage.data);
  const cached = getCachedResult(cacheKey);
  if (cached) {
    return cached;
  }

  const existingInFlight = inFlightRequests.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const keys = getGeminiApiKeys();
  const imagePart = {
    inlineData: {
      mimeType: parsedImage.mimeType,
      data: parsedImage.data,
    },
  };

  const task = (async (): Promise<GenerateDescResult> => {
    let lastError: unknown = null;
    let sawQuotaError = false;
    let sawInvalidKeyError: ErrorDetails | null = null;

    for (const apiKey of keys) {
      const ai = createGeminiClient(apiKey);
      const outcome = await generateWithSingleKey(ai, imagePart, lang, hintName);

      if (outcome.result) {
        setCachedResult(cacheKey, outcome.result);
        return outcome.result;
      }

      if (outcome.keyInvalidError) {
        sawInvalidKeyError = outcome.keyInvalidError;
        lastError = outcome.lastError;
        continue; // try next configured key if available
      }

      if (outcome.lastError) {
        lastError = outcome.lastError;
        const details = getUpstreamErrorDetails(outcome.lastError);
        if (details.status === 429 || details.code === "RESOURCE_EXHAUSTED") {
          sawQuotaError = true;
        }
      }
    }

    const finalInfo = getUpstreamErrorDetails(lastError);
    if (sawQuotaError || finalInfo.status === 429 || finalInfo.code === "RESOURCE_EXHAUSTED") {
      throw new GenerateDescError(
        429,
        "QUOTA_EXCEEDED",
        "Gemini API quota exceeded for the current key. Please check your plan or select a billing-enabled API key in Settings > Secrets."
      );
    }

    if (
      sawInvalidKeyError ||
      finalInfo.status === 403 ||
      finalInfo.code === "PERMISSION_DENIED" ||
      finalInfo.code === "API_KEY_INVALID"
    ) {
      throw new GenerateDescError(
        sawInvalidKeyError?.status || finalInfo.status || 403,
        "INVALID_API_KEY",
        "Invalid or unauthorized Gemini API key. Please check Settings > Secrets."
      );
    }

    throw new GenerateDescError(
      502,
      "GENERATION_FAILED",
      "Could not generate description right now. Please try again."
    );
  })();

  inFlightRequests.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}
