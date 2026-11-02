import { describe, expect, it } from "vitest";
import { freshTestDb } from "./db";
import { getHomeData } from "./home-data";

describe("getHomeData (home screen snapshot)", () => {
  it("returns the user name with empty sections on a fresh seed", () => {
    const data = getHomeData(freshTestDb());
    expect(data.userName).toBe("Daniel");
    expect(data.today).toEqual([]);
    expect(data.goal).toMatchObject({ month: expect.any(String) });
    expect(Array.isArray(data.supplies)).toBe(true);
  });

  it("shapes today, goal and supplies from the database", () => {
    const db = freshTestDb();
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const client = db.prepare("SELECT id FROM clients LIMIT 1").get() as { id: number };
    const service = db.prepare("SELECT id FROM services LIMIT 1").get() as { id: number };
    db.prepare("INSERT INTO appointments (client_id, service_id, day, time) VALUES (?, ?, ?, ?)").run(
      client.id,
      service.id,
      day,
      "10:00",
    );
    db.prepare("UPDATE supplies SET stock_qty = 1, min_qty = 5 WHERE name = 'Base coat'").run();
    db.prepare(
      "INSERT INTO sessions (client_id, service_id, started_at, ended_at, margin_earned) VALUES (?, ?, ?, ?, ?)",
    ).run(client.id, service.id, `${day}T10:00:00`, `${day}T11:00:00`, 120);

    const data = getHomeData(db);
    expect(data.today.length).toBe(1);
    expect(data.today[0]).toMatchObject({ time: "10:00" });
    expect(typeof data.today[0].client).toBe("string");
    expect(typeof data.today[0].service).toBe("string");
    expect(data.supplies.find((item) => item.name === "Base coat")).toEqual({
      name: "Base coat",
      qty: 1,
    });
    expect(data.goal?.earned).toBe(120);
    expect(data.goal?.pct).toBeGreaterThan(0);
  });
});
