import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  Bytes,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import firebaseConfig from "../firebase-applet-config.json";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

enum OperationType {
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
  LIST = "list",
  GET = "get",
  WRITE = "write",
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error("Firestore Error: ", JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, "test", "connection"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("the client is offline")) {
      console.error("Please check your Firebase configuration.");
    }
  }
}
void testConnection();

export interface FreeLinkPayloadInput {
  lang: "en" | "ar" | "fr";
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
  reviews: { name: string; stars: number; text: string }[];
  customColors: {
    primary: string | null;
    bg: string | null;
    text: string | null;
    headingLarge: string | null;
    headingSmall: string | null;
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
  footerConfig?: {
    showDeliveryTime?: boolean;
    showDeliveryFree?: boolean;
    showDeliveryCod?: boolean;
    deliveryTimeText?: string;
    deliveryFreeText?: string;
    deliveryCodText?: string;
    showPrivacy?: boolean;
    privacyTitle?: string;
    privacyText?: string;
    themeMode?: "auto" | "accent" | "custom";
    bgColor?: string | null;
    textColor?: string | null;
  };
  domain?: string;
}

const SECRETS_STORAGE_KEY = "lp_page_lock_secrets";

function getStoredSecretsMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SECRETS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveStoredSecret(slug: string, secret: string): void {
  try {
    const map = getStoredSecretsMap();
    map[slug] = secret;
    localStorage.setItem(SECRETS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage quota errors
  }
}

function generateRandomToken(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < arr.length; i++) {
    out += chars[arr[i] % chars.length];
  }
  return out;
}

function generateRandomLowerSlugSuffix(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < arr.length; i++) {
    out += chars[arr[i] % chars.length];
  }
  return out;
}

const ARABIC_CHAR_MAP: Record<string, string> = {
  "ا": "a", "أ": "a", "إ": "a", "آ": "a", "ٱ": "a",
  "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h", "خ": "kh",
  "د": "d", "ذ": "dh", "ر": "r", "ز": "z", "س": "s", "ش": "sh",
  "ص": "s", "ض": "d", "ط": "t", "ظ": "z", "ع": "a", "غ": "gh",
  "ف": "f", "ق": "q", "ك": "k", "ل": "l", "م": "m", "ن": "n",
  "ه": "h", "ة": "a", "و": "o", "ؤ": "o", "ي": "i", "ى": "a", "ئ": "i",
  "پ": "p", "چ": "ch", "ڤ": "v", "گ": "g", "ڨ": "g", "ڭ": "g",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

export function slugifyProductName(productName?: string): string {
  const raw = String(productName || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "");

  let mapped = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    mapped += ARABIC_CHAR_MAP[ch] ?? ch;
  }

  return mapped
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export function createAutoSlug(productName?: string, withSuffix = true): string {
  const base = slugifyProductName(productName);
  if (!withSuffix && base.length >= 3) {
    return base;
  }
  const suffix = generateRandomLowerSlugSuffix(5);
  return base ? `${base}-${suffix}` : `product-${suffix}`;
}

async function computeNonceProofBytes(nonce: string, secret: string): Promise<Bytes> {
  const encoded = new TextEncoder().encode(`${nonce}:${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Bytes.fromUint8Array(new Uint8Array(digest));
}

function stripInlineVideoDataUrls(html: string): { cleanedHtml: string; removedVideoData: boolean } {
  let removedVideoData = false;
  const cleanedHtml = String(html || "").replace(
    /<video\b[^>]*\bsrc\s*=\s*(?:"data:video\/[^"]*"|'data:video\/[^']*')[^>]*>(?:[\s\S]*?<\/video>)?/gi,
    () => {
      removedVideoData = true;
      return "";
    },
  );
  return { cleanedHtml, removedVideoData };
}

function clampHex(val: string | null | undefined): string {
  return typeof val === "string" && /^#[0-9a-fA-F]{6}$/.test(val.trim()) ? val.trim().toUpperCase() : "";
}

function sanitizeSlugStrict(raw: string, productName?: string): string {
  const cleaned = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return cleaned.length >= 3 ? cleaned : createAutoSlug(productName, false);
}

async function syncFreeLink(
  requestedSlug: string,
  input: FreeLinkPayloadInput,
): Promise<{ slug: string; url: string; trimmedMedia: boolean }> {
  let slug = sanitizeSlugStrict(requestedSlug || createAutoSlug(input.productName, false), input.productName);
  const secrets = getStoredSecretsMap();
  let secret = secrets[slug];

  const { cleanedHtml, removedVideoData } = stripInlineVideoDataUrls(input.descriptionHtml);
  let safeHtml = cleanedHtml.slice(0, 245000);
  let trimmedMedia = removedVideoData;

  const safeImages = (Array.isArray(input.images) ? input.images : [])
    .filter((img) => typeof img === "string" && /^data:image\//i.test(img) && img.length <= 275000)
    .slice(0, 6);

  const safeReviews = (Array.isArray(input.reviews) ? input.reviews : [])
    .slice(0, 20)
    .map((r) => ({
      name: String(r?.name || "").trim().slice(0, 80),
      stars: Math.max(1, Math.min(5, Math.round(Number(r?.stars) || 5))),
      text: String(r?.text || "").trim().slice(0, 500),
    }))
    .filter((r) => r.name && r.text);

  const allowedTheme = /^[a-z0-9-]{1,40}$/.test(input.theme || "") ? input.theme : "purple-pink";
  const allowedCurrency = ["USD", "EUR", "GBP", "SAR", "AED", "MAD"].includes(input.currency)
    ? input.currency
    : "USD";
  const allowedImgSize = ["full", "large", "medium", "small"].includes(input.imageSize)
    ? input.imageSize
    : "large";
  const allowedFontSize = ["20", "24", "28"].includes(String(input.fontSize))
    ? String(input.fontSize)
    : "28";

  const en = {
    website: Boolean(input.enabledContacts?.website),
    whatsapp: Boolean(input.enabledContacts?.whatsapp),
    instagram: input.enabledContacts?.instagram !== false,
    email: input.enabledContacts?.email !== false,
  };

  const fcRaw = input.footerConfig;
  const fcThemeMode =
    fcRaw?.themeMode === "accent" || fcRaw?.themeMode === "custom" ? fcRaw.themeMode : "auto";
  const safeFooterConfig = {
    showDeliveryTime: fcRaw?.showDeliveryTime !== false,
    showDeliveryFree: fcRaw?.showDeliveryFree !== false,
    showDeliveryCod: fcRaw?.showDeliveryCod !== false,
    deliveryTimeText: String(fcRaw?.deliveryTimeText || "").trim().slice(0, 120),
    deliveryFreeText: String(fcRaw?.deliveryFreeText || "").trim().slice(0, 120),
    deliveryCodText: String(fcRaw?.deliveryCodText || "").trim().slice(0, 120),
    showPrivacy: fcRaw?.showPrivacy !== false,
    privacyTitle: String(fcRaw?.privacyTitle || "").trim().slice(0, 120),
    privacyText: String(fcRaw?.privacyText || "").trim().slice(0, 2000),
    themeMode: fcThemeMode,
    bgColor: clampHex(fcRaw?.bgColor),
    textColor: clampHex(fcRaw?.textColor),
  };

  let workingImages = safeImages.slice();
  const buildMutableFields = (imgs: string[], htmlStr: string) => ({
    lang: (input.lang === "ar" || input.lang === "fr" ? input.lang : "en") as "en" | "ar" | "fr",
    theme: allowedTheme,
    productName: (String(input.productName || "").trim() || "Product").slice(0, 140),
    description: String(input.description || "").trim().slice(0, 6000),
    descriptionHtml: htmlStr,
    price: (String(input.price || "").trim() || "129").slice(0, 32),
    currency: allowedCurrency,
    images: imgs,
    imageSize: allowedImgSize,
    fontSize: allowedFontSize,
    scale: Math.max(75, Math.min(130, Math.round(Number(input.scale) || 100))),
    reviews: safeReviews,
    customColors: {
      primary: clampHex(input.customColors?.primary),
      bg: clampHex(input.customColors?.bg),
      text: clampHex(input.customColors?.text),
      headingLarge: clampHex(input.customColors?.headingLarge),
      headingSmall: clampHex(input.customColors?.headingSmall),
    },
    enabledContacts: en,
    website: en.website ? String(input.website || "").trim().slice(0, 300) : "",
    whatsapp: en.whatsapp ? String(input.whatsapp || "").trim().slice(0, 60) : "",
    instagram: en.instagram ? String(input.instagram || "").trim().slice(0, 120) : "",
    email: en.email ? String(input.email || "").trim().slice(0, 160) : "",
    footerConfig: safeFooterConfig,
    domain: String(input.domain || "").trim().slice(0, 300),
  });

  let mutableFields = buildMutableFields(workingImages, safeHtml);
  while (new Blob([JSON.stringify(mutableFields)]).size > 860000 && workingImages.length > 1) {
    workingImages.pop();
    trimmedMedia = true;
    mutableFields = buildMutableFields(workingImages, safeHtml);
  }
  if (new Blob([JSON.stringify(mutableFields)]).size > 880000) {
    safeHtml = safeHtml.replace(/<img\b[^>]*>/gi, "").slice(0, 245000);
    trimmedMedia = true;
    mutableFields = buildMutableFields(workingImages, safeHtml);
  }

  let pageSnap;
  try {
    pageSnap = await getDoc(doc(db, "published_pages", slug));
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, `published_pages/${slug}`);
  }

  let isExisting = pageSnap.exists();

  // If this slug exists in Firestore and this browser does not hold its secret, allocate a fresh unique slug transparently
  if (isExisting && !secret) {
    slug = createAutoSlug(input.productName);
    isExisting = false;
  }

  const pageRef = doc(db, "published_pages", slug);
  const lockRef = doc(db, "page_locks", slug);
  const nonce = generateRandomToken(20);

  if (!isExisting) {
    secret = generateRandomToken(32);
    const nonceProof = await computeNonceProofBytes(nonce, secret);
    const batch = writeBatch(db);
    batch.set(lockRef, {
      secret,
      nonce,
      nonceProof,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(pageRef, {
      slug,
      ...mutableFields,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `published_pages/${slug}`);
    }
    saveStoredSecret(slug, secret);
  } else {
    const nonceProof = await computeNonceProofBytes(nonce, secret);
    const batch = writeBatch(db);
    batch.update(lockRef, {
      nonce,
      nonceProof,
      updatedAt: serverTimestamp(),
    });
    batch.update(pageRef, {
      ...mutableFields,
      updatedAt: serverTimestamp(),
    });

    try {
      await batch.commit();
    } catch (err) {
      // If lock secret didn't match (e.g., stale lock), fall back gracefully to a fresh slug
      const fallbackSlug = createAutoSlug(input.productName);
      const fallbackSecret = generateRandomToken(32);
      const fallbackNonce = generateRandomToken(20);
      const fallbackProof = await computeNonceProofBytes(fallbackNonce, fallbackSecret);
      const retryBatch = writeBatch(db);
      retryBatch.set(doc(db, "page_locks", fallbackSlug), {
        secret: fallbackSecret,
        nonce: fallbackNonce,
        nonceProof: fallbackProof,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      retryBatch.set(doc(db, "published_pages", fallbackSlug), {
        slug: fallbackSlug,
        ...mutableFields,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      try {
        await retryBatch.commit();
      } catch (retryErr) {
        handleFirestoreError(retryErr, OperationType.WRITE, `published_pages/${fallbackSlug}`);
      }
      saveStoredSecret(fallbackSlug, fallbackSecret);
      return {
        slug: fallbackSlug,
        url: `${window.location.origin}/p/${encodeURIComponent(fallbackSlug)}`,
        trimmedMedia,
      };
    }
  }

  return {
    slug,
    url: `${window.location.origin}/p/${encodeURIComponent(slug)}`,
    trimmedMedia,
  };
}

async function loadPublishedPage(slug: string): Promise<Record<string, unknown> | null> {
  const path = `published_pages/${slug}`;
  try {
    const snap = await getDoc(doc(db, "published_pages", slug));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

declare global {
  interface Window {
    LPCloud?: {
      slugifyProductName: typeof slugifyProductName;
      createAutoSlug: typeof createAutoSlug;
      syncFreeLink: typeof syncFreeLink;
      loadPublishedPage: typeof loadPublishedPage;
      projectId: string;
    };
  }
}

window.LPCloud = {
  slugifyProductName,
  createAutoSlug,
  syncFreeLink,
  loadPublishedPage,
  projectId: firebaseConfig.projectId,
};
