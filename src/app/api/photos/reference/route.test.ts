// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { GET } from "./route";

function request(sessionId: unknown): Request {
  const url =
    sessionId === undefined
      ? "http://test/api/photos/reference"
      : `http://test/api/photos/reference?sessionId=${sessionId}`;
  return new Request(url);
}

function clientService(client: string, service: string): { clientId: number; serviceId: number } {
  const db = getDb();
  const clientRow = db.prepare("SELECT id FROM clients WHERE name = ?").get(client) as {
    id: number;
  };
  const serviceRow = db.prepare("SELECT id FROM services WHERE name = ?").get(service) as {
    id: number;
  };
  return { clientId: clientRow.id, serviceId: serviceRow.id };
}

function openSession(client: string, service: string): number {
  const db = getDb();
  const { clientId, serviceId } = clientService(client, service);
  return Number(
    db
      .prepare("INSERT INTO sessions (client_id, service_id, started_at) VALUES (?, ?, '2026-11-03T10:00:00')")
      .run(clientId, serviceId).lastInsertRowid,
  );
}

describe("GET /api/photos/reference", () => {
  it("serves David's appointment reference photo from the database", async () => {
    const sessionId = openSession("David", "Semi-permanent manicure");
    const res = await GET(request(sessionId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { photoUrl: string };
    expect(body.photoUrl).toContain(encodeURIComponent("seed-assets/david-appointment-reference.jpg"));
  });

  it("rejects a missing, invalid or unknown session", async () => {
    expect((await GET(request(undefined))).status).toBe(400);
    expect((await GET(request("abc"))).status).toBe(400);
    const res = await GET(request(999999));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("E-NO-SESSION");
  });

  it("404s when the appointment has no reference photo", async () => {
    const sessionId = openSession("Ana", "Gel removal");
    const res = await GET(request(sessionId));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("E-NO-PHOTO");
  });
});
