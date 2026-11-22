import fs from "node:fs";
import path from "node:path";

export type SupportedLang = "en" | "ar" | "fr";

export interface PublishedReview {
  name: string;
  stars: number;
  text: string;
}

export interface PublishedPageData {
  slug: string;
  ownerId?: string;
  lang: SupportedLang;
  theme: string;
  productName: string;
  description: string;
  descriptionHtml: string;
  price: string;
  currency: string;
  images: string[];
  imageSize: "full" | "large" | "medium" | "small";
  fontSize: "20" | "24" | "28";
  scale: number;
  reviews: PublishedReview[];
  customColors: {
    primary: string;
    bg: string;
    text: string;
    headingLarge: string;
    headingSmall: string;
  };
  enabledContacts: {
    website: boolean;
    whatsapp: boolean;
    instagram: boolean;
    email: boolean;
  };
  website: string;
  whatsapp: string;
  instagram: string;
  email: string;
}

interface FirebaseAppletConfig {
  projectId: string;
  apiKey: string;
  firestoreDatabaseId: string;
}

function getFirebaseConfig(): FirebaseAppletConfig {
  const envProjectId = (process.env.FIREBASE_PROJECT_ID || "").trim();
  const envApiKey = (process.env.FIREBASE_API_KEY || "").trim();
  const envDbId = (process.env.FIREBASE_DATABASE_ID || "").trim();

  try {
    const configPath = path.resolve(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<FirebaseAppletConfig>;
      return {
        projectId: envProjectId || parsed.projectId || "",
        apiKey: envApiKey || parsed.apiKey || "",
        firestoreDatabaseId: envDbId || parsed.firestoreDatabaseId || "(default)",
      };
    }
  } catch {
    // Fall back to environment variables
  }

  return {
    projectId: envProjectId,
    apiKey: envApiKey,
    firestoreDatabaseId: envDbId || "(default)",
  };
}

type FirestoreRestValue = {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  arrayValue?: { values?: FirestoreRestValue[] };
  mapValue?: { fields?: Record<string, FirestoreRestValue> };
};

function decodeFirestoreValue(val: FirestoreRestValue | undefined): unknown {
  if (!val || typeof val !== "object") return undefined;
  if (typeof val.stringValue === "string") return val.stringValue;
  if (typeof val.booleanValue === "boolean") return val.booleanValue;
  if (typeof val.integerValue === "string") return Number(val.integerValue);
  if (typeof val.doubleValue === "number") return val.doubleValue;
  if (val.arrayValue) {
    const arr = Array.isArray(val.arrayValue.values) ? val.arrayValue.values : [];
    return arr.map((item) => decodeFirestoreValue(item));
  }
  if (val.mapValue) {
    const fields = val.mapValue.fields || {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreValue(v);
    }
    return out;
  }
  return undefined;
}

export function isValidSlug(slug: string): boolean {
  return typeof slug === "string" && /^[a-z0-9-]{3,80}$/.test(slug);
}

export async function fetchPublishedPageBySlug(slug: string): Promise<PublishedPageData | null> {
  if (!isValidSlug(slug)) return null;
  const cfg = getFirebaseConfig();
  if (!cfg.projectId || !cfg.apiKey) return null;

  const dbId = cfg.firestoreDatabaseId || "(default)";
  const url =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}` +
    `/databases/${encodeURIComponent(dbId)}/documents/published_pages/${encodeURIComponent(slug)}` +
    `?key=${encodeURIComponent(cfg.apiKey)}`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Firestore REST fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const docJson = (await res.json()) as { fields?: Record<string, FirestoreRestValue> };
  const fields = docJson.fields;
  if (!fields) return null;

  const decoded: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    decoded[k] = decodeFirestoreValue(v);
  }

  const lang: SupportedLang =
    decoded.lang === "ar" || decoded.lang === "fr" || decoded.lang === "en" ? decoded.lang : "en";

  const images = Array.isArray(decoded.images)
    ? decoded.images.filter((x): x is string => typeof x === "string" && /^data:image\/|^https?:\/\//i.test(x))
    : [];

  const rawReviews = Array.isArray(decoded.reviews) ? decoded.reviews : [];
  const reviews: PublishedReview[] = rawReviews
    .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === "object"))
    .map((r) => ({
      name: String(r.name || "").slice(0, 80),
      stars: Math.max(1, Math.min(5, Number(r.stars) || 5)),
      text: String(r.text || "").slice(0, 500),
    }))
    .filter((r) => r.name && r.text);

  const ccRaw = (decoded.customColors && typeof decoded.customColors === "object"
    ? decoded.customColors
    : {}) as Record<string, unknown>;
  const ecRaw = (decoded.enabledContacts && typeof decoded.enabledContacts === "object"
    ? decoded.enabledContacts
    : {}) as Record<string, unknown>;

  const imageSize =
    decoded.imageSize === "full" ||
    decoded.imageSize === "large" ||
    decoded.imageSize === "medium" ||
    decoded.imageSize === "small"
      ? decoded.imageSize
      : "large";

  const fontSize =
    decoded.fontSize === "20" || decoded.fontSize === "24" || decoded.fontSize === "28"
      ? decoded.fontSize
      : "28";

  return {
    slug: typeof decoded.slug === "string" ? decoded.slug : slug,
    lang,
    theme: typeof decoded.theme === "string" ? decoded.theme : "purple-pink",
    productName: typeof decoded.productName === "string" ? decoded.productName : "",
    description: typeof decoded.description === "string" ? decoded.description : "",
    descriptionHtml: typeof decoded.descriptionHtml === "string" ? decoded.descriptionHtml : "",
    price: typeof decoded.price === "string" ? decoded.price : "129",
    currency: typeof decoded.currency === "string" ? decoded.currency : "USD",
    images,
    imageSize,
    fontSize,
    scale: Math.max(75, Math.min(130, Number(decoded.scale) || 100)),
    reviews,
    customColors: {
      primary: typeof ccRaw.primary === "string" ? ccRaw.primary : "",
      bg: typeof ccRaw.bg === "string" ? ccRaw.bg : "",
      text: typeof ccRaw.text === "string" ? ccRaw.text : "",
      headingLarge: typeof ccRaw.headingLarge === "string" ? ccRaw.headingLarge : "",
      headingSmall: typeof ccRaw.headingSmall === "string" ? ccRaw.headingSmall : "",
    },
    enabledContacts: {
      website: Boolean(ecRaw.website),
      whatsapp: Boolean(ecRaw.whatsapp),
      instagram: ecRaw.instagram !== false,
      email: ecRaw.email !== false,
    },
    website: typeof decoded.website === "string" ? decoded.website : "",
    whatsapp: typeof decoded.whatsapp === "string" ? decoded.whatsapp : "",
    instagram: typeof decoded.instagram === "string" ? decoded.instagram : "",
    email: typeof decoded.email === "string" ? decoded.email : "",
  };
}

export function extractFirstImageData(page: PublishedPageData): { mime: string; buffer: Buffer } | null {
  if (!page.images || page.images.length === 0) return null;
  const first = page.images[0];
  const m = first.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/i);
  if (!m) return null;
  try {
    const mime = m[1].toLowerCase() === "image/jpg" ? "image/jpeg" : m[1].toLowerCase();
    const buffer = Buffer.from(m[2], "base64");
    return buffer.length > 0 ? { mime, buffer } : null;
  } catch {
    return null;
  }
}

function escapeHtml(str: unknown): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isValidHexColor(val: string): boolean {
  return typeof val === "string" && /^#[0-9a-fA-F]{6}$/.test(val.trim());
}

function hexLuminance(hex: string): number {
  if (!isValidHexColor(hex)) return 0.5;
  const h = hex.trim().slice(1);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function isDarkHex(hex: string): boolean {
  return hexLuminance(hex) < 0.45;
}

function getContrastTextColor(hex: string): string {
  return hexLuminance(hex) > 0.62 ? "#000000" : "#FFFFFF";
}

interface ThemeTokens {
  pageBg: string;
  headerBg: string;
  headerBorder: string;
  headerLogoColor: string;
  cardBg: string;
  cardBorder: string;
  cardTextShadow: string;
  productNameColor: string;
  priceColor: string;
  deliveryBg: string;
  deliveryBorder: string;
  deliveryColor: string;
  descColor: string;
  orderBtnBg: string;
  orderBtnColor: string;
  formBg: string;
  formBorder: string;
  formText: string;
  inputBg: string;
  inputBorder: string;
  reviewBg: string;
  reviewBorder: string;
  reviewText: string;
  starColor: string;
  footerBorder: string;
  footerText: string;
  footerLink: string;
  orderHeadingColor?: string;
  sectionTitleColor?: string;
  footerHeadingColor?: string;
  fieldLabelColor?: string;
  reviewAuthorColor?: string;
  showcaseBg?: string;
}

const LP_THEMES: Record<string, ThemeTokens> = {
  "purple-pink": {
    pageBg: "#FFFFFF",
    headerBg: "#FFFFFF",
    headerBorder: "#E5E7EB",
    headerLogoColor: "#000000",
    cardBg: "linear-gradient(135deg, #7C3AED 0%, #EC4899 100%)",
    cardBorder: "none",
    cardTextShadow: "0 1px 2px rgba(0, 0, 0, 0.14)",
    productNameColor: "#FFFFFF",
    priceColor: "#FFFFFF",
    deliveryBg: "rgba(255, 255, 255, 0.16)",
    deliveryBorder: "1px solid rgba(255, 255, 255, 0.42)",
    deliveryColor: "#FFFFFF",
    descColor: "#000000",
    orderBtnBg: "#7C3AED",
    orderBtnColor: "#FFFFFF",
    formBg: "#FFFFFF",
    formBorder: "#E5E7EB",
    formText: "#000000",
    inputBg: "#FFFFFF",
    inputBorder: "#E5E7EB",
    reviewBg: "#FFFFFF",
    reviewBorder: "#E5E7EB",
    reviewText: "#000000",
    starColor: "#F59E0B",
    footerBorder: "#E5E7EB",
    footerText: "#000000",
    footerLink: "#7C3AED",
  },
  "black-gold": {
    pageBg: "#0A0A0A",
    headerBg: "#0A0A0A",
    headerBorder: "#D4AF37",
    headerLogoColor: "#D4AF37",
    cardBg: "#111111",
    cardBorder: "1px solid #D4AF37",
    cardTextShadow: "none",
    productNameColor: "#D4AF37",
    priceColor: "#D4AF37",
    deliveryBg: "#0A0A0A",
    deliveryBorder: "1px solid #D4AF37",
    deliveryColor: "#D4AF37",
    descColor: "#FFFFFF",
    orderBtnBg: "#D4AF37",
    orderBtnColor: "#000000",
    formBg: "#1A1A1A",
    formBorder: "#D4AF37",
    formText: "#FFFFFF",
    inputBg: "#1A1A1A",
    inputBorder: "#D4AF37",
    reviewBg: "#1A1A1A",
    reviewBorder: "#D4AF37",
    reviewText: "#FFFFFF",
    starColor: "#D4AF37",
    footerBorder: "#D4AF37",
    footerText: "#FFFFFF",
    footerLink: "#D4AF37",
  },
  "green-nature": {
    pageBg: "#F0FDF4",
    headerBg: "#FFFFFF",
    headerBorder: "#BBF7D0",
    headerLogoColor: "#166534",
    cardBg: "linear-gradient(135deg, #16A34A 0%, #86EFAC 100%)",
    cardBorder: "none",
    cardTextShadow: "0 1px 2px rgba(22, 101, 52, 0.35)",
    productNameColor: "#FFFFFF",
    priceColor: "#FFFFFF",
    deliveryBg: "rgba(22, 101, 52, 0.28)",
    deliveryBorder: "1px solid rgba(255, 255, 255, 0.5)",
    deliveryColor: "#FFFFFF",
    descColor: "#000000",
    orderBtnBg: "#166534",
    orderBtnColor: "#FFFFFF",
    formBg: "#FFFFFF",
    formBorder: "#BBF7D0",
    formText: "#000000",
    inputBg: "#FFFFFF",
    inputBorder: "#BBF7D0",
    reviewBg: "#FFFFFF",
    reviewBorder: "#BBF7D0",
    reviewText: "#000000",
    starColor: "#16A34A",
    footerBorder: "#BBF7D0",
    footerText: "#000000",
    footerLink: "#166534",
  },
  "ocean-blue": {
    pageBg: "#EFF6FF",
    headerBg: "#FFFFFF",
    headerBorder: "#BFDBFE",
    headerLogoColor: "#1E40AF",
    cardBg: "linear-gradient(135deg, #2563EB 0%, #06B6D4 100%)",
    cardBorder: "none",
    cardTextShadow: "0 1px 2px rgba(0, 0, 0, 0.16)",
    productNameColor: "#FFFFFF",
    priceColor: "#FFFFFF",
    deliveryBg: "rgba(255, 255, 255, 0.18)",
    deliveryBorder: "1px solid rgba(255, 255, 255, 0.45)",
    deliveryColor: "#FFFFFF",
    descColor: "#000000",
    orderBtnBg: "#2563EB",
    orderBtnColor: "#FFFFFF",
    formBg: "#FFFFFF",
    formBorder: "#BFDBFE",
    formText: "#000000",
    inputBg: "#FFFFFF",
    inputBorder: "#BFDBFE",
    reviewBg: "#FFFFFF",
    reviewBorder: "#BFDBFE",
    reviewText: "#000000",
    starColor: "#2563EB",
    footerBorder: "#BFDBFE",
    footerText: "#000000",
    footerLink: "#1E40AF",
  },
  "rose-beauty": {
    pageBg: "#FFF1F2",
    headerBg: "#FFFFFF",
    headerBorder: "#FECDD3",
    headerLogoColor: "#BE123C",
    cardBg: "linear-gradient(135deg, #FB7185 0%, #FDA4AF 100%)",
    cardBorder: "none",
    cardTextShadow: "0 1px 2px rgba(190, 18, 60, 0.25)",
    productNameColor: "#FFFFFF",
    priceColor: "#FFFFFF",
    deliveryBg: "rgba(190, 18, 60, 0.22)",
    deliveryBorder: "1px solid rgba(255, 255, 255, 0.48)",
    deliveryColor: "#FFFFFF",
    descColor: "#000000",
    orderBtnBg: "#BE123C",
    orderBtnColor: "#FFFFFF",
    formBg: "#FFFFFF",
    formBorder: "#FECDD3",
    formText: "#000000",
    inputBg: "#FFFFFF",
    inputBorder: "#FECDD3",
    reviewBg: "#FFFFFF",
    reviewBorder: "#FECDD3",
    reviewText: "#000000",
    starColor: "#FB7185",
    footerBorder: "#FECDD3",
    footerText: "#000000",
    footerLink: "#BE123C",
  },
  "minimal-white": {
    pageBg: "#FFFFFF",
    headerBg: "#FFFFFF",
    headerBorder: "#E5E7EB",
    headerLogoColor: "#000000",
    cardBg: "#FFFFFF",
    cardBorder: "1px solid #E5E7EB",
    cardTextShadow: "none",
    productNameColor: "#000000",
    priceColor: "#000000",
    deliveryBg: "#FFFFFF",
    deliveryBorder: "1px solid #E5E7EB",
    deliveryColor: "#000000",
    descColor: "#000000",
    orderBtnBg: "#000000",
    orderBtnColor: "#FFFFFF",
    formBg: "#FFFFFF",
    formBorder: "#E5E7EB",
    formText: "#000000",
    inputBg: "#FFFFFF",
    inputBorder: "#E5E7EB",
    reviewBg: "#FFFFFF",
    reviewBorder: "#E5E7EB",
    reviewText: "#000000",
    starColor: "#000000",
    footerBorder: "#E5E7EB",
    footerText: "#000000",
    footerLink: "#000000",
  },
  "amber-sunset": {
    pageBg: "#FFFBEB",
    headerBg: "#FFFFFF",
    headerBorder: "#FDE68A",
    headerLogoColor: "#B45309",
    cardBg: "linear-gradient(135deg, #F59E0B 0%, #EA580C 100%)",
    cardBorder: "none",
    cardTextShadow: "0 1px 2px rgba(146, 64, 14, 0.25)",
    productNameColor: "#FFFFFF",
    priceColor: "#FFFFFF",
    deliveryBg: "rgba(180, 83, 9, 0.24)",
    deliveryBorder: "1px solid rgba(255, 255, 255, 0.48)",
    deliveryColor: "#FFFFFF",
    descColor: "#000000",
    orderBtnBg: "#B45309",
    orderBtnColor: "#FFFFFF",
    formBg: "#FFFFFF",
    formBorder: "#FDE68A",
    formText: "#000000",
    inputBg: "#FFFFFF",
    inputBorder: "#FDE68A",
    reviewBg: "#FFFFFF",
    reviewBorder: "#FDE68A",
    reviewText: "#000000",
    starColor: "#F59E0B",
    footerBorder: "#FDE68A",
    footerText: "#000000",
    footerLink: "#B45309",
  },
  "emerald-teal": {
    pageBg: "#F0FDFA",
    headerBg: "#FFFFFF",
    headerBorder: "#99F6E4",
    headerLogoColor: "#115E59",
    cardBg: "linear-gradient(135deg, #0D9488 0%, #2DD4BF 100%)",
    cardBorder: "none",
    cardTextShadow: "0 1px 2px rgba(17, 94, 89, 0.28)",
    productNameColor: "#FFFFFF",
    priceColor: "#FFFFFF",
    deliveryBg: "rgba(17, 94, 89, 0.22)",
    deliveryBorder: "1px solid rgba(255, 255, 255, 0.48)",
    deliveryColor: "#FFFFFF",
    descColor: "#000000",
    orderBtnBg: "#115E59",
    orderBtnColor: "#FFFFFF",
    formBg: "#FFFFFF",
    formBorder: "#99F6E4",
    formText: "#000000",
    inputBg: "#FFFFFF",
    inputBorder: "#99F6E4",
    reviewBg: "#FFFFFF",
    reviewBorder: "#99F6E4",
    reviewText: "#000000",
    starColor: "#0D9488",
    footerBorder: "#99F6E4",
    footerText: "#000000",
    footerLink: "#115E59",
  },
  "crimson-red": {
    pageBg: "#FEF2F2",
    headerBg: "#FFFFFF",
    headerBorder: "#FECACA",
    headerLogoColor: "#991B1B",
    cardBg: "linear-gradient(135deg, #DC2626 0%, #F97316 100%)",
    cardBorder: "none",
    cardTextShadow: "0 1px 2px rgba(127, 29, 29, 0.28)",
    productNameColor: "#FFFFFF",
    priceColor: "#FFFFFF",
    deliveryBg: "rgba(153, 27, 27, 0.24)",
    deliveryBorder: "1px solid rgba(255, 255, 255, 0.48)",
    deliveryColor: "#FFFFFF",
    descColor: "#000000",
    orderBtnBg: "#B91C1C",
    orderBtnColor: "#FFFFFF",
    formBg: "#FFFFFF",
    formBorder: "#FECACA",
    formText: "#000000",
    inputBg: "#FFFFFF",
    inputBorder: "#FECACA",
    reviewBg: "#FFFFFF",
    reviewBorder: "#FECACA",
    reviewText: "#000000",
    starColor: "#DC2626",
    footerBorder: "#FECACA",
    footerText: "#000000",
    footerLink: "#991B1B",
  },
  "slate-tech": {
    pageBg: "#0F172A",
    headerBg: "#0F172A",
    headerBorder: "#1E293B",
    headerLogoColor: "#38BDF8",
    cardBg: "linear-gradient(135deg, #1E293B 0%, #0F172A 100%)",
    cardBorder: "1px solid #38BDF8",
    cardTextShadow: "none",
    productNameColor: "#FFFFFF",
    priceColor: "#38BDF8",
    deliveryBg: "#0F172A",
    deliveryBorder: "1px solid #38BDF8",
    deliveryColor: "#38BDF8",
    descColor: "#F8FAFC",
    orderBtnBg: "#38BDF8",
    orderBtnColor: "#0F172A",
    formBg: "#1E293B",
    formBorder: "#334155",
    formText: "#FFFFFF",
    inputBg: "#0F172A",
    inputBorder: "#38BDF8",
    reviewBg: "#1E293B",
    reviewBorder: "#334155",
    reviewText: "#F8FAFC",
    starColor: "#38BDF8",
    footerBorder: "#334155",
    footerText: "#F8FAFC",
    footerLink: "#38BDF8",
  },
  "espresso-sand": {
    pageBg: "#FAF5F0",
    headerBg: "#FFFFFF",
    headerBorder: "#E7D8C9",
    headerLogoColor: "#5C2D16",
    cardBg: "#451A03",
    cardBorder: "1px solid #B48A60",
    cardTextShadow: "none",
    productNameColor: "#FAF5F0",
    priceColor: "#FDE68A",
    deliveryBg: "#5C2D16",
    deliveryBorder: "1px solid #B48A60",
    deliveryColor: "#FAF5F0",
    descColor: "#1C1917",
    orderBtnBg: "#78350F",
    orderBtnColor: "#FFFFFF",
    formBg: "#FFFFFF",
    formBorder: "#E7D8C9",
    formText: "#1C1917",
    inputBg: "#FFFFFF",
    inputBorder: "#D6C3B3",
    reviewBg: "#FFFFFF",
    reviewBorder: "#E7D8C9",
    reviewText: "#1C1917",
    starColor: "#B45309",
    footerBorder: "#E7D8C9",
    footerText: "#1C1917",
    footerLink: "#78350F",
  },
  "royal-indigo": {
    pageBg: "#EEF2FF",
    headerBg: "#FFFFFF",
    headerBorder: "#C7D2FE",
    headerLogoColor: "#312E81",
    cardBg: "linear-gradient(135deg, #4338CA 0%, #6366F1 100%)",
    cardBorder: "none",
    cardTextShadow: "0 1px 2px rgba(49, 46, 129, 0.25)",
    productNameColor: "#FFFFFF",
    priceColor: "#FFFFFF",
    deliveryBg: "rgba(255, 255, 255, 0.18)",
    deliveryBorder: "1px solid rgba(255, 255, 255, 0.45)",
    deliveryColor: "#FFFFFF",
    descColor: "#000000",
    orderBtnBg: "#4338CA",
    orderBtnColor: "#FFFFFF",
    formBg: "#FFFFFF",
    formBorder: "#C7D2FE",
    formText: "#000000",
    inputBg: "#FFFFFF",
    inputBorder: "#C7D2FE",
    reviewBg: "#FFFFFF",
    reviewBorder: "#C7D2FE",
    reviewText: "#000000",
    starColor: "#4F46E5",
    footerBorder: "#C7D2FE",
    footerText: "#000000",
    footerLink: "#312E81",
  },
};

const LP_I18N: Record<
  SupportedLang,
  {
    dir: "ltr" | "rtl";
    deliveryTime: string;
    deliveryFree: string;
    deliveryCod: string;
    orderTitle: string;
    orderBtn: string;
    fieldFullName: string;
    fieldPhone: string;
    fieldCity: string;
    fieldAddress: string;
    fieldQty: string;
    reviewsTitle: string;
    contactTitle: string;
    websiteLabel: string;
    whatsappLabel: string;
    emailLabel: string;
    instagramLabel: string;
    orderSuccessPrefix: string;
    orderSuccessCod: string;
    orderErrorMissing: string;
    whatsappConfirmBtn: string;
    notFoundTitle: string;
    notFoundDesc: string;
  }
> = {
  en: {
    dir: "ltr",
    deliveryTime: "Delivery within 24-48 Hours",
    deliveryFree: "Free Shipping",
    deliveryCod: "Cash on Delivery",
    orderTitle: "Order the Product Now",
    orderBtn: "Order the Product Now",
    fieldFullName: "Full Name",
    fieldPhone: "Phone Number",
    fieldCity: "City",
    fieldAddress: "Address",
    fieldQty: "Quantity",
    reviewsTitle: "Our Customers' Reviews",
    contactTitle: "Contact Us",
    websiteLabel: "Website",
    whatsappLabel: "WhatsApp",
    emailLabel: "Email",
    instagramLabel: "Instagram",
    orderSuccessPrefix: "Thank you! Your order has been received:",
    orderSuccessCod: "Payment method: Cash on Delivery",
    orderErrorMissing: "Please fill in your full name, phone number, city, and address.",
    whatsappConfirmBtn: "Confirm Order via WhatsApp",
    notFoundTitle: "Landing Page Not Found",
    notFoundDesc: "This product link may have been removed or is not yet published.",
  },
  ar: {
    dir: "rtl",
    deliveryTime: "التوصيل خلال 24-48 ساعة",
    deliveryFree: "التوصيل مجاني",
    deliveryCod: "الدفع عند الاستلام",
    orderTitle: "اطلب المنتج الآن",
    orderBtn: "اطلب المنتج الآن",
    fieldFullName: "الاسم الكامل",
    fieldPhone: "رقم الهاتف",
    fieldCity: "المدينة",
    fieldAddress: "العنوان",
    fieldQty: "الكمية",
    reviewsTitle: "آراء عملائنا",
    contactTitle: "تواصل معنا",
    websiteLabel: "الموقع الإلكتروني",
    whatsappLabel: "واتساب",
    emailLabel: "البريد الإلكتروني",
    instagramLabel: "إنستغرام",
    orderSuccessPrefix: "شكراً لك! تم تسجيل طلبك بنجاح:",
    orderSuccessCod: "طريقة الدفع: الدفع عند الاستلام",
    orderErrorMissing: "يرجى إدخال الاسم الكامل ورقم الهاتف والمدينة والعنوان.",
    whatsappConfirmBtn: "تأكيد الطلب عبر واتساب",
    notFoundTitle: "صفحة المنتج غير موجودة",
    notFoundDesc: "قد يكون رابط المنتج غير منشور بعد أو تم حذفه.",
  },
  fr: {
    dir: "ltr",
    deliveryTime: "Livraison sous 24 à 48 heures",
    deliveryFree: "Livraison Gratuite",
    deliveryCod: "Paiement à la livraison",
    orderTitle: "Commander le produit maintenant",
    orderBtn: "Commander le produit maintenant",
    fieldFullName: "Nom complet",
    fieldPhone: "Numéro de téléphone",
    fieldCity: "Ville",
    fieldAddress: "Adresse",
    fieldQty: "Quantité",
    reviewsTitle: "Avis de nos clients",
    contactTitle: "Contactez-nous",
    websiteLabel: "Site web",
    whatsappLabel: "WhatsApp",
    emailLabel: "E-mail",
    instagramLabel: "Instagram",
    orderSuccessPrefix: "Merci ! Votre commande a bien été enregistrée :",
    orderSuccessCod: "Mode de paiement : Paiement à la livraison",
    orderErrorMissing: "Veuillez renseigner votre nom complet, téléphone, ville et adresse.",
    whatsappConfirmBtn: "Confirmer la commande sur WhatsApp",
    notFoundTitle: "Page produit introuvable",
    notFoundDesc: "Ce lien produit n'existe pas encore ou a été supprimé.",
  },
};

function sanitizeDescriptionHtmlForSsr(rawHtml: string, imgWidth: number, imgBorder: string): string {
  if (!rawHtml) return "";
  let clean = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");

  clean = clean.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
    const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const altMatch = attrs.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const src = (srcMatch?.[1] || srcMatch?.[2] || "").trim();
    if (!/^data:image\/|^https?:\/\//i.test(src)) return "";
    const alt = escapeHtml(altMatch?.[1] || altMatch?.[2] || "");
    return `<img src="${escapeHtml(src)}" alt="${alt}" style="display:block;width:${imgWidth}%;max-width:100%;height:auto;border-radius:12px;margin:12px auto;border:${imgBorder};" />`;
  });

  clean = clean.replace(/<iframe\b([^>]*)>[\s\S]*?<\/iframe>/gi, (_m, attrs: string) => {
    const srcMatch = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const src = (srcMatch?.[1] || srcMatch?.[2] || "").trim();
    if (
      !src.startsWith("https://www.youtube.com/embed/") &&
      !src.startsWith("https://player.vimeo.com/video/")
    ) {
      return "";
    }
    return `<iframe src="${escapeHtml(src)}" frameborder="0" allowfullscreen="allowfullscreen" style="display:block;width:${imgWidth}%;max-width:100%;aspect-ratio:16/9;height:auto;border-radius:12px;margin:12px auto;border:${imgBorder};"></iframe>`;
  });

  return clean;
}

function resolveTheme(page: PublishedPageData): ThemeTokens {
  const base = LP_THEMES[page.theme] || LP_THEMES["purple-pink"];
  const resolved: ThemeTokens = {
    ...base,
    orderHeadingColor: base.formText,
    sectionTitleColor: base.descColor,
    footerHeadingColor: base.footerText,
    fieldLabelColor: base.formText,
    reviewAuthorColor: base.reviewText,
    showcaseBg: isDarkHex(base.pageBg) ? base.formBg : "#FFFFFF",
  };

  const cc = page.customColors;
  if (cc && isValidHexColor(cc.bg)) {
    const bgHex = cc.bg.toUpperCase();
    resolved.pageBg = bgHex;
    if (isDarkHex(bgHex)) {
      resolved.headerBg = bgHex;
      resolved.formBg = bgHex;
      resolved.inputBg = bgHex;
      resolved.reviewBg = bgHex;
      resolved.showcaseBg = bgHex;
    } else {
      resolved.headerBg = "#FFFFFF";
      resolved.formBg = "#FFFFFF";
      resolved.inputBg = "#FFFFFF";
      resolved.reviewBg = "#FFFFFF";
      resolved.showcaseBg = "#FFFFFF";
    }
  }

  if (cc && isValidHexColor(cc.primary)) {
    const priHex = cc.primary.toUpperCase();
    const priContrast = getContrastTextColor(priHex);
    resolved.cardBg = priHex;
    resolved.orderBtnBg = priHex;
    resolved.orderBtnColor = priContrast;
    resolved.footerLink = priHex;
    resolved.starColor = priHex;
    resolved.deliveryBg = priContrast === "#FFFFFF" ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.08)";
    resolved.deliveryBorder =
      priContrast === "#FFFFFF" ? "1px solid rgba(255,255,255,0.42)" : "1px solid rgba(0,0,0,0.22)";
    resolved.deliveryColor = priContrast;
    if (!isValidHexColor(cc.headingLarge)) {
      resolved.productNameColor = priContrast;
      resolved.priceColor = priContrast;
    }
  }

  if (cc && isValidHexColor(cc.text)) {
    const txtHex = cc.text.toUpperCase();
    resolved.descColor = txtHex;
    resolved.formText = txtHex;
    resolved.reviewText = txtHex;
    resolved.footerText = txtHex;
    if (!isValidHexColor(cc.headingLarge)) {
      resolved.orderHeadingColor = txtHex;
    }
    if (!isValidHexColor(cc.headingSmall)) {
      resolved.sectionTitleColor = txtHex;
      resolved.footerHeadingColor = txtHex;
      resolved.fieldLabelColor = txtHex;
      resolved.reviewAuthorColor = txtHex;
    }
  }

  if (cc && isValidHexColor(cc.headingLarge)) {
    const hlHex = cc.headingLarge.toUpperCase();
    resolved.productNameColor = hlHex;
    resolved.priceColor = hlHex;
    resolved.orderHeadingColor = hlHex;
  }

  if (cc && isValidHexColor(cc.headingSmall)) {
    const hsHex = cc.headingSmall.toUpperCase();
    resolved.headerLogoColor = hsHex;
    resolved.sectionTitleColor = hsHex;
    resolved.footerHeadingColor = hsHex;
    resolved.fieldLabelColor = hsHex;
    resolved.reviewAuthorColor = hsHex;
  }

  return resolved;
}

function formatPriceText(page: PublishedPageData): string {
  const priceVal = (page.price || "129").trim();
  const cur = page.currency || "USD";
  if (page.lang === "ar") {
    const arMap: Record<string, string> = {
      USD: "دولار",
      EUR: "يورو",
      GBP: "جنيه إسترليني",
      SAR: "ر.س",
      AED: "د.إ",
      MAD: "د.م",
    };
    return `${priceVal} ${arMap[cur] || cur}`;
  }
  if (page.lang === "fr") {
    const frMap: Record<string, string> = {
      USD: "$",
      EUR: "€",
      GBP: "£",
      SAR: "SAR",
      AED: "AED",
      MAD: "DH",
    };
    return `${cur} ${priceVal} ${frMap[cur] || cur}`;
  }
  const enMap: Record<string, string> = {
    USD: "$",
    EUR: "€",
    GBP: "£",
    SAR: "SAR",
    AED: "AED",
    MAD: "MAD",
  };
  const sym = enMap[cur] || cur;
  return sym === cur ? `${cur} ${priceVal}` : `${cur} ${priceVal} ${sym}`;
}

export function renderPublishedLandingHtml(page: PublishedPageData, origin: string): string {
  const lp = LP_I18N[page.lang] || LP_I18N.en;
  const th = resolveTheme(page);
  const isGradientTheme = [
    "purple-pink",
    "green-nature",
    "ocean-blue",
    "rose-beauty",
    "amber-sunset",
    "emerald-teal",
    "crimson-red",
    "royal-indigo",
  ].includes(page.theme);
  const isBlackGold = page.theme === "black-gold";
  const isSlateTech = page.theme === "slate-tech";
  const isMinimal = page.theme === "minimal-white";

  let imgWidth = 100;
  if (page.imageSize === "large") imgWidth = 82;
  else if (page.imageSize === "medium") imgWidth = 62;
  else if (page.imageSize === "small") imgWidth = 42;
  imgWidth = Math.min(100, Math.max(25, Math.round(imgWidth * (page.scale / 100))));

  const titlePx = Math.round((Number(page.fontSize) || 28) * (page.scale / 100));
  const pricePx = Math.max(20, Math.round(25 * (titlePx / 28)));
  const descPx = Math.max(17, Math.round(titlePx * 0.72));

  const imgBorder = isBlackGold
    ? "1px solid #D4AF37"
    : isSlateTech
      ? "1px solid #38BDF8"
      : `1px solid ${th.formBorder}`;

  const descHtml = page.descriptionHtml.trim()
    ? sanitizeDescriptionHtmlForSsr(page.descriptionHtml, imgWidth, imgBorder)
    : escapeHtml(page.description).replace(/\n/g, "<br>");

  const galleryHtml =
    page.images.length > 0
      ? `<div class="lp-gallery">${page.images
          .map(
            (src) =>
              `<img src="${escapeHtml(src)}" alt="${escapeHtml(page.productName)}" style="width:${imgWidth}%;max-width:100%;border:${imgBorder};" />`,
          )
          .join("")}</div>`
      : "";

  const deliveryClass = isMinimal ? "lp-delivery-box is-pill" : "lp-delivery-box";
  const deliveryStyle = `background:${th.deliveryBg};border:${th.deliveryBorder};color:${th.deliveryColor};`;
  const deliveryGridHtml = `<div class="lp-delivery-grid">
    <div class="${deliveryClass}" style="${deliveryStyle}">🚚<span class="lp-delivery-label" style="color:${th.deliveryColor};">${escapeHtml(lp.deliveryTime)}</span></div>
    <div class="${deliveryClass}" style="${deliveryStyle}">🎁<span class="lp-delivery-label" style="color:${th.deliveryColor};">${escapeHtml(lp.deliveryFree)}</span></div>
    <div class="${deliveryClass}" style="${deliveryStyle}">💵<span class="lp-delivery-label" style="color:${th.deliveryColor};">${escapeHtml(lp.deliveryCod)}</span></div>
  </div>`;

  const priceText = formatPriceText(page);
  const cardExtraStyle = isBlackGold
    ? "box-shadow:inset 0 0 0 4px #111111,inset 0 0 0 5px rgba(212,175,55,0.35);"
    : "";

  const mainProductSectionHtml = isGradientTheme
    ? `<div class="lp-product-card" style="background:${th.cardBg};border:${th.cardBorder};text-shadow:${th.cardTextShadow};">
        <h1 class="lp-title" style="font-size:${titlePx}px;color:${th.productNameColor};">${escapeHtml(page.productName)}</h1>
        <div class="lp-price-text" style="font-size:${pricePx}px;color:${th.priceColor};">${escapeHtml(priceText)}</div>
        ${deliveryGridHtml}
      </div>
      <div class="lp-showcase-card" style="background:${th.showcaseBg};border:1px solid ${th.formBorder};color:${th.descColor};">
        ${galleryHtml}
        <div class="lp-desc" style="font-size:${descPx}px;color:${th.descColor};margin-bottom:0;">${descHtml}</div>
      </div>`
    : `<div class="lp-product-card" style="background:${th.cardBg};border:${th.cardBorder};text-shadow:${th.cardTextShadow};${cardExtraStyle}">
        ${galleryHtml}
        <h1 class="lp-title" style="font-size:${titlePx}px;color:${th.productNameColor};">${escapeHtml(page.productName)}</h1>
        <div class="lp-price-text" style="font-size:${pricePx}px;color:${th.priceColor};">${escapeHtml(priceText)}</div>
        ${deliveryGridHtml}
      </div>
      <div class="lp-desc" style="font-size:${descPx}px;color:${th.descColor};">${descHtml}</div>`;

  const reviewsHtml =
    page.reviews.length > 0
      ? `<section class="lp-reviews-section">
          <h2 class="lp-section-title" style="color:${th.sectionTitleColor};">${escapeHtml(lp.reviewsTitle)}</h2>
          <div class="lp-reviews-list">
            ${page.reviews
              .map((rev) => {
                const starsText = "★★★★★".slice(0, rev.stars) + "☆☆☆☆☆".slice(0, 5 - rev.stars);
                return `<div class="lp-review-card" style="background:${th.reviewBg};border:1px solid ${th.reviewBorder};color:${th.reviewText};">
                  <div class="lp-review-stars" style="color:${th.starColor};">${starsText}</div>
                  <div class="lp-review-author" style="color:${th.reviewAuthorColor};">${escapeHtml(rev.name)}</div>
                  <p class="lp-review-body" style="color:${th.reviewText};">${escapeHtml(rev.text)}</p>
                </div>`;
              })
              .join("")}
          </div>
        </section>`
      : "";

  const websiteHref =
    page.enabledContacts.website && page.website.trim()
      ? /^https?:\/\//i.test(page.website.trim())
        ? page.website.trim()
        : `https://${page.website.trim()}`
      : "";
  const whatsappDigits =
    page.enabledContacts.whatsapp && page.whatsapp.trim() ? page.whatsapp.replace(/[^\d]/g, "") : "";
  const whatsappHref = whatsappDigits ? `https://wa.me/${whatsappDigits}` : "";
  const instagramHandle =
    page.enabledContacts.instagram && page.instagram.trim()
      ? page.instagram.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, "").replace(/^@+/, "")
      : "";
  const instagramHref = instagramHandle ? `https://instagram.com/${encodeURIComponent(instagramHandle)}` : "";
  const email = page.enabledContacts.email ? page.email.trim() : "";

  const contactItems: string[] = [];
  if (websiteHref) {
    const disp = page.website.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    contactItems.push(
      `<span>${escapeHtml(lp.websiteLabel)}: <a style="color:${th.footerLink};text-decoration:none;" href="${escapeHtml(websiteHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(disp)}</a></span>`,
    );
  }
  if (whatsappHref) {
    contactItems.push(
      `<span>${escapeHtml(lp.whatsappLabel)}: <a style="color:${th.footerLink};text-decoration:none;" href="${escapeHtml(whatsappHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(page.whatsapp.trim())}</a></span>`,
    );
  }
  if (instagramHandle) {
    contactItems.push(
      `<span>${escapeHtml(lp.instagramLabel)}: <a style="color:${th.footerLink};text-decoration:none;" href="${escapeHtml(instagramHref)}" target="_blank" rel="noopener noreferrer">@${escapeHtml(instagramHandle)}</a></span>`,
    );
  }
  if (email) {
    contactItems.push(
      `<span>${escapeHtml(lp.emailLabel)}: <a style="color:${th.footerLink};text-decoration:none;" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></span>`,
    );
  }

  const contactHtml =
    contactItems.length > 0
      ? `<footer class="lp-contact-footer" style="border-top:1px solid ${th.footerBorder};color:${th.footerText};">
          <h2 class="lp-section-title" style="font-size:17px;color:${th.footerHeadingColor};">${escapeHtml(lp.contactTitle)}</h2>
          <div class="lp-contact-items" style="color:${th.footerText};">${contactItems.join("")}</div>
        </footer>`
      : "";

  const cleanOrigin = origin.replace(/\/+$/, "");
  const pageUrl = `${cleanOrigin}/p/${encodeURIComponent(page.slug)}`;
  const ogDesc = (page.description || page.productName || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  const ogImageTag =
    page.images.length > 0
      ? `<meta property="og:image" content="${escapeHtml(`${cleanOrigin}/api/p-image?slug=${encodeURIComponent(page.slug)}`)}" />`
      : "";

  const inputStyle = `background:${th.inputBg};border:1px solid ${th.inputBorder};color:${th.formText};`;

  const css = `*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;padding:0;background:${th.pageBg};color:${th.descColor};font-family:'Cairo','Tajawal',system-ui,-apple-system,'Segoe UI',Roboto,Tahoma,Arial,sans-serif;font-weight:700;line-height:1.85;-webkit-font-smoothing:antialiased}
.lp-doc{min-height:100vh}
.lp-header{padding:14px 18px;display:flex;align-items:center;justify-content:center;gap:8px;font-weight:900;font-size:18px}
.lp-container{max-width:760px;margin:0 auto;padding:22px 18px 42px}
.lp-product-card{border-radius:16px;padding:24px 18px;margin-bottom:18px;text-align:center}
.lp-showcase-card{border-radius:16px;padding:20px;margin-bottom:18px;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,0.05)}
.lp-title{margin:0 0 8px 0;font-weight:900;line-height:1.3;text-align:center}
.lp-price-text{margin:0 0 16px 0;font-weight:900;line-height:1.25;text-align:center}
.lp-gallery{display:flex;flex-direction:column;align-items:center;gap:14px;margin:12px 0 16px}
.lp-gallery img{display:block;height:auto;border-radius:12px;object-fit:cover}
.lp-desc{line-height:1.9;margin:0 0 18px 0;font-weight:700;white-space:normal;word-break:break-word;text-align:center}
.lp-desc strong,.lp-desc b{font-weight:900}
.lp-desc p,.lp-desc div{margin:0 0 10px 0}
.lp-desc img,.lp-desc video{display:block;max-width:100%;height:auto;border-radius:12px;margin:12px auto}
.lp-desc iframe{display:block;max-width:100%;aspect-ratio:16/9;height:auto;border-radius:12px;margin:12px auto}
.lp-delivery-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}
.lp-delivery-box{border-radius:10px;padding:12px 10px;text-align:center}
.lp-delivery-box.is-pill{border-radius:999px;padding:9px 10px}
.lp-delivery-label{font-size:14px;font-weight:900;display:block;margin-top:4px}
.lp-cta-jump{display:block;width:100%;padding:15px 18px;border-radius:12px;font-size:17px;font-weight:900;text-align:center;text-decoration:none;margin-bottom:24px;box-shadow:0 4px 14px rgba(0,0,0,0.1)}
.lp-order-box{border-radius:16px;padding:22px 18px;margin-bottom:28px}
.lp-order-heading{margin:0 0 16px 0;font-size:22px;font-weight:900;text-align:center}
.lp-form-field{margin-bottom:12px}
.lp-form-field label{display:block;font-size:15px;font-weight:900;margin-bottom:5px}
.lp-form-field input{width:100%;padding:12px 13px;border-radius:8px;font-size:16px;font-weight:700;font-family:inherit}
.lp-order-submit{width:100%;margin-top:8px;padding:14px 18px;border:none;border-radius:10px;font-size:17px;font-weight:900;cursor:pointer;font-family:inherit}
.lp-order-confirm{margin-top:14px;padding:14px;border-radius:10px;background:#f0fdf4;border:1px solid #86efac;color:#111111;font-size:15px;font-weight:800;display:none;text-align:center}
.lp-wa-confirm{display:inline-block;margin-top:10px;padding:10px 16px;border-radius:8px;background:#16a34a;color:#ffffff;font-weight:900;text-decoration:none;font-size:14px}
.lp-reviews-section{margin-bottom:28px}
.lp-section-title{margin:0 0 14px 0;font-size:21px;font-weight:900;text-align:center}
.lp-reviews-list{display:grid;grid-template-columns:1fr;gap:10px}
.lp-review-card{border-radius:10px;padding:14px}
.lp-review-stars{font-size:17px;margin-bottom:4px;font-weight:900}
.lp-review-author{font-weight:900;font-size:15px}
.lp-review-body{margin:5px 0 0 0;font-size:16px;font-weight:700;line-height:1.75}
.lp-contact-footer{padding-top:18px;text-align:center}
.lp-contact-items{display:flex;flex-wrap:wrap;justify-content:center;gap:16px;font-size:16px;font-weight:800}
@media(max-width:640px){.lp-delivery-grid{grid-template-columns:1fr}}`;

  const orderScript = `(function(){
    var f=document.getElementById('lpOrderForm');
    var m=document.getElementById('lpOrderConfirm');
    if(!f||!m)return;
    var waDigits=${JSON.stringify(whatsappDigits)};
    var prod=${JSON.stringify(page.productName)};
    var priceStr=${JSON.stringify(priceText)};
    var waBtnText=${JSON.stringify(lp.whatsappConfirmBtn)};
    f.addEventListener('submit',function(e){
      e.preventDefault();
      var fd=new FormData(f);
      var n=(fd.get('fullName')||'').toString().trim();
      var p=(fd.get('phone')||'').toString().trim();
      var c=(fd.get('city')||'').toString().trim();
      var a=(fd.get('address')||'').toString().trim();
      var q=(fd.get('quantity')||'1').toString().trim();
      if(!n||!p||!c||!a){
        m.style.display='block';
        m.style.background='#fef2f2';
        m.style.borderColor='#fca5a5';
        m.textContent=${JSON.stringify(lp.orderErrorMissing)};
        return;
      }
      m.style.display='block';
      m.style.background='#f0fdf4';
      m.style.borderColor='#86efac';
      m.textContent=${JSON.stringify(lp.orderSuccessPrefix)}+' '+n+' ('+q+') — '+c+' — '+${JSON.stringify(lp.orderSuccessCod)};
      if(waDigits){
        var msg=prod+' ('+priceStr+')\\n'+n+'\\n'+p+'\\n'+c+' - '+a+'\\nQty: '+q;
        var aEl=document.createElement('a');
        aEl.className='lp-wa-confirm';
        aEl.href='https://wa.me/'+waDigits+'?text='+encodeURIComponent(msg);
        aEl.target='_blank';
        aEl.rel='noopener noreferrer';
        aEl.textContent=waBtnText;
        m.appendChild(document.createElement('br'));
        m.appendChild(aEl);
      }
      f.reset();
    });
  })();`;

  return `<!doctype html>
<html lang="${page.lang}" dir="${lp.dir}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(page.productName)} — ${escapeHtml(priceText)}</title>
  <meta name="description" content="${escapeHtml(ogDesc)}" />
  <meta property="og:type" content="product" />
  <meta property="og:title" content="${escapeHtml(page.productName)} — ${escapeHtml(priceText)}" />
  <meta property="og:description" content="${escapeHtml(ogDesc)}" />
  <meta property="og:url" content="${escapeHtml(pageUrl)}" />
  ${ogImageTag}
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@700;800;900&display=swap" />
  <style>${css}</style>
</head>
<body>
  <div class="lp-doc" dir="${lp.dir}" style="background:${th.pageBg};color:${th.descColor};">
    <div class="lp-header" style="background:${th.headerBg};border-bottom:1px solid ${th.headerBorder};color:${th.headerLogoColor};">
      <span>${escapeHtml(page.productName)}</span>
    </div>
    <div class="lp-container">
      ${mainProductSectionHtml}
      <a href="#lpOrderBox" class="lp-cta-jump" style="background:${th.orderBtnBg};color:${th.orderBtnColor};">${escapeHtml(lp.orderBtn)}</a>
      <section id="lpOrderBox" class="lp-order-box" style="background:${th.formBg};border:1px solid ${th.formBorder};color:${th.formText};">
        <h2 class="lp-order-heading" style="color:${th.orderHeadingColor};">${escapeHtml(lp.orderTitle)}</h2>
        <form id="lpOrderForm">
          <div class="lp-form-field"><label style="color:${th.fieldLabelColor};">${escapeHtml(lp.fieldFullName)}</label><input style="${inputStyle}" type="text" name="fullName" required /></div>
          <div class="lp-form-field"><label style="color:${th.fieldLabelColor};">${escapeHtml(lp.fieldPhone)}</label><input style="${inputStyle}" type="tel" name="phone" required /></div>
          <div class="lp-form-field"><label style="color:${th.fieldLabelColor};">${escapeHtml(lp.fieldCity)}</label><input style="${inputStyle}" type="text" name="city" required /></div>
          <div class="lp-form-field"><label style="color:${th.fieldLabelColor};">${escapeHtml(lp.fieldAddress)}</label><input style="${inputStyle}" type="text" name="address" required /></div>
          <div class="lp-form-field"><label style="color:${th.fieldLabelColor};">${escapeHtml(lp.fieldQty)}</label><input style="${inputStyle}" type="number" name="quantity" min="1" value="1" required /></div>
          <button type="submit" class="lp-order-submit" style="background:${th.orderBtnBg};color:${th.orderBtnColor};">${escapeHtml(lp.orderBtn)}</button>
          <div id="lpOrderConfirm" class="lp-order-confirm"></div>
        </form>
      </section>
      ${reviewsHtml}
      ${contactHtml}
    </div>
  </div>
  <script>${orderScript}</script>
</body>
</html>`;
}

export function renderNotFoundLandingHtml(lang: SupportedLang = "ar"): string {
  const lp = LP_I18N[lang] || LP_I18N.ar;
  return `<!doctype html>
<html lang="${lang}" dir="${lp.dir}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(lp.notFoundTitle)}</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@700;800;900&display=swap" />
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f8fafc;color:#0f172a;font-family:'Cairo',system-ui,sans-serif;text-align:center}
    .card{max-width:460px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px 24px;box-shadow:0 8px 24px rgba(0,0,0,0.06)}
    h1{margin:0 0 10px;font-size:24px;font-weight:900}
    p{margin:0 0 20px;font-size:16px;font-weight:700;color:#334155;line-height:1.7}
    a{display:inline-block;padding:12px 20px;border-radius:10px;background:linear-gradient(135deg,#7c3aed,#ec4899);color:#fff;font-weight:900;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(lp.notFoundTitle)}</h1>
    <p>${escapeHtml(lp.notFoundDesc)}</p>
    <a href="/">Landing Page Pro</a>
  </div>
</body>
</html>`;
}
