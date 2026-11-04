// @vitest-environment node
// HACK-030: the manage API serves the same rows the voice tools read and
// writes through the same logged, undoable path.
process.env.VALE_DB_MEMORY = "1";

import { describe, expect, it } from "vitest";
import { DELETE, GET, POST } from "./route";

function getRequest(entity: string, query = ""): Request {
  return new Request(`http://test/api/manage/${entity}${query}`);
}

function postRequest(entity: string, body: Record<string, unknown>): Request {
  return new Request(`http://test/api/manage/${entity}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(entity: string) {
  return { params: Promise.resolve({ entity }) };
}

describe("GET /api/manage", () => {
  it("rejects unknown entities", async () => {
    const res = await GET(getRequest("nope"), params("nope"));
    expect(res.status).toBe(404);
  });

  it("serves seeded goal settings with fixed costs", async () => {
    const res = await GET(getRequest("settings"), params("settings"));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { monthlyGoalUsd: number; fixedCosts: unknown[] };
    expect(data.monthlyGoalUsd).toBe(2500);
    expect(data.fixedCosts).toHaveLength(4);
  });

  it("lists supplies with low-stock flags", async () => {
    const res = await GET(getRequest("supplies"), params("supplies"));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { name: string; low: boolean }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toEqual(expect.objectContaining({ name: expect.any(String), low: expect.any(Boolean) }));
  });
});

describe("POST and DELETE /api/manage", () => {
  it("creates and reads back a client file", async () => {
    const saved = await POST(postRequest("client", { name: "Route Test Client" }), params("client"));
    expect(saved.status).toBe(200);
    const created = (await saved.json()) as { ok: boolean; data: { client_id: number } };
    expect(created.ok).toBe(true);
    const res = await GET(getRequest("client", `?id=${created.data.client_id}`), params("client"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe("Route Test Client");
  });

  it("saves and deletes a supply", async () => {
    const saved = await POST(
      postRequest("supply", { name: "Route Test Supply", unit: "pcs", stockQty: 3, minQty: 1, pricePerProductUsd: 2 }),
      params("supply"),
    );
    const created = (await saved.json()) as { ok: boolean; data: { supply_id: number } };
    expect(created.ok).toBe(true);
    const removed = await DELETE(getRequest("supply", `?id=${created.data.supply_id}`), params("supply"));
    expect(((await removed.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("adds and deletes a fixed cost", async () => {
    const saved = await POST(postRequest("fixed-cost", { label: "Route Test Cost", amountUsd: 9 }), params("fixed-cost"));
    const created = (await saved.json()) as { ok: boolean; data: { fixed_cost_id: number } };
    expect(created.ok).toBe(true);
    const removed = await DELETE(getRequest("fixed-cost", `?id=${created.data.fixed_cost_id}`), params("fixed-cost"));
    expect(((await removed.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("rejects an invalid goal without writing", async () => {
    const res = await POST(
      postRequest("settings", { monthlyGoalUsd: -5, marginPct: 30, schedule: "lun-vie", workHoursPerDay: 8 }),
      params("settings"),
    );
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });
});
