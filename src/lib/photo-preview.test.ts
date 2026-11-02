import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PREVIEW_USD_PER_IMAGE,
  appendPreviewCost,
  buildPreviewPrompt,
  readRunningTotal,
  runPhotoPreview,
  type DesignSpec,
} from "./photo-preview";

const DESIGN: DesignSpec = {
  shape: "almond",
  color: "pale pink",
  finish: "glossy",
  detail: "french tips with a thin gold line",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function previewImagePayload(): { b64: string; bytes: Buffer } {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  return { b64: bytes.toString("base64"), bytes };
}

describe("buildPreviewPrompt", () => {
  it("mentions the nails and preserves the rest of the photo", () => {
    const prompt = buildPreviewPrompt(DESIGN, "APT-1");
    expect(prompt.toLowerCase()).toContain("nail");
    expect(prompt).toContain("second image");
    expect(prompt).toContain("reference design");
    expect(prompt).toContain("only inside the nails");
    expect(prompt).toContain("ring");
    expect(prompt).toContain("background");
    expect(prompt).toContain("framing identical");
    expect(prompt).not.toContain("sparkle");
    expect(prompt).not.toContain("watermark");
    expect(prompt).not.toContain("mark");
  });
});

describe("runPhotoPreview", () => {
  it("sends before plus reference photos, prompt and model with no mask field", async () => {
    const { b64 } = previewImagePayload();
    let seen: FormData | null = null;
    const dir = mkdtempSync(join(tmpdir(), "preview-"));
    const result = await runPhotoPreview(
      {
        beforePhoto: Buffer.from([1, 2, 3]),
        mime: "image/png",
        referencePhoto: Buffer.from([4, 5, 6]),
        design: DESIGN,
        appointmentRef: "APT-2",
      },
      {
        apiKey: "test-key",
        costLogPath: join(dir, "cost.jsonl"),
        fetchImpl: (async (_url: unknown, init?: RequestInit) => {
          seen = init?.body as FormData;
          return jsonResponse({
            data: [{ b64_json: b64 }],
            width: 64,
            height: 64,
            usage: { input_tokens: 10, output_tokens: 20 },
          });
        }) as typeof fetch,
      },
    );
    expect(seen).not.toBeNull();
    const form = seen as unknown as FormData;
    const images = form.getAll("image");
    expect(images).toHaveLength(2);
    expect((images[0] as File).name).toBe("before-photo");
    expect((images[1] as File).name).toBe("reference-photo");
    expect(form.get("mask")).toBeNull();
    expect(form.get("model")).toBe("muse-image-1.0");
    expect(form.get("prompt") as string).toContain("reference design");
    expect(result.mime).toBe("image/png");
    expect(result.watermarkKept).toBe(true);
    expect(result.disclaimer).toBe("AI preview, the real result may vary");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(result.estimatedCostUsd).toBe(PREVIEW_USD_PER_IMAGE);
  });

  it("throws E-NO-KEY when no key is configured", async () => {
    const saved = process.env.META_API_KEY;
    delete process.env.META_API_KEY;
    try {
      await expect(
        runPhotoPreview(
          { beforePhoto: Buffer.from([1]), mime: "image/png", referencePhoto: Buffer.from([2]), design: DESIGN, appointmentRef: "APT-3" },
          { costLogPath: join(mkdtempSync(join(tmpdir(), "preview-")), "c.jsonl") },
        ),
      ).rejects.toMatchObject({ code: "E-NO-KEY" });
    } finally {
      if (saved !== undefined) process.env.META_API_KEY = saved;
    }
  });

  it("maps aborts to E-TIMEOUT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-"));
    await expect(
      runPhotoPreview(
        { beforePhoto: Buffer.from([1]), mime: "image/png", referencePhoto: Buffer.from([2]), design: DESIGN, appointmentRef: "APT-4" },
        {
          apiKey: "test-key",
          timeoutMs: 10,
          costLogPath: join(dir, "c.jsonl"),
          fetchImpl: (async (_url: unknown, init?: RequestInit) => {
            const signal = init?.signal as AbortSignal | undefined;
            await new Promise<never>((_resolve, reject) => {
              signal?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            });
            throw new Error("unreachable");
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: "E-TIMEOUT" });
  });

  it("maps network failures to E-NET and model failures to E-MODEL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-"));
    const base = {
      beforePhoto: Buffer.from([1]),
      mime: "image/png",
      referencePhoto: Buffer.from([2]),
      design: DESIGN,
      appointmentRef: "APT-5",
    };
    await expect(
      runPhotoPreview(base, {
        apiKey: "test-key",
        costLogPath: join(dir, "c.jsonl"),
        fetchImpl: (async () => {
          throw new TypeError("down");
        }) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "E-NET" });
    await expect(
      runPhotoPreview(base, {
        apiKey: "test-key",
        costLogPath: join(dir, "c.jsonl"),
        fetchImpl: (async () => jsonResponse({ error: "bad" }, 500)) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "E-MODEL" });
  });
});

describe("preview cost log", () => {
  it("appends JSONL entries with a running total", () => {
    const logPath = join(mkdtempSync(join(tmpdir(), "preview-")), "cost.jsonl");
    const first = appendPreviewCost(
      { inputTokens: 10, outputTokens: 20, elapsedMs: 100, costUsd: PREVIEW_USD_PER_IMAGE },
      logPath,
    );
    const second = appendPreviewCost(
      { inputTokens: 30, outputTokens: 40, elapsedMs: 200, costUsd: PREVIEW_USD_PER_IMAGE },
      logPath,
    );
    expect(first.runningTotalUsd).toBeCloseTo(PREVIEW_USD_PER_IMAGE, 5);
    expect(second.runningTotalUsd).toBeCloseTo(PREVIEW_USD_PER_IMAGE * 2, 5);
    expect(readRunningTotal(logPath)).toBeCloseTo(PREVIEW_USD_PER_IMAGE * 2, 5);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed.ts).toBe("string");
      expect(typeof parsed.runningTotalUsd).toBe("number");
    }
  });
});
