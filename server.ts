import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GenerateDescError,
  generateDescriptionFromImage,
  type GenerateDescInput,
} from "./lib/generateDescription.ts";
import {
  extractFirstImageData,
  fetchPublishedPageBySlug,
  isValidSlug,
  renderNotFoundLandingHtml,
  renderPublishedLandingHtml,
} from "./lib/renderLandingPage.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

function getExpressOrigin(req: Request): string {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http")
    .split(",")[0]
    .trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "")
    .split(",")[0]
    .trim();
  return host ? `${proto}://${host}` : `http://localhost:${PORT}`;
}

async function handleRenderPublishedPage(req: Request, res: Response, rawSlug: string): Promise<void> {
  const slug = rawSlug.trim().toLowerCase();
  if (!isValidSlug(slug)) {
    res.status(404).type("html").send(renderNotFoundLandingHtml("ar"));
    return;
  }

  try {
    const page = await fetchPublishedPageBySlug(slug);
    if (!page) {
      res.status(404).type("html").send(renderNotFoundLandingHtml("ar"));
      return;
    }
    const html = renderPublishedLandingHtml(page, getExpressOrigin(req));
    res.status(200).setHeader("Cache-Control", "public, max-age=30, s-maxage=60").type("html").send(html);
  } catch (err) {
    console.error("Failed to render /p/:slug:", err);
    res.status(500).type("html").send(renderNotFoundLandingHtml("ar"));
  }
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "12mb" }));

  app.get("/p/:slug", async (req: Request, res: Response) => {
    await handleRenderPublishedPage(req, res, String(req.params.slug || ""));
  });

  app.get("/api/p", async (req: Request, res: Response) => {
    await handleRenderPublishedPage(req, res, String(req.query.slug || ""));
  });

  app.get("/api/p-image", async (req: Request, res: Response) => {
    const slug = String(req.query.slug || "").trim().toLowerCase();
    if (!isValidSlug(slug)) {
      res.status(404).send("Not found");
      return;
    }
    try {
      const page = await fetchPublishedPageBySlug(slug);
      if (!page) {
        res.status(404).send("Not found");
        return;
      }
      const img = extractFirstImageData(page);
      if (!img) {
        res.status(404).send("No image");
        return;
      }
      res.status(200).setHeader("Cache-Control", "public, max-age=3600").type(img.mime).send(img.buffer);
    } catch (err) {
      console.error("Failed to serve /api/p-image:", err);
      res.status(500).send("Error");
    }
  });

  app.post("/api/generate-description", async (req: Request, res: Response) => {
    try {
      const result = await generateDescriptionFromImage((req.body || {}) as GenerateDescInput);
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof GenerateDescError) {
        res.status(err.statusCode).json({ error: err.code, message: err.message });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const status =
        typeof (err as { status?: unknown })?.status === "number"
          ? ((err as { status: number }).status)
          : 500;
      console.error("AI description generation error:", status, msg);
      res.status(status >= 400 && status < 600 ? status : 500).json({
        error: "GENERATION_FAILED",
        message: msg || "Failed to analyze the product image and search the web. Please try again.",
      });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
