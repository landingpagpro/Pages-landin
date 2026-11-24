import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FreeDescError,
  generateFreeDescription,
  type GenerateFreeDescInput,
} from "../lib/generateFreeDescription.ts";

interface VercelNodeRequest extends IncomingMessage {
  body?: unknown;
}

const MAX_BODY_BYTES = 128 * 1024;

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readRequestJson(req: VercelNodeRequest): Promise<GenerateFreeDescInput> {
  if (req.body && typeof req.body === "object") {
    return req.body as GenerateFreeDescInput;
  }
  if (typeof req.body === "string") {
    return (JSON.parse(req.body) || {}) as GenerateFreeDescInput;
  }

  return new Promise<GenerateFreeDescInput>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new FreeDescError(413, "PAYLOAD_TOO_LARGE", "Request payload is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve((raw ? JSON.parse(raw) : {}) as GenerateFreeDescInput);
      } catch {
        reject(new FreeDescError(400, "INVALID_JSON", "Invalid JSON request body."));
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
    const result = await generateFreeDescription(body);
    sendJson(res, 200, result);
  } catch (err: unknown) {
    if (err instanceof FreeDescError) {
      sendJson(res, err.statusCode, { error: err.code, message: err.message });
      return;
    }
    console.error("Vercel free description generation error:", err);
    sendJson(res, 500, {
      error: "FREE_GENERATION_FAILED",
      message: "Could not generate free description right now. Please try again.",
    });
  }
}
