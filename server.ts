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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "12mb" }));

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
