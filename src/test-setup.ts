// Every test runs against the seeded in-memory database (or an explicit
// tmp file). Touching the real data/vale.db from a test fails loudly in
// getDb instead of polluting Daniel's live turns.
import { tmpdir } from "node:os";
import { join } from "node:path";
if (process.env.VALE_DB_MEMORY === undefined) {
  process.env.VALE_DB_MEMORY = "1";
}

// Turn lines emitted by bridge/route flows under test go to a tmp file,
// never to Daniel's data/turns.jsonl ear log.
if (process.env.VALE_TURNS_PATH === undefined) {
  process.env.VALE_TURNS_PATH = join(tmpdir(), `test-turns-${process.pid}.jsonl`);
}
// Turn WAVs land in tmp under tests, never in Daniel's data/audio.
if (process.env.VALE_AUDIO_DIR === undefined) {
  process.env.VALE_AUDIO_DIR = join(tmpdir(), `test-audio-${process.pid}`);
}

// jsdom no longer installs window.localStorage on Node 25+, so code
// under test that reads window.localStorage crashes there while Node
// 20-24 provide it. Install a deterministic in-memory one whenever the
// environment's is missing or broken.
function storageUsable(value: unknown): value is Storage {
  try {
    const storage = value as Storage | undefined;
    if (!storage || typeof storage.getItem !== "function") return false;
    const probe = "__vale_probe__";
    storage.setItem(probe, "1");
    const ok = storage.getItem(probe) === "1";
    storage.removeItem(probe);
    return ok;
  } catch {
    return false;
  }
}
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
  };
}
for (const scope of [
  globalThis as unknown as Record<string, unknown>,
  (globalThis as unknown as { window?: Record<string, unknown> }).window,
]) {
  if (!scope) continue;
  if (!storageUsable(scope.localStorage)) {
    Object.defineProperty(scope, "localStorage", {
      value: memoryStorage(),
      configurable: true,
      writable: true,
    });
  }
}
