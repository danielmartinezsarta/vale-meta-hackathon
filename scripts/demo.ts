// npm run demo: the committed run through the real app, keyless.
// Starts the replay server on a free port, then opens a headed Chromium
// and plays every recorded turn exactly like the manual path: open the
// app, wake Vale, mute the mic first, type each turn, wait for Vale to
// finish speaking and the card to show, next turn. One voice at a time.
// Prints the scene name per turn. Exits non-zero on miss.
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium, type Page } from "playwright";
import { parseReplayRun } from "../src/lib/replay";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Shot by turn tag: each shot needs that turn's own card on screen.
const SHOT_TURNS: Record<string, string> = {
  t901: "agenda.png",
  t910: "card.png",
  t923: "studio.png",
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
  // The server runs the production build, so rebuild first: the demo must
  // play the current code, never a stale .next.
  console.log("[demo] building the app...");
  execSync("npm run build", { cwd: root, stdio: "inherit" });
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
        // Let the AudioContext run: without it the capture posts zeros,
        // the app calls the mic blocked, and the session dies on turn 1.
        "--autoplay-policy=no-user-gesture-required",
        "--window-size=430,932",
      ],
    });
    try {
      const context = await browser.newContext({
        // Null viewport: the page fills the window, so no grey band
        // shows anywhere. The window size matches a phone.
        viewport: null,
        // The demo runs in dark mode. The theme key is set before the
        // first load so the first paint is already dark.
        colorScheme: "dark",
      });
      await context.grantPermissions(["microphone"], {
        origin: `http://localhost:${port}`,
      });
      await context.addInitScript(() => {
        window.localStorage.setItem("vale-theme", "dark");
      });
      const page = await context.newPage();
      await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle", timeout: 60000 });
      // A real mouse click: the session only starts from a gesture.
      const wakeBtn = page.getByRole("button", { name: "Wake Vale" });
      await wakeBtn.waitFor({ timeout: 30000 });
      const at = await wakeBtn.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      await page.mouse.click(at.x, at.y);
      // Mute the instant the button exists, before capture checks the
      // context (~1 s after wake): muting stops capture, so the blocked
      // alert never fires, and the typed field shows for every turn.
      const muteBtn = page.getByRole("button", { name: "Mute microphone" });
      await muteBtn.waitFor({ state: "visible", timeout: 30000 });
      await muteBtn.click({ timeout: 30000 });
      // Warm-up: the typed sender wires up with the mic session, which
      // takes a couple of seconds after wake. Sending earlier is lost.
      await page.waitForTimeout(4000);
      // Same browser id the app stored, so the demo reads the same cursor
      // the pill shows. It survives a reload, which keeps recovery exact.
      const clientId =
        (await page.evaluate(() => window.localStorage.getItem("vale-client"))) ?? "";
      // The route answers HTML or empty while Next compiles: retry
      // until it returns JSON, up to 60 s.
      const readState = async (): Promise<{
        cursor: number;
        total: number;
        paused: boolean;
        done: boolean;
      }> => {
        const deadline = Date.now() + 60000;
        for (;;) {
          try {
            const response = await fetch(
              `http://localhost:${port}/api/voice?replay=state&client=${encodeURIComponent(clientId)}`,
            );
            return (await response.json()) as {
              cursor: number;
              total: number;
              paused: boolean;
              done: boolean;
            };
          } catch {
            if (Date.now() > deadline) throw new Error("replay state never came up");
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      };
      const shots = join(root, "replay", "shots");
      mkdirSync(shots, { recursive: true });
      const shotTaken = new Set<string>();
      // One turn as text through the typed box: the form only submits
      // via the send button. Force: an open sheet can cover the button,
      // but the DOM event is real.
      const typeTurn = async (turn: (typeof run.turns)[number], index: number) => {
        console.log(`[demo] scene: ${turn.scene} (${index + 1}/${run.turns.length})`);
        const box = page.getByRole("textbox", { name: "Type to Vale" });
        await box.fill(turn.transcript, { timeout: 30000 });
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
        const sendBtn = page.getByRole("button", { name: "Send message" });
        await sendBtn.click({ force: true, timeout: 30000 });
        // Match on the reply head: the tail can render across elements.
        // Attached, not visible: the open sheet can cover the bubbles.
        const head = turn.reply.slice(0, 48).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const seen = page.getByText(new RegExp(head)).first();
        try {
          await seen.waitFor({ timeout: 15000, state: "attached" });
        } catch {
          // Click landed before the sender was ready: the text is still
          // in the box, so click again like a user would.
          if ((await box.inputValue()) !== "") await sendBtn.click({ force: true, timeout: 30000 });
          try {
            await seen.waitFor({ timeout: 90000, state: "attached" });
          } catch {
            await page.screenshot({ path: join(shots, `miss-${turn.turn}.png`) });
            console.log(`[demo] miss ${turn.turn} url=${page.url()}`);
            throw new Error(`reply never showed for ${turn.turn}`);
          }
        }
        if (turn.widget) await page.waitForTimeout(1500);
        await quiet(page);
        // A session alert banner means the run is broken: stop loud,
        // never hang. (The state subtitle can lag; only the banner counts.)
        const banner = page.getByRole("alert").first();
        if (await banner.isVisible().catch(() => false)) {
          const text = ((await banner.innerText().catch(() => "")) || "").slice(0, 120);
          await page.screenshot({ path: join(shots, `alert-${turn.turn}.png`) });
          throw new Error(`demo stopped: session alert on screen: ${text}`);
        }
        const shot = SHOT_TURNS[turn.turn];
        if (shot && !shotTaken.has(shot)) {
          shotTaken.add(shot);
          await page.screenshot({ path: join(shots, shot) });
          console.log(`[demo] shot: ${shot}`);
        }
        // Tidy the sheet like a user would, so the next turn's card is
        // its own. The X names the open sheet; Escape is its close key.
        const closer = page.getByRole("button", { name: /^Close / });
        if ((await closer.count()) > 0) await closer.first().click({ timeout: 5000 });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
      };
      // The demo types whatever turn the cursor points at, one at a time;
      // the pill's pause holds the reply, its stop and jumps move the cursor.
      for (;;) {
        const state = await readState();
        if (state.done || state.cursor >= run.turns.length) break;
        if (state.paused) {
          console.log(`[demo] paused at turn ${state.cursor + 1}/${state.total}`);
          await page.waitForTimeout(3000);
          continue;
        }
        await typeTurn(run.turns[state.cursor], state.cursor);
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
