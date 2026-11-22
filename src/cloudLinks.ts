import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  where,
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

export interface CloudUserSummary {
  uid: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
}

export interface PublishPayloadInput {
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
}

export interface PublishedLinkItem {
  slug: string;
  productName: string;
  price: string;
  currency: string;
  link: string;
  updatedAtMs: number;
  data: Record<string, unknown>;
}

export function normalizeSlug(raw: string): string {
  const cleaned = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (cleaned.length >= 3) return cleaned;
  const suffix = Math.random().toString(36).slice(2, 7);
  return cleaned ? `${cleaned}-${suffix}` : `product-${suffix}`;
}

function toCloudUser(user: User | null): CloudUserSummary | null {
  if (!user) return null;
  return {
    uid: user.uid,
    displayName: user.displayName || user.email || "User",
    email: user.email || "",
    emailVerified: Boolean(user.emailVerified),
  };
}

function stripInlineVideoDataUrls(html: string): { cleanedHtml: string; removedVideoData: boolean } {
  let removedVideoData = false;
  const cleanedHtml = String(html || "").replace(/<video\b[^>]*\bsrc\s*=\s*(?:"data:video\/[^"]*"|'data:video\/[^']*')[^>]*>(?:[\s\S]*?<\/video>)?/gi, () => {
    removedVideoData = true;
    return "";
  });
  return { cleanedHtml, removedVideoData };
}

function clampHex(val: string | null | undefined): string {
  return typeof val === "string" && /^#[0-9a-fA-F]{6}$/.test(val.trim()) ? val.trim().toUpperCase() : "";
}

async function signInGoogle(): Promise<CloudUserSummary> {
  const provider = new GoogleAuthProvider();
  const cred = await signInWithPopup(auth, provider);
  const summary = toCloudUser(cred.user);
  if (!summary) throw new Error("AUTH_FAILED");
  return summary;
}

async function signOutUser(): Promise<void> {
  await signOut(auth);
}

function initAuthListener(callback: (user: CloudUserSummary | null) => void): () => void {
  return onAuthStateChanged(auth, (user) => {
    callback(toCloudUser(user));
  });
}

async function publishLandingPage(
  rawSlug: string,
  input: PublishPayloadInput,
): Promise<{ slug: string; url: string; trimmedMedia: boolean }> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("AUTH_REQUIRED");
  }

  const slug = normalizeSlug(rawSlug || input.productName);
  const docPath = `published_pages/${slug}`;
  const docRef = doc(db, "published_pages", slug);

  let existingSnap;
  try {
    existingSnap = await getDoc(docRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, docPath);
  }

  const isExisting = existingSnap.exists();
  const existingData = isExisting ? existingSnap.data() : null;
  if (isExisting && existingData && existingData.ownerId !== currentUser.uid) {
    throw new Error("SLUG_TAKEN");
  }

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

  // Shrink total payload under Firestore 1MB limit gracefully if many heavy inline images exist
  let workingImages = safeImages.slice();
  const buildDocPayload = (imgs: string[], htmlStr: string) => ({
    slug,
    ownerId: currentUser.uid,
    lang: input.lang === "ar" || input.lang === "fr" ? input.lang : "en",
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
    createdAt: isExisting && existingData?.createdAt ? existingData.createdAt : serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  let payload = buildDocPayload(workingImages, safeHtml);
  while (new Blob([JSON.stringify(payload)]).size > 880000 && workingImages.length > 1) {
    workingImages.pop();
    trimmedMedia = true;
    payload = buildDocPayload(workingImages, safeHtml);
  }
  if (new Blob([JSON.stringify(payload)]).size > 900000) {
    safeHtml = safeHtml.replace(/<img\b[^>]*>/gi, "").slice(0, 245000);
    trimmedMedia = true;
    payload = buildDocPayload(workingImages, safeHtml);
  }

  try {
    await setDoc(docRef, payload);
  } catch (err) {
    handleFirestoreError(err, isExisting ? OperationType.UPDATE : OperationType.CREATE, docPath);
  }

  return {
    slug,
    url: `${window.location.origin}/p/${encodeURIComponent(slug)}`,
    trimmedMedia,
  };
}

async function listMyPublishedPages(): Promise<PublishedLinkItem[]> {
  const currentUser = auth.currentUser;
  if (!currentUser) return [];

  const colPath = "published_pages";
  try {
    const q = query(collection(db, colPath), where("ownerId", "==", currentUser.uid));
    const snap = await getDocs(q);
    const items: PublishedLinkItem[] = [];
    snap.forEach((d) => {
      const data = d.data();
      const ts = data.updatedAt as { toMillis?: () => number } | undefined;
      const updatedAtMs = ts && typeof ts.toMillis === "function" ? ts.toMillis() : Date.now();
      const slug = typeof data.slug === "string" ? data.slug : d.id;
      items.push({
        slug,
        productName: String(data.productName || slug),
        price: String(data.price || ""),
        currency: String(data.currency || "USD"),
        link: `${window.location.origin}/p/${encodeURIComponent(slug)}`,
        updatedAtMs,
        data,
      });
    });
    items.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    return items;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, colPath);
  }
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

async function deletePublishedPage(slug: string): Promise<void> {
  const path = `published_pages/${slug}`;
  try {
    await deleteDoc(doc(db, "published_pages", slug));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

declare global {
  interface Window {
    LPCloud?: {
      getCurrentUser: () => CloudUserSummary | null;
      initAuthListener: typeof initAuthListener;
      signInGoogle: typeof signInGoogle;
      signOutUser: typeof signOutUser;
      normalizeSlug: typeof normalizeSlug;
      publishLandingPage: typeof publishLandingPage;
      listMyPublishedPages: typeof listMyPublishedPages;
      loadPublishedPage: typeof loadPublishedPage;
      deletePublishedPage: typeof deletePublishedPage;
      projectId: string;
    };
  }
}

window.LPCloud = {
  getCurrentUser: () => toCloudUser(auth.currentUser),
  initAuthListener,
  signInGoogle,
  signOutUser,
  normalizeSlug,
  publishLandingPage,
  listMyPublishedPages,
  loadPublishedPage,
  deletePublishedPage,
  projectId: firebaseConfig.projectId,
};
