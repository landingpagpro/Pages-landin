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
  usedSimilarProducts?: boolean;
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

async function fetchBingRssResults(
  query: string,
  keywords: string[],
  minMatchesOverride?: number
): Promise<WebSearchItem[]> {
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

function mergeWebBatches(batches: WebSearchItem[][], limit = 6): WebSearchItem[] {
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
      `${exactTrimmed} amazon aliexpress alibaba pinterest`,
    ];
    const exactBatches = await Promise.all(exactQueries.map((q) => fetchBingRssResults(q, exactKeywords)));
    const exactMerged = mergeWebBatches(exactBatches, 6);
    if (exactMerged.length > 0) {
      return { items: exactMerged, usedSimilarProducts: false };
    }
  }

  const fallbackQuery = (similarQuery || exactTrimmed || "").trim();
  if (fallbackQuery) {
    const similarKeywords = extractSearchKeywords(fallbackQuery);
    const similarQueries = [
      fallbackQuery,
      `${fallbackQuery} aliexpress alibaba amazon`,
      `${fallbackQuery} features benefits ingredients how to use`,
    ];
    const similarBatches = await Promise.all(
      similarQueries.map((q) => fetchBingRssResults(q, similarKeywords, 1))
    );
    const similarMerged = mergeWebBatches(similarBatches, 6);
    if (similarMerged.length > 0) {
      return { items: similarMerged, usedSimilarProducts: true };
    }
  }

  return { items: [], usedSimilarProducts: Boolean(fallbackQuery) };
}

async function identifyProductFromImage(
  ai: GoogleGenAI,
  imagePart: { inlineData: { mimeType: string; data: string } },
  hintName: string
): Promise<{ productName: string; searchQuery: string; similarQuery: string }> {
  const modelsToTry = ["gemini-3.1-flash-lite", "gemini-4-hydrogen"];
  const prompt = [
    "Look closely at this product photo.",
    hintName ? `Optional user note: "${hintName}" (trust what you visually see in the photo above all).` : "",
    "Identify the commercial product, brand, model, or product type — and also identify the broader category for closely similar products.",
    "Return ONLY three lines in this exact format:",
    "NAME: <concise product name>",
    "SEARCH_QUERY: <3 to 7 clean English keywords to search this exact product on Google, AliExpress, Alibaba, Pinterest, and Amazon>",
    "SIMILAR_QUERY: <3 to 5 broader English category/type keywords to find closely similar products if this exact item is not listed online>",
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
      const similarMatch = text.match(/^SIMILAR_QUERY\s*:\s*(.+)$/im);
      const productName = nameMatch && nameMatch[1] ? nameMatch[1].trim() : "";
      const searchQuery = queryMatch && queryMatch[1] ? queryMatch[1].trim() : productName;
      const similarQuery = similarMatch && similarMatch[1] ? similarMatch[1].trim() : searchQuery;
      if (searchQuery || similarQuery) {
        return {
          productName: productName || searchQuery || similarQuery,
          searchQuery: searchQuery || similarQuery,
          similarQuery: similarQuery || searchQuery,
        };
      }
    } catch {
      /* Try next model */
    }
  }

  return { productName: hintName, searchQuery: hintName, similarQuery: hintName };
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

  // Step 2: 2-Stage Visual Identification + Exact Web Search + Similar-Products Fallback
  try {
    const identified = await identifyProductFromImage(ai, imagePart, hintName);
    const searchRes = (identified.searchQuery || identified.similarQuery)
      ? await searchWebForProduct(identified.searchQuery, identified.similarQuery)
      : { items: [], usedSimilarProducts: true };
    const webItems = searchRes.items;
    const usedSimilarProducts = searchRes.usedSimilarProducts;

    const languageLabel =
      lang === "ar" ? "Arabic (العربية الفصحى التسويقية الواضحة)" : lang === "fr" ? "French (Français)" : "English";

    const webContext = webItems.length > 0
      ? webItems
          .map((item, idx) => `[${idx + 1}] ${item.title}\nSource: ${item.url}\nSnippet: ${item.snippet}`)
          .join("\n\n")
      : "";

    const contextInstruction = webContext
      ? (usedSimilarProducts
          ? `Exact listings for this specific item were not found online, so below are real web listings for closely similar products in the same category:\n\n${webContext}\n\nSynthesize a professional e-commerce landing page description modeled after these similar products (their proven selling points, benefits, and specifications) while staying completely accurate to the design, colors, and features visible in the user's photo.`
          : `Below are real product listings and descriptions found on the web for this product:\n\n${webContext}\n\nSynthesize a professional e-commerce landing page description using the real specs, materials, and benefits found in these web listings alongside what is visible in the photo.`)
      : "If the exact product is not listed online, analyze its category, design, materials, and visual details in the photo and write an accurate, persuasive commercial description modeled after top-selling similar products in the same category. Never state that the product was not found.";

    const synthesisPrompt = [
      `Analyze this product photo${identified.productName ? ` (identified as: ${identified.productName})` : ""}.`,
      contextInstruction,
      buildStructuredDescFormatInstructions(lang),
    ].join("\n\n");

    const synthSystem = [
      "You are an expert e-commerce product researcher and conversion copywriter.",
      `Write the entire output strictly in ${languageLabel}. Never mix languages (except standard brand/model names).`,
      "Write a rich, thorough, persuasive landing page description (around 220 to 350 words) including all 5 sections in order: Product Overview, Key Features, Benefits, How to Use, and Ingredients/Contents.",
      "Avoid overly short or generic one-line bullets; provide clear, helpful, detailed commercial copy.",
      "Never apologize or say the product could not be found; always produce a strong structured commercial description from exact matches or similar category products.",
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
            usedSimilarProducts,
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
