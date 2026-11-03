// HACK-004 Phase 2: nail photo -> SAM 3.1 boxes ("nail") -> Spark describes
// design/finish per nail -> original photo saved with the service record.
// Invented demo data only; no real client data.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_MODEL, RESPONSES_URL } from "./agent";
import type { ValeDb } from "./db";

export const SAM_MODEL = "sam-3.1";
export const NAIL_CONCEPT = "nail";
// Fewer calls when a photo returns many boxes.
export const MAX_NAILS = 5;

export interface NailBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
}

const BOX_RE =
  /<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+);w=(\d+);h=(\d+)\|>/g;

/** Boxes SAM 3.1 returns inline as <|box;...|> tokens in output text. */
export function parseNailBoxes(text: string): NailBox[] {
  const boxes: NailBox[] = [];
  BOX_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BOX_RE.exec(text)) !== null) {
    boxes.push({
      x1: Number(match[1]),
      y1: Number(match[2]),
      x2: Number(match[3]),
      y2: Number(match[4]),
      w: Number(match[5]),
      h: Number(match[6]),
    });
  }
  return boxes;
}

export const NAIL_DESCRIBE_INSTRUCTIONS = [
  "You describe nail designs from photos for a nail technician.",
  "Describe ONLY the visible design and finish on the given nail:",
  "colors, finish, and nail art.",
  "Never promise or name exact materials or products.",
  "Reply in one or two short sentences. Plain text only.",
].join(" ");

export function buildNailDescribePrompt(index: number, box: NailBox): string {
  return [
    `Nail ${index + 1}, inside box x1=${box.x1} y1=${box.y1} x2=${box.x2} y2=${box.y2} (image ${box.w}x${box.h}).`,
    "Describe ONLY the visible design and finish on this nail: colors,",
    "finish, and nail art.",
    "Do not promise or name exact materials.",
  ].join(" ");
}

/** One Spark call over the cropped-nail mosaic; never exact material. */
export const MOSAIC_DESCRIBE_PROMPT =
  "Describe the nail design across these cropped nails: colors, finish, and nail art, without naming materials or products. Reply in one or two short sentences.";

export interface NailFinding {
  box: NailBox;
  description: string;
}

export interface NailRecord {
  id: number;
  createdAt: string;
  client: string;
  // Original photo (data URL) attached to the service, as agreed.
  photo: string;
  nailCount: number;
  nails: NailFinding[];
}

export function photoPathForSession(sessionId: number, baseDir?: string): string {
  return join(baseDir ?? join(process.cwd(), "data", "nails"), `session_${sessionId}.jpg`);
}

/**
 * Store the original photo on disk and point the session at it.
 * Returns the path, or null when the photo cannot be stored;
 * callers keep the session and log, they never fail because of this.
 */
export function saveSessionPhoto(
  db: ValeDb,
  sessionId: number,
  imageDataUrl: string,
  baseDir?: string,
): string | null {
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(imageDataUrl);
  if (!match) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  const path = photoPathForSession(sessionId, baseDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  } catch {
    console.error("[nails] could not write session photo; session kept without photo.");
    return null;
  }
  db.prepare("UPDATE sessions SET photo_path = ? WHERE id = ?").run(path, sessionId);
  return path;
}

interface ResponsesMessage {
  type?: string;
  content?: { type?: string; text?: string }[];
}

function outputTextOf(body: {
  output?: ResponsesMessage[];
}): string {
  const texts: string[] = [];
  for (const item of body.output ?? []) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("");
}

async function postJson(
  key: string,
  payload: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<{ id: string; text: string }> {
  const response = await fetchFn(RESPONSES_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...payload, stream: false }),
  });
  if (!response.ok) throw new Error(`model error: ${response.status}`);
  const body = (await response.json()) as {
    id?: string;
    output?: ResponsesMessage[];
  };
  return { id: body.id ?? "", text: outputTextOf(body) };
}

/** SAM 3.1 segmentation with the agreed "nail" concept. */
export async function segmentNails(
  key: string,
  imageDataUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<NailBox[]> {
  const { text } = await postJson(
    key,
    {
      model: SAM_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: NAIL_CONCEPT },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
    },
    fetchFn,
  );
  return parseNailBoxes(text).slice(0, MAX_NAILS);
}

export const MOSAIC_CELL_HEIGHT = 128;
export const MOSAIC_PADDING = 8;

/** Minimal sharp surface the mosaic uses; tests pass a stub for this. */
export interface SharpRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SharpImage {
  metadata(): Promise<{ width?: number; height?: number }>;
  extract(region: SharpRegion): SharpImage;
  resize(width: number, height: number): SharpImage;
  composite(images: { input: Buffer; left: number; top: number }[]): SharpImage;
  png(): SharpImage;
  toBuffer(): Promise<Buffer>;
}

export type SharpFactory = (
  input:
    | Buffer
    | {
        create: {
          width: number;
          height: number;
          channels: number;
          background: { r: number; g: number; b: number; alpha: number };
        };
      },
) => SharpImage;

function mosaicError(code: string, message: string): Error {
  const error = new Error(message);
  (error as NodeJS.ErrnoException).code = code;
  return error;
}

/** Lazily imported so tests can stub it and serverless pays only on use. */
async function loadSharp(): Promise<SharpFactory> {
  try {
    const mod = (await import("sharp")) as unknown as {
      default?: SharpFactory;
    };
    const factory = mod.default ?? (mod as unknown as SharpFactory);
    if (typeof factory !== "function") throw new Error("sharp export is not a factory");
    return factory;
  } catch {
    throw mosaicError("E-NO-SHARP", "sharp is not available for the nail mosaic.");
  }
}

/**
 * One PNG tiling the boxed nails side by side with small padding on black.
 * Every crop is scaled to the same cell height; boxes scale from the SAM
 * image size to the stored photo size. Pass a stub factory in tests.
 */
export async function buildNailMosaic(
  photo: Buffer,
  boxes: NailBox[],
  sharpImpl?: SharpFactory,
): Promise<Buffer> {
  const sharp = sharpImpl ?? (await loadSharp());
  const meta = await sharp(photo).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (imgW <= 0 || imgH <= 0) throw mosaicError("E-BAD-PHOTO", "Photo has no readable size.");
  const cells = boxes.map((box) => {
    const scaleX = box.w > 0 ? imgW / box.w : 1;
    const scaleY = box.h > 0 ? imgH / box.h : 1;
    const left = Math.min(Math.max(Math.round(box.x1 * scaleX), 0), imgW - 1);
    const top = Math.min(Math.max(Math.round(box.y1 * scaleY), 0), imgH - 1);
    const width = Math.min(Math.max(Math.round((box.x2 - box.x1) * scaleX), 1), imgW - left);
    const height = Math.min(Math.max(Math.round((box.y2 - box.y1) * scaleY), 1), imgH - top);
    return { left, top, width, height, cellWidth: Math.max(1, Math.round((width * MOSAIC_CELL_HEIGHT) / height)) };
  });
  const crops: Buffer[] = [];
  for (const cell of cells) {
    crops.push(
      await sharp(photo)
        .extract({ left: cell.left, top: cell.top, width: cell.width, height: cell.height })
        .resize(cell.cellWidth, MOSAIC_CELL_HEIGHT)
        .toBuffer(),
    );
  }
  const canvasWidth =
    cells.reduce((sum, cell) => sum + cell.cellWidth, 0) + MOSAIC_PADDING * (cells.length + 1);
  let x = MOSAIC_PADDING;
  const layers = crops.map((input, index) => {
    const layer = { input, left: x, top: MOSAIC_PADDING };
    x += cells[index].cellWidth + MOSAIC_PADDING;
    return layer;
  });
  return sharp({
    create: {
      width: canvasWidth,
      height: MOSAIC_CELL_HEIGHT + MOSAIC_PADDING * 2,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite(layers)
    .png()
    .toBuffer();
}

/** Spark describes the mosaic design once; never exact material. */
export async function describeMosaic(
  key: string,
  mosaicPng: Buffer,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const { text } = await postJson(
    key,
    {
      model: AGENT_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: MOSAIC_DESCRIBE_PROMPT },
            { type: "input_image", image_url: `data:image/png;base64,${mosaicPng.toString("base64")}` },
          ],
        },
      ],
    },
    fetchFn,
  );
  return text.trim();
}

/** Spark describes design/finish for one nail; never exact material. */
export async function describeNail(
  key: string,
  imageDataUrl: string,
  index: number,
  box: NailBox,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const { text } = await postJson(
    key,
    {
      model: AGENT_MODEL,
      instructions: NAIL_DESCRIBE_INSTRUCTIONS,
      reasoning: { effort: "minimal" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: buildNailDescribePrompt(index, box) },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
    },
    fetchFn,
  );
  return text.trim();
}
