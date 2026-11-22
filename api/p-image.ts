import type { IncomingMessage, ServerResponse } from "node:http";
import {
  extractFirstImageData,
  fetchPublishedPageBySlug,
  isValidSlug,
} from "../lib/renderLandingPage.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const urlObj = new URL(req.url || "/", "http://localhost");
  const slug = (urlObj.searchParams.get("slug") || "").trim().toLowerCase();

  if (!isValidSlug(slug)) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  try {
    const page = await fetchPublishedPageBySlug(slug);
    if (!page) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const img = extractFirstImageData(page);
    if (!img) {
      res.statusCode = 404;
      res.end("No image");
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", img.mime);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(img.buffer);
  } catch (err) {
    console.error("Failed to serve OG product image:", err);
    res.statusCode = 500;
    res.end("Error");
  }
}
