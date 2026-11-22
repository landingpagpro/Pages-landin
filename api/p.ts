import type { IncomingMessage, ServerResponse } from "node:http";
import {
  fetchPublishedPageBySlug,
  isValidSlug,
  renderNotFoundLandingHtml,
  renderPublishedLandingHtml,
} from "../lib/renderLandingPage.ts";

function getRequestOrigin(req: IncomingMessage): string {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

function getSlugFromRequest(req: IncomingMessage): string {
  const urlObj = new URL(req.url || "/", "http://localhost");
  const fromQuery = (urlObj.searchParams.get("slug") || "").trim().toLowerCase();
  if (fromQuery) return fromQuery;
  const pathMatch = urlObj.pathname.match(/^\/p\/([a-z0-9-]+)\/?$/i);
  return pathMatch ? pathMatch[1].toLowerCase() : "";
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const slug = getSlugFromRequest(req);
  if (!isValidSlug(slug)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderNotFoundLandingHtml("ar"));
    return;
  }

  try {
    const page = await fetchPublishedPageBySlug(slug);
    if (!page) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderNotFoundLandingHtml("ar"));
      return;
    }

    const html = renderPublishedLandingHtml(page, getRequestOrigin(req));
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=60");
    res.end(html);
  } catch (err) {
    console.error("Failed to render published page:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderNotFoundLandingHtml("ar"));
  }
}
