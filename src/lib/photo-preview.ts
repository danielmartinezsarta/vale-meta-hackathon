// Server-side only: Muse Image photo preview. Never import from client code.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PREVIEW_MODEL = "muse-image-1.0";
export const PREVIEW_ENDPOINT = "https://api.meta.ai/v1/images/edits";
export const PREVIEW_TIMEOUT_MS = 25000;
/** Flat per-image price until the API returns real cost fields. */
export const PREVIEW_USD_PER_IMAGE = 0.1;
export const PREVIEW_WARN_USD = 1.5;
export const PREVIEW_BUDGET_USD = 2.0;
export const PREVIEW_DISCLAIMER = "AI preview, the real result may vary";

export interface DesignSpec {
  shape: string;
  color: string;
  finish: string;
  detail: string;
}

export interface PreviewInput {
  beforePhoto: Buffer;
  mime: string;
  /** Appointment reference photo: the design source applied onto the before nails. */
  referencePhoto: Buffer;
  /** MIME of the reference photo; defaults to mime. */
  referenceMime?: string;
  design: DesignSpec;
  appointmentRef: string;
}

export interface PreviewUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface PreviewResult {
  image: Buffer;
  mime: "image/png";
  width: number;
  height: number;
  elapsedMs: number;
  usage: PreviewUsage;
  estimatedCostUsd: number;
  watermarkKept: true;
  disclaimer: typeof PREVIEW_DISCLAIMER;
}

export interface RunPreviewOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  costLogPath?: string;
}

export interface CostLogEntry {
  ts: string;
  inputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  costUsd: number;
  runningTotalUsd: number;
}

function previewError(code: string, message: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

/**
 * Nails-only edit prompt for the two-image form. The first image is the
 * before photo to edit; the second image is the appointment reference
 * design source. Keeps hand, skin, ring, background, light and framing
 * identical. The sparkle mark is drawn by the UI from aiPreview, so the
 * prompt never asks the model for any mark.
 * There is intentionally no mask parameter: the model finds the nails.
 */
export function buildPreviewPrompt(
  design: DesignSpec,
  appointmentRef: string,
): string {
  return [
    `Nail design preview for appointment ${appointmentRef}:`,
    `${design.shape} nails, ${design.color} color, ${design.finish} finish, ${design.detail}.`,
    "The first image is the before photo to edit; the second image is the appointment reference design.",
    "Apply the reference design onto the before nails, only inside the nails.",
    "Keep hand, skin, ring, background, light and framing identical to the before photo.",
  ].join(" ");
}

export function defaultCostLogPath(cwd: string = process.cwd()): string {
  return join(cwd, "data", "preview-cost.jsonl");
}

/** Sum of costUsd over an existing JSONL cost log; 0 when absent. */
export function readRunningTotal(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  const lines = readFileSync(logPath, "utf8").split("\n");
  let total = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as { costUsd?: unknown };
      if (typeof parsed.costUsd === "number" && Number.isFinite(parsed.costUsd)) {
        total += parsed.costUsd;
      }
    } catch {
      /* skip corrupt lines; the log is best-effort */
    }
  }
  return Math.round(total * 100) / 100;
}

/** Append one JSONL cost entry and return it with the running total. */
export function appendPreviewCost(
  entry: Omit<CostLogEntry, "ts" | "runningTotalUsd"> & { ts?: string },
  logPath: string = defaultCostLogPath(),
): CostLogEntry {
  const previous = readRunningTotal(logPath);
  const costUsd = Math.round(entry.costUsd * 100) / 100;
  const record: CostLogEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    elapsedMs: entry.elapsedMs,
    costUsd,
    runningTotalUsd: Math.round((previous + costUsd) * 100) / 100,
  };
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
  if (record.runningTotalUsd >= PREVIEW_WARN_USD) {
    console.warn(
      `[preview-cost] running total USD ${record.runningTotalUsd.toFixed(2)} (warn at ${PREVIEW_WARN_USD.toFixed(2)})`,
    );
  }
  return record;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function runPhotoPreview(
  input: PreviewInput,
  opts: RunPreviewOptions = {},
): Promise<PreviewResult> {
  const apiKey = opts.apiKey ?? process.env.META_API_KEY?.trim();
  if (!apiKey) {
    throw previewError("E-NO-KEY", "Missing META_API_KEY for photo preview.");
  }
  const model = opts.model ?? PREVIEW_MODEL;
  const endpoint = opts.endpoint ?? PREVIEW_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? PREVIEW_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const logPath = opts.costLogPath ?? defaultCostLogPath();
  if (readRunningTotal(logPath) >= PREVIEW_BUDGET_USD) {
    throw previewError(
      "E-BUDGET",
      `Photo preview budget of USD ${PREVIEW_BUDGET_USD.toFixed(2)} reached.`,
    );
  }

  const prompt = buildPreviewPrompt(input.design, input.appointmentRef);
  const form = new FormData();
  form.append(
    "image",
    new Blob([new Uint8Array(input.beforePhoto)], { type: input.mime }),
    "before-photo",
  );
  form.append(
    "image",
    new Blob([new Uint8Array(input.referencePhoto)], { type: input.referenceMime ?? input.mime }),
    "reference-photo",
  );
  form.append("prompt", prompt);
  form.append("model", model);
  // No mask field: the model edits the nails directly.

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      error instanceof DOMException && error.name === "AbortError" ||
      (error as NodeJS.ErrnoException)?.code === "ABORT_ERR"
    ) {
      throw previewError("E-TIMEOUT", `Photo preview timed out after ${timeoutMs}ms.`);
    }
    throw previewError("E-NET", "Photo preview request failed.");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw previewError("E-MODEL", `Photo preview model error (HTTP ${response.status}).`);
  }

  const elapsedMs = Date.now() - started;
  const contentType = response.headers.get("content-type") ?? "";
  try {
    if (contentType.startsWith("image/")) {
      const bytes = Buffer.from(await response.arrayBuffer());
      appendPreviewCost(
        { inputTokens: 0, outputTokens: 0, elapsedMs, costUsd: PREVIEW_USD_PER_IMAGE },
        logPath,
      );
      return {
        image: bytes,
        mime: "image/png",
        width: 0,
        height: 0,
        elapsedMs,
        usage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: PREVIEW_USD_PER_IMAGE,
        watermarkKept: true,
        disclaimer: PREVIEW_DISCLAIMER,
      };
    }
    const json = (await response.json()) as {
      data?: Array<{ b64_json?: string }>;
      width?: unknown;
      height?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    const b64 = json.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || b64 === "") {
      throw previewError("E-MODEL", "Photo preview returned no image.");
    }
    const usage: PreviewUsage = {
      inputTokens: num(json.usage?.input_tokens),
      outputTokens: num(json.usage?.output_tokens),
    };
    appendPreviewCost(
      {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        elapsedMs,
        costUsd: PREVIEW_USD_PER_IMAGE,
      },
      logPath,
    );
    return {
      image: Buffer.from(b64, "base64"),
      mime: "image/png",
      width: num(json.width),
      height: num(json.height),
      elapsedMs,
      usage,
      estimatedCostUsd: PREVIEW_USD_PER_IMAGE,
      watermarkKept: true,
      disclaimer: PREVIEW_DISCLAIMER,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "E-MODEL") throw error;
    throw previewError("E-MODEL", "Photo preview response unreadable.");
  }
}
