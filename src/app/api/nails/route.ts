// HACK-004: original photo + SAM boxes + Spark descriptions, saved on the session.
import { getDb } from "@/lib/db";
import {
  describeNail,
  saveSessionPhoto,
  segmentNails,
  type NailRecord,
} from "@/lib/nails";
import { clientLabel, findClient, getOpenSession } from "@/lib/vale-tools";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const key = process.env.META_API_KEY;
  if (!key) {
    return Response.json(
      { error: "Nail service is not configured. Try again later." },
      { status: 503 },
    );
  }
  let body: { image?: unknown; client?: unknown };
  try {
    body = (await request.json()) as { image?: unknown; client?: unknown };
  } catch {
    return Response.json({ error: "Send JSON with an image field." }, { status: 400 });
  }
  if (typeof body.image !== "string" || !body.image.startsWith("data:image/")) {
    return Response.json(
      { error: "Send the photo as an image data URL." },
      { status: 400 },
    );
  }

  const db = getDb();
  const open = getOpenSession(db);
  if (!open) {
    return Response.json(
      { error: "Abre una sesión primero para guardar la foto." },
      { status: 400 },
    );
  }
  let client = clientLabel(db, open.client_id);
  if (typeof body.client === "string" && body.client.trim() !== "") {
    const found = findClient(db, { name: body.client });
    if (!found.ok || !found.card || found.card.id !== open.client_id) {
      return Response.json(
        { error: `La sesión en curso no es de "${body.client.trim().slice(0, 80)}".` },
        { status: 400 },
      );
    }
    client = found.card.name;
  }

  try {
    const boxes = await segmentNails(key, body.image);
    const nails = [];
    for (let i = 0; i < boxes.length; i += 1) {
      nails.push({
        box: boxes[i],
        description: await describeNail(key, body.image, i, boxes[i]),
      });
    }
    saveSessionPhoto(db, open.id, body.image);
    const record: NailRecord = {
      id: open.id,
      createdAt: new Date().toISOString(),
      client,
      photo: body.image,
      nailCount: boxes.length,
      nails,
    };
    return Response.json({ record });
  } catch {
    return Response.json(
      { error: "Nail analysis failed. Try again later." },
      { status: 502 },
    );
  }
}
