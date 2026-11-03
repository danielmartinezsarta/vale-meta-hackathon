// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshTestDb } from "./db";
import {
  BRIEF_LABEL,
  briefSourceHash,
  briefSourceRecord,
  buildBriefSystemPrompt,
  buildBriefUserPrompt,
  ensureClientBriefsTable,
  fetchClientBrief,
  getStoredBrief,
  glimmerConfigured,
  parseBriefJson,
  precomputeBriefsForClients,
  refreshClientBrief,
  refreshClientBriefInBackground,
} from "./client-briefs";

const BRIEF = {
  spoken: "David comes every 3 weeks. He also has a health note; it's on screen.",
  summary: ["Prefers dark matte designs", "Hockey fan, ask about the Rangers"],
  has_health_note: true,
};

function glimmerFetch(seen: { url: string; auth: string; body: string }[], content = JSON.stringify(BRIEF)) {
  return vi.fn(async (url: unknown, init: unknown) => {
    const request = init as { headers: Record<string, string>; body: string };
    seen.push({ url: String(url), auth: request.headers.authorization ?? "", body: request.body });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function davidId(db: ReturnType<typeof freshTestDb>): number {
  return (db.prepare("SELECT id FROM clients WHERE name = ?").get("David") as { id: number }).id;
}

describe("client briefs store (HACK-005)", () => {
  it("creates the table without touching the shared schema", () => {
    const db = freshTestDb();
    ensureClientBriefsTable(db);
    ensureClientBriefsTable(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'client_briefs'").all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("stays unconfigured without env and never fetches", async () => {
    expect(glimmerConfigured()).toBe(false);
    const db = freshTestDb();
    const fetchImpl = glimmerFetch([]);
    expect(await refreshClientBrief(db, davidId(db), fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getStoredBrief(db, davidId(db))).toBeNull();
    db.close();
  });

  it("stores a fetched brief and reuses it while the record is unchanged", async () => {
    vi.stubEnv("GLIMMER_URL", "https://glimmer.test");
    vi.stubEnv("GLIMMER_TOKEN", "secret");
    const db = freshTestDb();
    const id = davidId(db);
    const seen: { url: string; auth: string; body: string }[] = [];
    const first = await refreshClientBrief(db, id, glimmerFetch(seen) as unknown as typeof fetch);
    expect(first?.brief).toEqual(BRIEF);
    expect(first?.model).toBe("muse-glimmer-30B");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://glimmer.test/v1/chat/completions");
    expect(seen[0].auth).toBe("Bearer secret");
    const stored = getStoredBrief(db, id);
    expect(stored?.brief).toEqual(BRIEF);
    expect(stored?.source_hash).toBe(briefSourceHash(db, id));
    const again = await refreshClientBrief(db, id, glimmerFetch(seen) as unknown as typeof fetch);
    expect(again?.created_at).toBe(first?.created_at);
    expect(seen).toHaveLength(1);
    db.close();
  });

  it("lists the clients with appointments today", async () => {
    const { todayClientIds } = await import("./client-briefs");
    const db = freshTestDb();
    const names = db
      .prepare("SELECT name FROM clients WHERE id IN (SELECT client_id FROM appointments WHERE day = ?)")
      .all("2099-01-01") as { name: string }[];
    expect(names).toEqual([]);
    const ids = todayClientIds(db);
    const today = db
      .prepare("SELECT c.name AS name FROM clients c WHERE c.id IN (" + ids.map(() => "?").join(",") + ")")
      .all(...ids) as { name: string }[];
    expect(today.map((row) => row.name).sort()).toEqual(["David", "Paola", "Sofia"]);
    db.close();
  });

  it("treats the brief as stale after a new note", async () => {
    vi.stubEnv("GLIMMER_URL", "https://glimmer.test");
    vi.stubEnv("GLIMMER_TOKEN", "secret");
    const db = freshTestDb();
    const id = davidId(db);
    const fetchImpl = glimmerFetch([]) as unknown as typeof fetch;
    await refreshClientBrief(db, id, fetchImpl);
    const before = getStoredBrief(db, id)?.source_hash;
    db.prepare("INSERT INTO notes (client_id, text, kind, private_for_glimmer) VALUES (?, 'New invented note', 'note', 0)").run(id);
    expect(getStoredBrief(db, id)?.source_hash).toBe(before);
    expect(briefSourceHash(db, id)).not.toBe(before);
    db.close();
  });

  it("returns null when Glimmer fails and stores nothing", async () => {
    vi.stubEnv("GLIMMER_URL", "https://glimmer.test");
    vi.stubEnv("GLIMMER_TOKEN", "secret");
    const db = freshTestDb();
    const id = davidId(db);
    const failing = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(await refreshClientBrief(db, id, failing as unknown as typeof fetch)).toBeNull();
    expect(getStoredBrief(db, id)).toBeNull();
    expect(failing).toHaveBeenCalledTimes(1);
    const garbage = glimmerFetch([], "not json at all");
    expect(await refreshClientBrief(db, id, garbage as unknown as typeof fetch)).toBeNull();
    expect(getStoredBrief(db, id)).toBeNull();
    db.close();
  });

  it("rides out a loading model with backoff, unless voice opts out", async () => {
    vi.stubEnv("GLIMMER_URL", "https://glimmer.test");
    vi.stubEnv("GLIMMER_TOKEN", "secret");
    const loading = { ok: false, status: 503, json: async () => ({}) };
    const ready = {
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(BRIEF) } }] }),
    };
    const db = freshTestDb();
    const id = davidId(db);
    // First two calls 503, third succeeds: default retries and stores.
    const retrying = vi.fn(async (...args: unknown[]) => {
      const calls = (retrying as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      return calls < 3 ? loading : ready;
    });
    const stored = await refreshClientBrief(db, id, retrying as unknown as typeof fetch, {
      retryDelayMs: 1,
    });
    expect(stored?.brief).toEqual(BRIEF);
    expect(retrying).toHaveBeenCalledTimes(3);
    // Voice opts out: one attempt, instant fallback.
    db.prepare("DELETE FROM client_briefs").run();
    const single = vi.fn(async () => loading);
    expect(
      await refreshClientBrief(db, id, single as unknown as typeof fetch, { retryLoading: false }),
    ).toBeNull();
    expect(single).toHaveBeenCalledTimes(1);
    // Persistent 503 still resolves to null after the attempts.
    const always = vi.fn(async () => loading);
    expect(
      await refreshClientBrief(db, id, always as unknown as typeof fetch, { retryDelayMs: 1 }),
    ).toBeNull();
    expect(always).toHaveBeenCalledTimes(6);
    db.close();
  });

  it("returns null for an unknown client", async () => {
    const db = freshTestDb();
    expect(await refreshClientBrief(db, 999999)).toBeNull();
    db.close();
  });

  it("rejects malformed brief shapes", () => {
    expect(parseBriefJson(null)).toBeNull();
    expect(parseBriefJson({})).toBeNull();
    expect(parseBriefJson({ spoken: "hi", summary: ["a"], has_health_note: "yes" })).toBeNull();
    expect(parseBriefJson({ spoken: "", summary: [], has_health_note: false })).toBeNull();
    expect(parseBriefJson({ spoken: "hi", summary: ["a", 3], has_health_note: false })).toBeNull();
    expect(parseBriefJson(BRIEF)).toEqual(BRIEF);
  });

  it("feeds Glimmer the full private record but never contact details", () => {
    const db = freshTestDb();
    const id = davidId(db);
    const record = briefSourceRecord(db, id);
    expect(record?.name).toBe("David");
    const prompt = buildBriefUserPrompt(record!);
    expect(prompt).toContain("latex");
    expect(prompt).not.toContain("+1-555-0101");
    expect(prompt).not.toContain("david@example.com");
    expect(prompt).not.toContain("1990-04-17");
    expect(buildBriefSystemPrompt("male")).toContain("He also has a health note; it's on screen.");
    expect(buildBriefSystemPrompt("female")).toContain("She also has a health note; it's on screen.");
    expect(buildBriefSystemPrompt("")).not.toContain("latex");
    expect(BRIEF_LABEL).toBe("Prepared privately by Muse Glimmer (open weights)");
    db.close();
  });

  it("sends the fixed schema over the Modal endpoint", async () => {
    const db = freshTestDb();
    const record = briefSourceRecord(db, davidId(db))!;
    const seen: { url: string; auth: string; body: string }[] = [];
    vi.stubEnv("GLIMMER_URL", "https://glimmer.test/");
    vi.stubEnv("GLIMMER_TOKEN", "secret");
    const { brief } = await fetchClientBrief(record, "male", glimmerFetch(seen) as unknown as typeof fetch);
    expect(brief).toEqual(BRIEF);
    const body = JSON.parse(seen[0].body) as { model: string; response_format: unknown };
    expect(body.model).toBe("muse-glimmer-30B");
    expect(body.response_format).toEqual({ type: "json_object" });
    db.close();
  });

  it("precomputes several clients, skipping failures", async () => {
    vi.stubEnv("GLIMMER_URL", "https://glimmer.test");
    vi.stubEnv("GLIMMER_TOKEN", "secret");
    const db = freshTestDb();
    const ids = (db.prepare("SELECT id FROM clients ORDER BY id LIMIT 2").all() as { id: number }[]).map(
      (row) => row.id,
    );
    const flaky = vi.fn(async (url: unknown, init: unknown) => {
      const body = JSON.parse((init as { body: string }).body) as {
        messages: { content: string }[];
      };
      if (body.messages[1].content.includes('"name":"Sofia"')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(BRIEF) } }] }) };
    });
    const result = await precomputeBriefsForClients(db, ids, flaky as unknown as typeof fetch);
    expect(result).toEqual({ refreshed: 1, total: 2 });
    db.close();
  });

  it("regenerates in the background after a note write", async () => {
    vi.stubEnv("GLIMMER_URL", "https://glimmer.test");
    vi.stubEnv("GLIMMER_TOKEN", "secret");
    vi.stubGlobal("fetch", glimmerFetch([]));
    const { addNote } = await import("./vale-tools");
    const db = freshTestDb();
    const id = davidId(db);
    expect(getStoredBrief(db, id)).toBeNull();
    expect(addNote(db, { client_name: "David", text: "Invented background note", kind: "note" }).ok).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getStoredBrief(db, id)?.brief).toEqual(BRIEF);
    db.close();
  });

  it("never throws or fetches from the background path without env", () => {
    const db = freshTestDb();
    const fetchImpl = glimmerFetch([]);
    vi.stubGlobal("fetch", fetchImpl);
    expect(() => refreshClientBriefInBackground(db, davidId(db))).not.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    db.close();
  });
});
