// npm run demo: the committed run through the real app, keyless.
// Starts the replay server on a free port, then drives a headed Chromium
// (fake mic and camera) exactly like the manual steps: open the app, wake
// Vale, mute the mic and type every recorded turn, waiting for Vale to
// finish speaking and the sheet to show before the next turn. One voice
// at a time. Prints the scene name per turn. Exits non-zero on any miss.
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium, type Page } from "playwright";
import { parseReplayRun } from "../src/lib/replay";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOT_SCENES: Record<string, string> = {
  "Daily agenda": "agenda.png",
  "Client's card": "card.png",
  "Nail photo studio": "studio.png",
};

async function freePort(start: number): Promise<number> {
  for (let port = start; port < start + 50; port += 1) {
    if (port === 3000 || port === 3102) continue;
    const taken = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(true));
      probe.once("listening", () => probe.close(() => resolve(false)));
      probe.listen(port, "127.0.0.1");
    });
    if (!taken) return port;
  }
  throw new Error("no free port near 3222");
}

function waitUp(port: number): Promise<void> {
  const deadline = Date.now() + 60000;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://localhost:${port}/api/status`);
        const status = (await res.json()) as { replay?: unknown };
        if (status.replay === true) {
          resolve();
          return;
        }
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) reject(new Error("server never came up"));
      else setTimeout(tick, 1000);
    };
    void tick();
  });
}

function ensureChromium(): void {
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  let present = false;
  try {
    for (const entry of readdirSync(cache)) {
      if (entry.startsWith("chromium-") && existsSync(join(cache, entry))) {
        present = true;
      }
    }
  } catch {
    /* cache dir missing: install below */
  }
  if (!present) {
    console.log("[demo] installing Chromium for Playwright (once)...");
    execSync("npx playwright install chromium", { cwd: root, stdio: "inherit" });
  }
}

async function quiet(page: Page): Promise<void> {
  await page.waitForFunction(() => window.speechSynthesis?.speaking !== true, undefined, {
    timeout: 90000,
  });
}

async function main(): Promise<void> {
  const run = parseReplayRun(readFileSync(join(root, "replay", "demo-run.json"), "utf8"));
  const port = await freePort(3222);
  // Throwaway database: the recorded answers never touch a real DB, and
  // each run starts clean. Never the main checkout data/.
  const demoDb = join(tmpdir(), "vale-demo.db");
  rmSync(demoDb, { force: true });
  const server: ChildProcess = spawn("npx", ["tsx", "server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      VALE_REPLAY: "1",
      META_API_KEY: "",
      PORT: String(port),
      VALE_DB_PATH: demoDb,
    },
    stdio: "inherit",
  });
  const stopServer = () => {
    try {
      server.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("SIGINT", () => {
    stopServer();
    process.exit(1);
  });
  try {
    await waitUp(port);
    ensureChromium();
    const browser = await chromium.launch({
      headless: false,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--use-file-for-fake-audio-capture=/tmp/silence.wav",
      ],
    });
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle", timeout: 60000 });
      await page.getByRole("button", { name: "Wake Vale" }).click({ timeout: 30000 });
      await page.getByRole("button", { name: "Mute microphone" }).click({ timeout: 30000 });
      // Warm-up: the typed sender wires up with the mic session, which
      // takes a couple of seconds after wake. Clicking earlier is lost.
      await page.waitForTimeout(4000);
      const shots = join(root, "replay", "shots");
      mkdirSync(shots, { recursive: true });
      const shotTaken = new Set<string>();
      for (const [index, turn] of run.turns.entries()) {
        console.log(`[demo] scene: ${turn.scene} (${index + 1}/${run.turns.length})`);
        const box = page.getByRole("textbox", { name: "Type to Vale" });
        await box.fill(turn.transcript, { timeout: 30000 });
        // Wait for the send to enable, then Enter: an open sheet can cover
        // the button, and the form submits on Enter like the manual flow.
        await page.waitForFunction(
          () =>
            !(
              document.querySelector(
                'button[aria-label="Send message"]',
              ) as HTMLButtonElement | null
            )?.disabled,
          undefined,
          { timeout: 30000 },
        );
        // Click, not Enter: the form only submits via the send button.
        // Force: an open sheet can cover the button; the DOM event is real.
        const sendBtn = page.getByRole("button", { name: "Send message" });
        await sendBtn.click({ force: true, timeout: 30000 });
        try {
          await page.getByText(turn.reply).first().waitFor({ timeout: 15000 });
        } catch {
          // Click landed before the sender was ready: the text is still
          // in the box, so click again like a user would.
          if ((await box.inputValue()) !== "") await sendBtn.click({ force: true, timeout: 30000 });
          await page.getByText(turn.reply).first().waitFor({ timeout: 90000 });
        }
        if (turn.widget) await page.waitForTimeout(1500);
        await quiet(page);
        const shot = SHOT_SCENES[turn.scene];
        if (shot && !shotTaken.has(shot)) {
          shotTaken.add(shot);
          await page.screenshot({ path: join(shots, shot) });
          console.log(`[demo] shot: ${shot}`);
        }
      }
      console.log(`[demo] complete: ${run.turns.length} turns, one voice at a time`);
      await browser.close();
    } finally {
      await browser.close().catch(() => undefined);
    }
  } finally {
    stopServer();
  }
}

void main().catch((error: unknown) => {
  console.error(`[demo] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
