import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GenerateDescError,
  generateDescriptionFromImage,
  type GenerateDescInput,
} from "../lib/generateDescription.ts";

interface VercelNodeRequest extends IncomingMessage {
  body?: unknown;
}

const MAX_BODY_BYTES = 12 * 1024 * 1024;

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readRequestJson(req: VercelNodeRequest): Promise<GenerateDescInput> {
  if (req.body && typeof req.body === "object") {
    return req.body as GenerateDescInput;
  }
  if (typeof req.body === "string") {
    return (JSON.parse(req.body) || {}) as GenerateDescInput;
  }

  return new Promise<GenerateDescInput>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new GenerateDescError(413, "PAYLOAD_TOO_LARGE", "Image payload is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve((raw ? JSON.parse(raw) : {}) as GenerateDescInput);
      } catch {
        reject(new GenerateDescError(400, "INVALID_JSON", "Invalid JSON request body."));
      }
    });

    req.on("error", (err: Error) => {
      reject(err);
    });
  });
}

export default async function handler(req: VercelNodeRequest, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: "METHOD_NOT_ALLOWED", message: "Method not allowed." });
    return;
  }

  try {
    const body = await readRequestJson(req);
    const result = await generateDescriptionFromImage(body);
    sendJson(res, 200, result);
  } catch (err: unknown) {
    if (err instanceof GenerateDescError) {
      sendJson(res, err.statusCode, {
        error: err.code,
        message: err.message,
        ...(err.sources ? { sources: err.sources } : {}),
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    const status =
      typeof (err as { status?: unknown })?.status === "number"
        ? ((err as { status: number }).status)
        : 500;
    console.error("Vercel AI description generation error:", status, msg);
    sendJson(res, status >= 400 && status < 600 ? status : 500, {
      error: "GENERATION_FAILED",
      message: msg || "Failed to analyze the product image and search the web. Please try again.",
    });
  }
}
