import crypto from "node:crypto";

export type SupportedLang = "en" | "ar" | "fr";

export interface FreeSourceLink {
  title: string;
  url: string;
}

export interface GenerateFreeDescInput {
  productName?: unknown;
  lang?: unknown;
}

export interface GenerateFreeDescResult {
  productName: string;
  description: string;
  sources: FreeSourceLink[];
  mode: "keyless-web-research";
}

export class FreeDescError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

type ProductCategory =
  | "oil_skincare"
  | "perfume"
  | "supplement_food"
  | "electronics"
  | "fashion"
  | "home_kitchen"
  | "fitness_sport"
  | "general";

interface CacheEntry {
  result: GenerateFreeDescResult;
  expiresAt: number;
}

const FREE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_FREE_CACHE_ENTRIES = 150;
const freeResultCache = new Map<string, CacheEntry>();

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

function buildSearchCandidates(productName: string): string[] {
  const clean = productName
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const stopWords = new Set([
    "من", "في", "مع", "على", "إلى", "عن", "و", "أو", "لـ", "لل", "الأصلي", "الجديد", "المطور", "السائل", "الطبيعي", "النقي",
    "by", "from", "with", "for", "and", "the", "original", "pro", "new", "pure", "natural", "liquid", "premium", "best",
    "de", "du", "des", "et", "pour", "avec", "la", "le", "les", "original", "nouveau", "pur", "naturel"
  ]);

  const words = clean.split(" ").filter((w) => w.length >= 2 && !stopWords.has(w.toLowerCase()));
  const candidates: string[] = [clean];

  if (words.length >= 3) {
    candidates.push(words.slice(0, 3).join(" "));
    candidates.push(words.slice(-3).join(" "));
  }
  if (words.length >= 2) {
    candidates.push(words.slice(0, 2).join(" "));
    candidates.push(words.slice(-2).join(" "));
  }
  if (words.length >= 1) {
    candidates.push(words[0]);
  }

  return [...new Set(candidates.map((c) => c.trim()).filter((c) => c.length >= 2))].slice(0, 5);
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 3500): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "LandingPagePro/2.0",
        "Accept": "application/json",
      },
    });
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("json") && !contentType.includes("javascript")) {
      return null;
    }
    return (await resp.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface WikiSearchResp {
  query?: {
    search?: Array<{ title?: string }>;
    pages?: Record<string, { title?: string; extract?: string }>;
  };
}

function cleanWikiExtract(rawExtract: string): string {
  const cleaned = (rawExtract || "")
    .replace(/==+[\s\S]*$/m, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*(?:بالإنجليزية|الإسبانية|الفرنسية|pronunciation|Listen|IPA)[^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  const sentences = cleaned
    .split(/(?<=[.!?؟])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25 && !/^(لا تنصح|تنويه|انظر أيضاً|See also)/i.test(s));

  const picked = sentences.slice(0, 2).join(" ").trim();
  return picked.slice(0, 340);
}

async function fetchWikipediaSummary(
  candidates: string[],
  lang: SupportedLang
): Promise<{ title: string; summary: string; url: string } | null> {
  const hostLang = lang === "ar" ? "ar" : lang === "fr" ? "fr" : "en";
  const wikiQueries = candidates.length > 1
    ? [candidates[1], candidates[0]].filter(Boolean)
    : candidates.slice(0, 1);

  for (const query of wikiQueries) {
    const searchUrl =
      `https://${hostLang}.wikipedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(query)}&format=json&srlimit=2`;
    const searchData = await fetchJsonWithTimeout<WikiSearchResp>(searchUrl, 3000);
    const title = searchData?.query?.search?.[0]?.title?.trim();
    if (!title) continue;

    const extractUrl =
      `https://${hostLang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1` +
      `&exchars=900&titles=${encodeURIComponent(title)}&format=json`;
    const extractData = await fetchJsonWithTimeout<WikiSearchResp>(extractUrl, 3000);
    const pages = extractData?.query?.pages ? Object.values(extractData.query.pages) : [];
    const rawExtract = pages[0]?.extract || "";
    const summary = cleanWikiExtract(rawExtract);

    if (summary) {
      const safeUrl = sanitizeHttpUrl(`https://${hostLang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`);
      if (safeUrl) {
        return { title, summary, url: safeUrl };
      }
    }
  }

  return null;
}

interface OpenFactsResp {
  products?: Array<{
    code?: string;
    product_name?: string;
    brands?: string;
    ingredients_text?: string;
    categories?: string;
    quantity?: string;
  }>;
}

async function fetchOpenProductCatalog(
  candidates: string[]
): Promise<{
  brand: string;
  ingredients: string;
  categories: string;
  quantity: string;
  source?: FreeSourceLink;
} | null> {
  const hosts = [
    "https://world.openbeautyfacts.org",
    "https://world.openproductsfacts.org",
  ];

  for (const host of hosts) {
    for (const query of candidates.slice(0, 2)) {
      const url = `${host}/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&action=process&json=1&page_size=3`;
      const data = await fetchJsonWithTimeout<OpenFactsResp>(url, 3200);
      const products = Array.isArray(data?.products) ? data.products : [];
      const best = products.find((p) => (p.ingredients_text || "").trim().length > 3 || (p.product_name || "").trim().length > 2);
      if (best) {
        const cleanIngredients = (best.ingredients_text || "").replace(/\s+/g, " ").trim().slice(0, 220);
        const cleanBrand = (best.brands || "").split(",")[0]?.trim() || "";
        const cleanCategories = (best.categories || "").trim().slice(0, 140);
        const cleanQuantity = (best.quantity || "").trim().slice(0, 40);
        const productUrl = best.code ? sanitizeHttpUrl(`${host}/product/${encodeURIComponent(best.code)}`) : null;
        return {
          brand: cleanBrand,
          ingredients: cleanIngredients,
          categories: cleanCategories,
          quantity: cleanQuantity,
          source: productUrl
            ? { title: best.product_name?.trim() || query, url: productUrl }
            : undefined,
        };
      }
    }
  }
  return null;
}

async function fetchSuggestIntentPhrases(coreQuery: string, lang: SupportedLang): Promise<string[]> {
  if (!coreQuery) return [];
  const hl = lang === "ar" ? "ar" : lang === "fr" ? "fr" : "en";
  const prefixes =
    lang === "ar"
      ? [`فوائد ${coreQuery} `, `استعمال ${coreQuery} `]
      : lang === "fr"
        ? [`avantages ${coreQuery} `, `utilisation ${coreQuery} `]
        : [`benefits of ${coreQuery} `, `how to use ${coreQuery} `];

  const batches = await Promise.all(
    prefixes.map(async (q) => {
      const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=${hl}&q=${encodeURIComponent(q)}`;
      const json = await fetchJsonWithTimeout<unknown>(url, 2200);
      if (Array.isArray(json) && Array.isArray(json[1])) {
        return json[1].filter((item): item is string => typeof item === "string");
      }
      return [];
    })
  );

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const list of batches) {
    for (const raw of list) {
      const cleaned = raw.trim();
      if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
      seen.add(cleaned.toLowerCase());
      unique.push(cleaned);
      if (unique.length >= 6) break;
    }
    if (unique.length >= 6) break;
  }
  return unique;
}

function detectProductCategory(textBlob: string): ProductCategory {
  const s = textBlob.toLowerCase();

  if (/(زيت|سيروم|كريم|لوشن|صابون|غسول|شامبو|بلسم|ماسك|بشرة|شعر|ترطيب|تفتيح|أرغان|جوز الهند|زيتون|تجميل|عناية|مرطب|oil|serum|cream|lotion|cleanser|shampoo|skincare|hair|coconut|argan|shea|moisturizer|huile|sérum|crème|soin|visage|cheveux)/i.test(s)) {
    return "oil_skincare";
  }
  if (/(عطر|بارفان|مسك|عود|بخور|معطر|perfume|fragrance|cologne|scent|parfum|eau de parfum)/i.test(s)) {
    return "perfume";
  }
  if (/(فيتامين|مكمل|كولاجين|بروتين|عسل|شاي|قهوة|كبسولات|أعشاب|مناعة|supplement|vitamin|collagen|protein|honey|coffee|tea|capsules|complément|vitamine|miel)/i.test(s)) {
    return "supplement_food";
  }
  if (/(سماعة|سماعات|بلوتوث|لاسلكي|شاحن|بطارية|كاميرا|مكبر|ساعة ذكية|جهاز|مصباح|إلكترون|شاشة|earbuds|headphone|wireless|bluetooth|charger|smartwatch|camera|speaker|lamp|gadget|écouteurs|casque|montre connectée|chargeur)/i.test(s)) {
    return "electronics";
  }
  if (/(حقيبة|شنطة|نظارة|حذاء|جاكيت|قميص|فستان|محفظة|مجوهرات|سوار|خاتم|ساعة يد|bag|backpack|glasses|sunglasses|shoes|wallet|jewelry|watch|sac|lunettes|chaussures|portefeuille|bijoux)/i.test(s)) {
    return "fashion";
  }
  if (/(مطبخ|مقلاة|طقم|كوب|وسادة|مصفاة|مفرمة|خلاط|تنظيم|منزل|ديكور|أداة|kitchen|blender|pan|mug|pillow|organizer|home|decor|cuisine|maison|oreiller)/i.test(s)) {
    return "home_kitchen";
  }
  if (/(رياضة|لياقة|تمارين|يوجا|مشد|عضلات|حزام|دراجة|gym|fitness|workout|yoga|sport|resistance|belt|entraînement)/i.test(s)) {
    return "fitness_sport";
  }
  return "general";
}

function extractUseCaseTags(suggestions: string[], lang: SupportedLang): string[] {
  const joined = suggestions.join(" | ").toLowerCase();
  const tags: string[] = [];

  if (lang === "ar") {
    if (/شعر|الشعر/.test(joined)) tags.push("تغذية الشعر وتقويته ومنحه لمعاناً طبيعياً");
    if (/بشرة|وجه|جاف/.test(joined)) tags.push("ترطيب البشرة وتنعيمها بعمق دون لزوجة مزعجة");
    if (/أظافر|جلد/.test(joined)) tags.push("العناية بالجلد الحساس والأظافر وحمايتها من الجفاف");
    if (/تدليك|مساج/.test(joined)) tags.push("مثالي لجلسات التدليك والاسترخاء اليومي");
    if (/أسنان/.test(joined)) tags.push("دعم روتين العناية الشخصية اليومية بأمان");
    if (/بطارية|شحن/.test(joined)) tags.push("أداء مستقر وساعات تشغيل طويلة طوال اليوم");
    if (/صوت|مكالمات/.test(joined)) tags.push("وضوح عالٍ في الصوت والمكالمات اليومية");
  } else if (lang === "fr") {
    if (/cheveu|hair/.test(joined)) tags.push("nourrir et fortifier la fibre capillaire avec brillance");
    if (/peau|visage|skin/.test(joined)) tags.push("hydrater et adoucir la peau sans fini gras");
    if (/massage/.test(joined)) tags.push("idéal pour le soin quotidien et les massages relaxants");
    if (/batterie|charge/.test(joined)) tags.push("autonomie fiable pour une utilisation prolongée");
  } else {
    if (/hair/.test(joined)) tags.push("nourishing dry hair and restoring natural shine");
    if (/skin|face/.test(joined)) tags.push("deep skin hydration with fast, non-greasy absorption");
    if (/massage/.test(joined)) tags.push("soothing daily body care and massage routines");
    if (/battery|charge/.test(joined)) tags.push("dependable all-day battery life and quick charging");
  }

  return tags.slice(0, 2);
}

function synthesizeStructuredDescription(params: {
  productName: string;
  lang: SupportedLang;
  category: ProductCategory;
  wikiSummary: string;
  catalog: {
    brand: string;
    ingredients: string;
    categories: string;
    quantity: string;
  } | null;
  suggestions: string[];
}): string {
  const { productName, lang, category, wikiSummary, catalog, suggestions } = params;
  const useTags = extractUseCaseTags(suggestions, lang);
  const cleanBrand = catalog?.brand ? catalog.brand : "";
  const cleanQty = catalog?.quantity ? catalog.quantity : "";
  const realIngredients = catalog?.ingredients ? catalog.ingredients : "";

  if (lang === "ar") {
    const overviewExtra = wikiSummary
      ? ` ${wikiSummary}`
      : ` صُمم بعناية ليجمع بين الجودة العالية وسهولة الاستعمال في الروتين اليومي، مما يمنحك تجربة موثوقة ونتائج ملموسة من أول استخدام.`;

    const categoryTemplates: Record<ProductCategory, {
      introLead: string;
      features: string[];
      benefits: string[];
      usage: string[];
      ingredients: string[];
    }> = {
      oil_skincare: {
        introLead: `يُعد **${productName}** خياراً مثالياً ضمن منتجات العناية اليومية الفائقة بالبشرة والشعر.${overviewExtra}`,
        features: [
          "تركيبة نقية ومتوازنة: سريعة الامتصاص وتترك ملمساً ناعماً ومريحاً دون أثر دهني مزعج.",
          "جودة تصنيع وتغليف موثوقة: عبوة محكمة تحافظ على نقاء المنتج وفعاليته لأطول فترة ممكنة.",
          "متعدد الاستعمالات: يناسب روتين العناية بالبشرة والشعر والجسم في منتج واحد عملي.",
          cleanBrand ? `إصدار أصلي موثوق من علامة ${cleanBrand}${cleanQty ? ` بحجم عملي (${cleanQty})` : ""}.` : "مناسب للاستخدام اليومي ولأنواع البشرة والشعر المختلفة بلطف.",
        ],
        benefits: [
          useTags[0] ? `${useTags[0]} بشكل واضح ومستمر.` : "ترطيب عميق يساعد على استعادة نعومة ومرونة البشرة والشعر.",
          useTags[1] ? `${useTags[1]}.` : "حماية فعالة من الجفاف والعوامل اليومية مع إشراقة صحية.",
          "يوفر عليك عناء شراء عدة منتجات بفضل فعاليته المتكاملة وتأثيره السريع.",
          "يمنحك ثقة وراحة يومية بفضل نتائجه العملية وملمسه اللطيف.",
        ],
        usage: [
          "نظّف المنطقة المراد العناية بها وجففها برفق قبل التطبيق لضمان أفضل امتصاص.",
          "ضع كمية مناسبة من المنتج ودلّك بلطف بحركات دائرية حتى يتشرب تماماً.",
          "استعمله بانتظام ضمن روتينك الصباحي أو المسائي، واحفظ العبوة في مكان بارد وجاف.",
        ],
        ingredients: realIngredients
          ? [
              `التركيبة المسجلة: ${realIngredients}.`,
              "خالٍ من الإضافات القاسية غير الضرورية لضمان لطافة عالية أثناء الاستعمال.",
              "عبوة عملية محكمة الإغلاق تحفظ جودة التركيبة من الضوء والرطوبة.",
            ]
          : [
              `تركيبة مخصصة لـ ${productName} بمكونات مختارة بعناية لدعم الترطيب والتغذية.`,
              "مواد آمنة ومناسبة للعناية الظاهرية والروتين اليومي.",
              "عبوة أصلية جاهزة للاستعمال مع تعليمات واضحة على الملصق.",
            ],
      },
      perfume: {
        introLead: `**${productName}** هو خيار أنيق يمنحك حضوراً مميزاً وثباتاً راقياً طوال اليوم.${overviewExtra}`,
        features: [
          "ثبات وفوحان متوازن: نفحات عطرية متناغمة تدوم لساعات طويلة دون إزعاج.",
          "تصميم زجاجة فاخر: رشاش دقيق يوزع العطر بتساوٍ وأناقة في كل رشة.",
          "مناسب للمناسبات والدوام: طابع عطري راقٍ يجمع بين الانتعاش والفخامة.",
          "تدرج عطري جذاب يترك انطباعاً لا يُنسى في كل مكان.",
        ],
        benefits: [
          "يعزز حضورك وثقتك بنفسك في اللقاءات اليومية والمناسبات الخاصة.",
          "رائحة نظيفة ومريحة تناسب مختلف الفصول والأوقات.",
          "كمية قليلة تكفي لتمنحك انتعاشاً يدوم طويلاً.",
          "خيار مثالي للإهداء أو الاستخدام الشخصي اليومي.",
        ],
        usage: [
          "رش العطر على نقاط النبض مثل المعصمين وخلف الأذنين وعلى الرقبة.",
          "يُفضّل وضعه على بشرة مرطّبة بعد الاستحمام لثبات أطول.",
          "تجنب فرك العطر بعد الرش للحفاظ على توازن النوتات العطرية، واحفظ الزجاجة بعيداً عن الحرارة.",
        ],
        ingredients: [
          "خلاصات عطرية متوازنة عالية النقاء تمنح تدرجاً متناغماً بين المقدمة والقلب والقاعدة.",
          "مذيبات عطرية مخصصة لثبات الرائحة وانتشارها بنعومة.",
          "زجاجة أنيقة بغطاء محكم يحافظ على جودة العطر مع مرور الوقت.",
        ],
      },
      supplement_food: {
        introLead: `**${productName}** منتج عملي مختار بعناية لدعم نمط حياتك اليومي بجودة موثوقة وطعم أو فعالية متوازنة.${overviewExtra}`,
        features: [
          "جودة منتقاة بعناية: مُعد وفق معايير حفظ وتغليف تحافظ على القيمة والفعالية.",
          "سهل الدمج في الروتين اليومي: لا يتطلب تحضيراً معقداً ومناسب للاستخدام المنتظم.",
          cleanBrand ? `من إنتاج ${cleanBrand}${cleanQty ? ` بعبوة (${cleanQty})` : ""} الموثوقة.` : "تغليف محكم يحمي المنتج من الرطوبة ويحافظ على نضارته.",
          "قيمة غذائية أو دعم يومي متوازن يناسب احتياجاتك العملية.",
        ],
        benefits: [
          "يساعدك على الحفاظ على نشاطك وتوازنك اليومي بانتظام وسهولة.",
          "يوفر عليك الوقت والجهد بفضل جاهزيته وسرعة تحضيره أو تناوله.",
          "نتائج ملموسة عند المواظبة عليه ضمن نظام حياة متوازن.",
          "مذاق أو تركيبة مريحة تشجع على الاستمرارية دون عناء.",
        ],
        usage: [
          "اتبع الجرعة أو الكمية الموصى بها بوضوح على عبوة المنتج.",
          "يُفضّل الالتزام بوقت يومي منتظم للحصول على أفضل استفادة.",
          "احفظ العبوة مغلقة بإحكام في مكان بارد وجاف بعيداً عن أشعة الشمس المباشرة.",
        ],
        ingredients: realIngredients
          ? [
              `المكونات الفعلية: ${realIngredients}.`,
              "مُعبأ وفق معايير السلامة الغذائية مع غطاء محكم الإغلاق.",
              "يرجى مراجعة الملصق الخلفي في حال وجود حساسية تجاه أي مكون.",
            ]
          : [
              `مكونات مختارة الخاصة بـ ${productName} وفق المواصفات الموضحة على العبوة.`,
              "خالٍ من الإضافات غير اللازمة ومحفوظ في عبوة تحافظ على الجودة.",
              "عبوة مغلقة بأمان تضمن وصول المنتج طازجاً وسليماً.",
            ],
      },
      electronics: {
        introLead: `يجمع **${productName}** بين الأداء الذكي والتصميم العصري ليمنحك تجربة استخدام سلسة وموثوقة في كل وقت.${overviewExtra}`,
        features: [
          "أداء عملي وسريع الاستجابة: مصمم ليؤدي مهامه بكفاءة عالية واستقرار مستمر.",
          "تصميم مريح وخامات متينة: يتحمل الاستخدام اليومي المتكرر مع مظهر أنيق.",
          "سهولة التشغيل والتوافق: يعمل بسلاسة دون إعدادات معقدة لجميع المستخدمين.",
          useTags[0] ? `${useTags[0]}.` : "كفاءة عالية في استهلاك الطاقة تضمن استخداماً أطول بين الشحنات.",
        ],
        benefits: [
          "ينجز مهامك اليومية بسرعة ودقة ويوفر الكثير من الوقت والجهد.",
          "راحة كبيرة أثناء التنقل أو العمل أو الاستخدام المنزلي.",
          "موثوقية طويلة الأمد تجعله استثماراً عملياً بامتياز.",
          "جاهز للعمل خلال ثوانٍ ليواكب إيقاع يومك السريع.",
        ],
        usage: [
          "تأكد من شحن الجهاز أو توصيله بشكل صحيح قبل أول استخدام.",
          "شغّل الجهاز واتبع أزرار التحكم المباشرة الموضحة في الدليل المرفق.",
          "احفظ الجهاز في مكان جاف ونظّفه بقطعة قماش ناعمة للحفاظ على أدائه.",
        ],
        ingredients: [
          "هيكل خارجي متين مصنوع من خامات عالية الجودة مقاومة للاستعمال اليومي.",
          "مكونات إلكترونية داخلية مصممة للاستقرار والأمان الكهربائي.",
          "العبوة الرئيسية مع الملحقات الأساسية للتشغيل ودليل الاستخدام.",
        ],
      },
      fashion: {
        introLead: `**${productName}** قطعة عصرية تجمع بين الأناقة الراقية والراحة العملية لتكمل إطلالتك اليومية بكل تميز.${overviewExtra}`,
        features: [
          "تصميم أنيق ومتناسق: يناسب الإطلالات الكاجوال والرسمية بسهولة تامة.",
          "تشطيب دقيق وخامات مريحة: خفة في الارتداء مع متانة واضحة في التفاصيل.",
          "تفاصيل عملية مدروسة: تمنحك سهولة في الاستخدام والتنسيق طوال اليوم.",
          "ألوان وقصة جذابة تحافظ على رونقها مع كثرة الاستعمال.",
        ],
        benefits: [
          "يضيف لمسة فخامة وثقة فورية على مظهرك اليومي.",
          "راحة تدوم لساعات طويلة دون إجهاد أو انزعاج.",
          "قطعة متعددة التنسيقات تغنيك عن الحيرة في اختيار إطلالتك.",
          "جودة تصنيع تدوم طويلاً وتحافظ على شكلها الأنيق.",
        ],
        usage: [
          "نسّق القطعة مع ملابسك اليومية أو إكسسواراتك المفضلة لإطلالة متكاملة.",
          "اتبع إرشادات العناية والتنظيف اللطيف للحفاظ على الخامة واللون.",
          "احفظها في مكان مرتب وجاف بعيداً عن الرطوبة المباشرة عند عدم الاستعمال.",
        ],
        ingredients: [
          "خامات مختارة بعناية تجمع بين الملمس المريح والمتانة العملية.",
          "خياطة وتشطيبات متقنة تضمن ثبات الشكل مع الاستخدام المتكرر.",
          "تغليف أنيق يحمي القطعة أثناء الشحن والتخزين.",
        ],
      },
      home_kitchen: {
        introLead: `**${productName}** إضافة عملية ذكية لمنزلك أو مطبخك تجعل المهام اليومية أسرع وأكثر ترتيباً وراحة.${overviewExtra}`,
        features: [
          "تصميم عملي موفر للمساحة والجهد: يناسب الاستخدام المنزلي المتكرر بسهولة.",
          "خامات متينة وسهلة التنظيف: مصممة لتتحمل الاستعمال اليومي وتدوم طويلاً.",
          "أداء ثابت ونتائج دقيقة: يوفر عليك الوقت في التحضير أو الترتيب.",
          "شكل عصري أنيق يندمج بسلاسة مع ديكور المنزل أو المطبخ.",
        ],
        benefits: [
          "يجعل روتين المنزل أو المطبخ أكثر سلاسة وتنظيماً في دقائق معدودة.",
          "يوفر الوقت والمجهود اليومي بنتائج عملية مرضية كل مرة.",
          "سهل التنظيف والتخزين بعد الانتهاء من الاستعمال.",
          "متانة عالية تقلل الحاجة إلى الاستبدال المتكرر.",
        ],
        usage: [
          "امسح أو اغسل القطعة برفق قبل الاستخدام الأول وتأكد من ثباتها على سطح مستوٍ.",
          "استخدمها بالطريقة المخصصة بسلاسة دون ضغط زائد.",
          "نظّفها وجففها جيداً بعد كل استعمال واحفظها في مكان جاف.",
        ],
        ingredients: [
          "خامات منزلية متينة ومختارة بعناية للسلامة وطول العمر.",
          "أجزاء عملية متماسكة تسهّل الفك والتركيب أو التنظيف.",
          "المنتج الكامل داخل عبوته الواقية مع كافة القطع الأساسية.",
        ],
      },
      fitness_sport: {
        introLead: `**${productName}** رفيقك المثالي في التمارين والأنشطة اليومية، مصمم ليمنحك دعماً وثباتاً يساعدانك على تحقيق أهدافك بثقة.${overviewExtra}`,
        features: [
          "تصميم مريح ومرن: يمنحك حرية الحركة مع ثبات ممتاز أثناء التمرين.",
          "خامات متينة وتهوية مناسبة: تتحمل التمارين المكثفة والاستخدام المتكرر.",
          "خفيف الوزن وسهل الحمل: مناسب للبيت، النادي الرياضي، أو الهواء الطلق.",
          "تركيب أو ضبط سريع خلال ثوانٍ دون تعقيد.",
        ],
        benefits: [
          "يرفع جودة تمارينك اليومية ويحفزك على الاستمرار والالتزام.",
          "يمنحك دعماً إضافياً وراحة تقلل من الإجهاد أثناء النشاط البدني.",
          "يمكنك استخدامه في أي وقت ومكان دون الحاجة لمعدات ضخمة.",
          "يعيش طويلاً معك بفضل تحمله للضغط والحركة المستمرة.",
        ],
        usage: [
          "اضبط المنتج بالوضعية أو المقاس المناسب لجسمك قبل بدء التمرين.",
          "ابدأ بتمارين إحماء خفيفة ثم استخدمه بانتظام ضمن جدولك الرياضي.",
          "امسحه وجففه بعد التمرين واحفظه في مكان جيد التهوية.",
        ],
        ingredients: [
          "ألياف ومواد رياضية مرنة عالية التحمل ومريحة على الجسم.",
          "مقاطع تثبيت آمنة تحافظ على الثبات أثناء الحركة.",
          "المنتج مع عبوة حفظ عملية لسهولة التنقل.",
        ],
      },
      general: {
        introLead: `يُعد **${productName}** منتجاً عملياً مميزاً يجمع بين الجودة العالية والتصميم المدروس لتلبية احتياجك اليومي بكل كفاءة.${overviewExtra}`,
        features: [
          "جودة تصنيع موثوقة: مصمم بخامات متقنة تضمن أداءً ثابتاً ومظهراً أنيقاً.",
          "سهولة فائقة في الاستخدام: عملي وواضح ليمنحك أفضل تجربة من اليوم الأول.",
          useTags[0] ? `${useTags[0]}.` : "تفاصيل مدروسة بعناية لراحة أكبر وكفاءة أعلى أثناء الاستعمال.",
          "حجم وتصميم عملي يناسب الاستخدام اليومي والتنقل بكل سهولة.",
        ],
        benefits: [
          "يوفر الوقت والجهد ويمنحك نتائج ملموسة وموثوقة في كل مرة.",
          useTags[1] ? `${useTags[1]}.` : "يحل مشكلة يومية بكفاءة ويضفي قيمة حقيقية على مشترياتك.",
          "مصمم ليدوم طويلاً مما يمنحك قيمة ممتازة مقابل السعر.",
          "خيار مثالي للاستخدام الشخصي أو كهدية عملية أنيقة.",
        ],
        usage: [
          "تأكد من فحص المنتج وتجهيزه في بيئة مناسبة قبل الاستخدام الأول.",
          "استخدم المنتج بخطوات بسيطة ومنتظمة حسب الغرض المخصص له.",
          "حافظ عليه نظيفاً وفي مكان جاف وآمن بعد كل استعمال لإطالة عمره.",
        ],
        ingredients: realIngredients
          ? [
              `المكونات أو المواصفات المسجلة: ${realIngredients}.`,
              "خامات ومكونات مختارة بعناية لضمان الجودة والسلامة.",
              "عبوة محكمة تحفظ المنتج وتصل مع كافة ملحقاته الأساسية.",
            ]
          : [
              `مواد وخامات متقنة خاصة بـ ${productName} لضمان الاعتمادية والأمان.`,
              "تصميم متكامل خالٍ من التعقيد ومجهز للاستعمال المباشر.",
              "المنتج الكامل داخل تغليف أنيق وآمن مع تعليمات الاستخدام.",
            ],
      },
    };

    const tpl = categoryTemplates[category];
    return [
      "**📌 تعريف بالمنتج:**",
      tpl.introLead,
      "",
      "**✨ المميزات:**",
      ...tpl.features.map((x) => `• ${x}`),
      "",
      "**💡 الفوائد:**",
      ...tpl.benefits.map((x) => `• ${x}`),
      "",
      "**📋 طريقة الاستعمال:**",
      ...tpl.usage.map((x) => `• ${x}`),
      "",
      "**🧪 المكونات:**",
      ...tpl.ingredients.map((x) => `• ${x}`),
    ].join("\n");
  }

  if (lang === "fr") {
    const overviewExtra = wikiSummary
      ? ` ${wikiSummary}`
      : " Conçu avec soin pour offrir fiabilité, simplicité d'utilisation et résultats concrets au quotidien.";

    const ingredientsLines = realIngredients
      ? [
          `Composition vérifiée : ${realIngredients}.`,
          "Emballage hermétique préservant la fraîcheur et l'efficacité du produit.",
          "Formule ou matériaux sélectionnés selon des standards rigoureux de qualité.",
        ]
      : [
          `Matériaux ou formule adaptés à ${productName}, sélectionnés pour leur fiabilité et durabilité.`,
          "Finitions soignées et sûres pour un usage quotidien en toute sérénité.",
          "Produit complet livré prêt à l'emploi dans son emballage protecteur.",
        ];

    const featureByCat: Record<ProductCategory, string[]> = {
      oil_skincare: [
        "Texture douce à absorption rapide qui laisse la peau ou les cheveux souples sans film collant.",
        "Qualité préservée grâce à un flacon pratique et hermétique.",
        "Utilisation polyvalente adaptée aux soins quotidiens du visage, du corps ou des cheveux.",
        cleanBrand ? `Qualité authentique signée ${cleanBrand}${cleanQty ? ` (${cleanQty})` : ""}.` : "Convient parfaitement à une routine de soin régulière et douce.",
      ],
      perfume: [
        "Tenue longue durée avec un sillage élégant et équilibré tout au long de la journée.",
        "Vaporisateur précis offrant une diffusion fine et homogène.",
        "Notes raffinées adaptées aussi bien au quotidien qu'aux occasions spéciales.",
        "Flacon élégant facile à transporter et à conserver.",
      ],
      supplement_food: [
        "Qualité sélectionnée et conditionnement protecteur pour préserver toute l'efficacité.",
        "Intégration simple dans votre routine quotidienne sans préparation complexe.",
        cleanBrand ? `Élaboré par ${cleanBrand}${cleanQty ? ` (${cleanQty})` : ""}.` : "Fermeture hermétique protégeant de l'humidité et de la lumière.",
        "Apport régulier pensé pour soutenir votre bien-être au quotidien.",
      ],
      electronics: [
        "Performances rapides et stables conçues pour un usage intensif au quotidien.",
        "Design ergonomique et matériaux robustes résistants à l'usure.",
        "Prise en main immédiate avec une compatibilité large et intuitive.",
        "Autonomie et gestion d'énergie optimisées pour rester productif partout.",
      ],
      fashion: [
        "Coupe et design intemporels faciles à assortir à toutes vos tenues.",
        "Matières confortables offrant maintien, légèreté et respirabilité.",
        "Finitions précises et coutures solides pour une durabilité remarquable.",
        "Style élégant idéal au bureau, en sortie ou en voyage.",
      ],
      home_kitchen: [
        "Conception pratique qui optimise l'espace et simplifie les tâches domestiques.",
        "Matériaux durables et faciles à nettoyer après chaque utilisation.",
        "Utilisation fluide permettant un vrai gain de temps au quotidien.",
        "Esthétique moderne qui s'intègre harmonieusement à votre intérieur.",
      ],
      fitness_sport: [
        "Maintien optimal et confort souple même pendant les séances intenses.",
        "Matériaux résistants et respirants adaptés aux mouvements répétés.",
        "Format léger facile à emporter à la salle, à la maison ou en extérieur.",
        "Réglage simple et rapide en quelques secondes.",
      ],
      general: [
        "Fabrication soignée alliant solidité, praticité et design moderne.",
        "Prise en main facile pour profiter du produit dès la première utilisation.",
        useTags[0] ? `Idéal pour ${useTags[0]}.` : "Conçu pour offrir un maximum de confort et d'efficacité chaque jour.",
        "Format pratique adapté aussi bien à la maison qu'aux déplacements.",
      ],
    };

    const usageByCat: Record<ProductCategory, string[]> = {
      oil_skincare: [
        "Nettoyez et séchez délicatement la zone ciblée avant l'application.",
        "Appliquez une petite quantité et massez doucement par mouvements circulaires jusqu'à absorption.",
        "Utilisez régulièrement matin ou soir et refermez bien le flacon après usage.",
      ],
      perfume: [
        "Vaporisez sur les points de pulsation (poignets, cou, derrière les oreilles).",
        "Appliquez sur peau propre et hydratée pour prolonger la tenue.",
        "Évitez de frotter après vaporisation et conservez à l'abri de la chaleur.",
      ],
      supplement_food: [
        "Respectez la portion recommandée indiquée sur l'emballage.",
        "Consommez de préférence à heure fixe pour un suivi régulier.",
        "Refermez soigneusement après usage et gardez dans un endroit frais et sec.",
      ],
      electronics: [
        "Chargez ou branchez correctement l'appareil avant la première mise en marche.",
        "Allumez-le puis sélectionnez le mode souhaité à l'aide des commandes simples.",
        "Nettoyez avec un chiffon doux sec et rangez à l'abri de l'humidité.",
      ],
      fashion: [
        "Associez la pièce à votre tenue quotidienne ou vos accessoires favoris.",
        "Suivez les conseils d'entretien doux pour préserver l'éclat des matières.",
        "Rangez soigneusement dans un espace sec après utilisation.",
      ],
      home_kitchen: [
        "Essuyez ou rincez avant la première utilisation et placez sur une surface stable.",
        "Utilisez simplement selon l'usage prévu sans forcer les mécanismes.",
        "Nettoyez et séchez soigneusement après chaque utilisation.",
      ],
      fitness_sport: [
        "Ajustez l'équipement à votre morphologie avant de commencer votre séance.",
        "Débutez par un échauffement progressif puis suivez votre programme d'entraînement.",
        "Essuyez après l'effort et conservez dans un endroit aéré.",
      ],
      general: [
        "Vérifiez la mise en place du produit avant la première utilisation.",
        "Utilisez-le régulièrement en suivant les étapes simples adaptées à votre besoin.",
        "Nettoyez et rangez dans un endroit sec après usage.",
      ],
    };

    return [
      "**📌 Présentation du produit :**",
      `**${productName}** est une solution fiable et moderne pensée pour répondre efficacement à vos besoins quotidiens.${overviewExtra}`,
      "",
      "**✨ Caractéristiques :**",
      ...featureByCat[category].map((x) => `• ${x}`),
      "",
      "**💡 Avantages :**",
      `• ${useTags[0] ? `Efficace pour ${useTags[0]}.` : "Gain de temps et confort immédiat dès la première utilisation."}`,
      `• ${useTags[1] ? `Aide notamment à ${useTags[1]}.` : "Résultats constants et fiables qui simplifient votre quotidien."}`,
      "• Conception durable offrant un excellent rapport qualité-prix sur le long terme.",
      "• Convient parfaitement à un usage personnel ou comme idée cadeau utile.",
      "",
      "**📋 Mode d'emploi :**",
      ...usageByCat[category].map((x) => `• ${x}`),
      "",
      "**🧪 Ingrédients et composition :**",
      ...ingredientsLines.map((x) => `• ${x}`),
    ].join("\n");
  }

  // English
  const overviewExtra = wikiSummary
    ? ` ${wikiSummary}`
    : " Thoughtfully crafted to combine reliable everyday quality with effortless usability for consistently great results.";

  const ingredientsLinesEn = realIngredients
    ? [
        `Verified formula: ${realIngredients}.`,
        "Sealed protective packaging preserves freshness, purity, and potency.",
        "Carefully formulated to meet clean daily-care quality standards.",
      ]
    : [
        `Quality materials and components selected specifically for ${productName}.`,
        "Clean, reliable construction designed for safe and comfortable everyday use.",
        "Complete retail-ready package with protective wrapping and essential accessories.",
      ];

  const featuresEn: Record<ProductCategory, string[]> = {
    oil_skincare: [
      "Pure, lightweight texture that absorbs quickly without leaving a heavy or sticky residue.",
      "Sealed protective bottle preserves natural potency, aroma, and freshness.",
      "Multi-purpose versatility suitable for skin, hair, and daily self-care routines.",
      cleanBrand ? `Authentic quality from ${cleanBrand}${cleanQty ? ` (${cleanQty})` : ""}.` : "Gentle enough for consistent everyday care across different routines.",
    ],
    perfume: [
      "Long-lasting scent projection with balanced top, heart, and base notes.",
      "Precision atomizer delivers a fine, even mist every single time.",
      "Versatile profile suited for both daytime wear and evening occasions.",
      "Sleek bottle design built for safe storage and travel convenience.",
    ],
    supplement_food: [
      "Carefully sourced quality packaged to lock in freshness and consistency.",
      "Effortless to incorporate into busy morning or evening routines.",
      cleanBrand ? `Produced by ${cleanBrand}${cleanQty ? ` (${cleanQty})` : ""}.` : "Airtight container protects against moisture and everyday wear.",
      "Balanced daily support crafted for dependable results over time.",
    ],
    electronics: [
      "Responsive, dependable performance built to handle daily tasks smoothly.",
      "Ergonomic build with durable materials designed for long-term reliability.",
      "Plug-and-play simplicity with intuitive controls and wide compatibility.",
      "Efficient power performance keeps you going longer between charges.",
    ],
    fashion: [
      "Timeless, versatile styling that pairs effortlessly with casual or smart outfits.",
      "Comfortable, breathable materials engineered for all-day wear.",
      "Reinforced stitching and refined finishing for lasting durability.",
      "Lightweight feel that stays polished from morning errands to evening plans.",
    ],
    home_kitchen: [
      "Space-saving practical design that makes home and kitchen chores faster.",
      "Durable, easy-clean materials built to withstand frequent daily use.",
      "Consistent performance saves preparation time and reduces clutter.",
      "Clean modern aesthetic that complements any home setup.",
    ],
    fitness_sport: [
      "Supportive, flexible ergonomics allow full range of motion during workouts.",
      "Durable, sweat-friendly materials handle intense training sessions cleanly.",
      "Lightweight and portable for home, gym, or outdoor fitness routines.",
      "Quick setup and adjustment in seconds with zero hassle.",
    ],
    general: [
      "Dependable build quality crafted from durable materials for everyday use.",
      "User-friendly design delivers immediate value right out of the box.",
      useTags[0] ? `Great for ${useTags[0]}.` : "Thoughtful practical details improve comfort, speed, and reliability.",
      "Compact, versatile form factor suitable for home or on-the-go use.",
    ],
  };

  const usageEn: Record<ProductCategory, string[]> = {
    oil_skincare: [
      "Clean and gently pat dry the target area before application for optimal absorption.",
      "Apply a small amount and massage evenly in gentle circular motions.",
      "Use consistently in your daily routine and keep the bottle tightly closed in a cool, dry place.",
    ],
    perfume: [
      "Spray lightly onto pulse points such as wrists, neck, and behind the ears.",
      "Apply over clean, moisturized skin to help the fragrance last longer.",
      "Avoid rubbing after spraying and store away from direct heat or sunlight.",
    ],
    supplement_food: [
      "Follow the recommended serving instructions clearly printed on the label.",
      "Take at a consistent time each day for steady, reliable results.",
      "Reseal tightly after opening and store in a cool, dry cabinet.",
    ],
    electronics: [
      "Ensure the device is properly charged or connected before initial startup.",
      "Power on and adjust settings easily using the intuitive built-in controls.",
      "Wipe with a soft dry cloth after use and store away from moisture.",
    ],
    fashion: [
      "Style effortlessly with your everyday wardrobe or favorite accessories.",
      "Follow gentle care instructions to preserve texture, fit, and color.",
      "Store neatly in a dry closet or organizer between wears.",
    ],
    home_kitchen: [
      "Wipe or rinse gently before first use and place on a stable, flat surface.",
      "Operate smoothly according to its intended daily household purpose.",
      "Clean and dry thoroughly after each use before storing away.",
    ],
    fitness_sport: [
      "Adjust fit and positioning comfortably before starting your exercise session.",
      "Warm up briefly and use with controlled movements throughout your workout.",
      "Wipe clean after training and store in a dry, ventilated space.",
    ],
    general: [
      "Inspect and prepare the item on a clean surface before first use.",
      "Follow simple step-by-step usage for smooth, consistent everyday results.",
      "Keep clean and stored in a dry place to maintain peak condition.",
    ],
  };

  return [
    "**📌 Product Overview:**",
    `**${productName}** is a high-value everyday essential built to deliver dependable performance, lasting quality, and a seamless user experience.${overviewExtra}`,
    "",
    "**✨ Key Features:**",
    ...featuresEn[category].map((x) => `• ${x}`),
    "",
    "**💡 Benefits:**",
    `• ${useTags[0] ? `Ideal for ${useTags[0]}.` : "Saves time and effort while delivering noticeable everyday convenience."}`,
    `• ${useTags[1] ? `Also supports ${useTags[1]}.` : "Solves common daily frustrations with reliable, consistent results."}`,
    "• Built for long-lasting durability, giving you strong overall value.",
    "• Practical, well-presented choice for personal use or thoughtful gifting.",
    "",
    "**📋 How to Use:**",
    ...usageEn[category].map((x) => `• ${x}`),
    "",
    "**🧪 Ingredients & Contents:**",
    ...ingredientsLinesEn.map((x) => `• ${x}`),
  ].join("\n");
}

export async function generateFreeDescription(input: GenerateFreeDescInput): Promise<GenerateFreeDescResult> {
  const productName = typeof input.productName === "string" ? input.productName.trim().slice(0, 180) : "";
  if (productName.length < 2) {
    throw new FreeDescError(
      400,
      "MISSING_PRODUCT_NAME",
      "Please enter a product name first to generate a free description."
    );
  }

  const rawLang = typeof input.lang === "string" ? input.lang : "en";
  const lang: SupportedLang = rawLang === "ar" || rawLang === "fr" ? rawLang : "en";

  const cacheKey = crypto
    .createHash("sha256")
    .update(`${lang}|${productName.toLowerCase()}`)
    .digest("hex");

  const cached = freeResultCache.get(cacheKey);
  if (cached && Date.now() <= cached.expiresAt) {
    return cached.result;
  }

  const candidates = buildSearchCandidates(productName);
  const coreQuery = candidates[1] || candidates[0] || productName;

  const [wikiRes, catalogRes, suggestRes] = await Promise.all([
    fetchWikipediaSummary(candidates, lang),
    fetchOpenProductCatalog(candidates),
    fetchSuggestIntentPhrases(coreQuery, lang),
  ]);

  const combinedText = [
    productName,
    wikiRes?.summary || "",
    catalogRes?.categories || "",
    suggestRes.join(" "),
  ].join(" ");

  const category = detectProductCategory(combinedText);
  const description = synthesizeStructuredDescription({
    productName,
    lang,
    category,
    wikiSummary: wikiRes?.summary || "",
    catalog: catalogRes,
    suggestions: suggestRes,
  });

  const sources: FreeSourceLink[] = [];
  if (wikiRes?.url) {
    sources.push({ title: `Wikipedia: ${wikiRes.title}`, url: wikiRes.url });
  }
  if (catalogRes?.source) {
    sources.push(catalogRes.source);
  }

  const result: GenerateFreeDescResult = {
    productName,
    description,
    sources,
    mode: "keyless-web-research",
  };

  if (freeResultCache.size >= MAX_FREE_CACHE_ENTRIES) {
    const oldest = freeResultCache.keys().next().value;
    if (oldest) freeResultCache.delete(oldest);
  }
  freeResultCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + FREE_CACHE_TTL_MS,
  });

  return result;
}
