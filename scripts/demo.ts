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
import { AUTO_HIDE_WIDGET_KINDS } from "../src/lib/widget";
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
    // Persistent context in app mode: one window, no tab bar, no address
    // bar. The page sizes to the real window (viewport null), filling it
    // edge to edge at any size, so no grey band can appear. Chrome will
    // not go narrower than this phone-like window.
    const profileDir = join(tmpdir(), `vale-demo-profile-${port}`);
    rmSync(profileDir, { recursive: true, force: true });
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: [
        "--use-fake-ui-for-media-stream",
        // Let the AudioContext run: without it the capture posts zeros,
        // the app calls the mic blocked, and the session dies on turn 1.
        "--autoplay-policy=no-user-gesture-required",
        `--app=http://localhost:${port}/`,
        "--window-size=430,932",
      ],
      viewport: null,
      colorScheme: "dark",
    });
    const browser = context;
    try {
      await context.grantPermissions(["microphone"], {
        origin: `http://localhost:${port}`,
      });
      await context.grantPermissions(["microphone"], {
        origin: `http://localhost:${port}`,
      });
      // Strings, not closures: the runner compiles closures with helpers
      // the browser does not have, which fails the whole init script.
      await context.addInitScript(`window.localStorage.setItem("vale-theme", "dark");`);
      // Alert flash log: records every role=alert node with its text,
      // so a transient banner names itself instead of stopping the run blind.
      await context.addInitScript(`
        window.__alertFlashes = window.__alertFlashes || [];
        const __log = window.__alertFlashes;
        const __seen = new WeakSet();
        const __record = (alert) => {
          if (__seen.has(alert)) return;
          __seen.add(alert);
          __log.push({ t: Date.now(), text: (alert.innerText || "").slice(0, 120) });
        };
        const __observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type === "attributes") {
              const target = mutation.target;
              if (target instanceof HTMLElement && target.getAttribute("role") === "alert") {
                // Re-log on every show: one reused node would log once.
                __seen.delete(target);
                __record(target);
              }
              continue;
            }
            for (const node of mutation.addedNodes) {
              if (!(node instanceof HTMLElement)) continue;
              const alerts =
                node.getAttribute && node.getAttribute("role") === "alert"
                  ? [node]
                  : Array.from(node.querySelectorAll ? node.querySelectorAll('[role="alert"]') : []);
              for (const alert of alerts) __record(alert);
            }
          }
        });
        const start = () => {
          // The init script can run before the document exists: wait for
          // the root instead of throwing and losing the whole flash log.
          if (!document.documentElement) {
            window.setTimeout(start, 50);
            return;
          }
          // Attributes too: the empty session alert is one reused node
          // being shown and hidden, not a fresh node every turn.
          __observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["hidden", "class", "style"],
          });
        };
        start();
      `);
      // The --app window opens the URL on its own: adopt that page
      // instead of opening a second window.
      let page: Page | null = null;
      for (let i = 0; i < 30 && page === null; i += 1) {
        const open = context.pages();
        if (open.length > 0) page = open[0];
        else await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (page === null) throw new Error("app window never opened");
      await page.emulateMedia({ colorScheme: "dark" });
      // Measure, don't guess: every turn must fire exactly one POST, and
      // any exception in the submit chain shows up here, not as a hang.
      let voicePosts = 0;
      page.on("request", (req) => {
        if (req.method() === "POST" && req.url().includes("/api/voice")) voicePosts += 1;
      });
      page.on("pageerror", (err) => {
        const stack = err instanceof Error ? err.stack ?? String(err) : String(err);
        console.log(`[demo] pageerror: ${stack.slice(0, 400)}`);
      });
      const realClick = async (name: string | RegExp) => {
        // A real mouse click: audio only unlocks from a gesture.
        const button = page.getByRole("button", { name });
        await button.waitFor({ timeout: 30000 });
        const at = await button.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });
        await page.mouse.click(at.x, at.y);
      };
      const startVoice = async () => {
        await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle", timeout: 60000 });
        await realClick("Wake Vale");
        // Mute the instant the button exists, before capture checks the
        // context (~1 s after wake): the typed field shows for every turn.
        // The app raises no mic alert while muted; unmuting resumes capture.
        const muteBtn = page.getByRole("button", { name: "Mute microphone" });
        await muteBtn.waitFor({ state: "visible", timeout: 30000 });
        await muteBtn.click({ timeout: 30000 });
        // Warm-up: the typed sender wires up with the mic session, which
        // takes a couple of seconds after wake. Sending earlier is lost.
        await page.waitForTimeout(4000);
      };
      await startVoice();
      // Measure the chrome once: pill, side buttons and orb boxes decide
      // the pill width, not guesses from screenshots.
      const rects = await page.evaluate(`(() => {
        const box = (e) => {
          if (!e) return null;
          const b = e.getBoundingClientRect();
          return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) };
        };
        const q = (sel) => document.querySelector(sel);
        const pill = q("[aria-label='Replay controls']");
        const mute = q('button[aria-label="Mute microphone"]') || q('button[aria-label="Unmute microphone"]');
        const sleep = q('button[aria-label="Put Vale to sleep"]');
        return JSON.stringify({
          viewport: { w: window.innerWidth, h: window.innerHeight },
          pill: box(pill),
          mute: box(mute),
          sleep: box(sleep),
          pillButtons: pill ? pill.querySelectorAll("button").length : 0,
        });
      })()`);
      console.log(`[demo] rects ${rects}`);
      // Same browser id the app stored, so the demo reads the same cursor
      // the pill shows.
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
          console.log(
            `[demo] no reply yet ${turn.turn} posts=${voicePosts} box=${JSON.stringify(await box.inputValue().catch(() => "?"))}`,
          );
          if ((await box.inputValue()) !== "") await sendBtn.click({ force: true, timeout: 30000 });
          try {
            await seen.waitFor({ timeout: 90000, state: "attached" });
          } catch {
            await page.screenshot({ path: join(shots, `miss-${turn.turn}.png`) });
            const tail = (
              (await page.evaluate(() => document.body.innerText)) as string
            ).slice(-400);
            console.log(`[demo] miss ${turn.turn} url=${page.url()} tail=${tail}`);
            throw new Error(`reply never showed for ${turn.turn}`);
          }
        }
        if (turn.widget) await page.waitForTimeout(1500);
        // A sheet dialog compacts the pill to its slim bar; the shot
        // waits for it so no title or label hides behind the full pill.
        // The 1 s pill poll can lag the shot, so this wait is explicit.
        const dialogOpen = await page.evaluate(
          () => document.querySelector('[role="dialog"]:not([aria-hidden="true"])') !== null,
        );
        // Shot turns need the compact pill while their sheet is open; a
        // sheet that already auto-hid needs no pill and stops no run.
        if (SHOT_TURNS[turn.turn] && dialogOpen) {
          await page
            .waitForSelector('[aria-label="Replay controls"][data-compact="true"]', { timeout: 8000 })
            .catch(() => {});
          await page.waitForTimeout(1200);
          const stillOpen = await page.evaluate(
            () => document.querySelector('[role="dialog"]:not([aria-hidden="true"])') !== null,
          );
          const compactNow = await page.evaluate(
            () =>
              document.querySelector('[aria-label="Replay controls"]')?.getAttribute("data-compact") ===
              "true",
          );
          console.log(`[demo] shot-state ${turn.turn} dialog=${stillOpen} compact=${compactNow}`);
          if (stillOpen && !compactNow) throw new Error(`pill covers the ${turn.turn} sheet`);
        }
        // Shoot before quiet: display-only sheets auto-hide 3 s after
        // they open, so waiting for speech first would miss the card.
        const shot = SHOT_TURNS[turn.turn];
        if (shot && !shotTaken.has(shot)) {
          shotTaken.add(shot);
          await page.screenshot({ path: join(shots, shot) });
          console.log(`[demo] shot: ${shot}`);
        }
        await quiet(page);
        // A session alert banner means the run is broken: stop loud,
        // never hang. Banners can flash mid-render, so only a banner
        // that stays put aborts the run. Every real alert carries text;
        // an empty node is a render transient, logged, never fatal.
        const banner = page.getByRole("alert").first();
        if (await banner.isVisible().catch(() => false)) {
          await page.waitForTimeout(1500);
          if (await banner.isVisible().catch(() => false)) {
            const text = ((await banner.innerText().catch(() => "")) || "").trim().slice(0, 120);
            if (text !== "") {
              await page.screenshot({ path: join(shots, `alert-${turn.turn}.png`) });
              const flashes = await page
                .evaluate(
                  () =>
                    JSON.stringify(
                      (window as unknown as { __alertFlashes?: unknown }).__alertFlashes ?? [],
                    ),
                )
                .catch(() => "n/a");
              console.log(`[demo] alert flashes: ${flashes}`);
              throw new Error(`demo stopped: session alert on screen: ${text}`);
            }
            console.log(`[demo] transient empty alert node at ${turn.turn}, continuing`);
          }
        }
        // Tidy the sheet like a user would, so the next turn's card is
        // its own. Display-only sheets auto-hide; only button kinds and
        // the client card need a hand. The X names the open sheet.
        if (!turn.widget || !AUTO_HIDE_WIDGET_KINDS.includes(turn.widget.kind)) {
          const closer = page.getByRole("button", { name: /^Close / });
          if ((await closer.count()) > 0) await closer.first().click({ timeout: 5000 });
          await page.keyboard.press("Escape");
          await page.waitForTimeout(500);
        }
        // A decision sheet has no X: the recorded user tapped a choice
        // (quote, then payment), so the demo taps Accept the same way.
        const priceAccept = page
          .getByRole("dialog", { name: "Price" })
          .getByRole("button", { name: "Accept" });
        if ((await priceAccept.count()) > 0) await priceAccept.first().click({ timeout: 5000 });
        // A sheet covering the send button eats the next turn's click
        // without a sound (the text stays in the box, no POST). Prove the
        // button is reachable; stop loud naming the cover when it is not.
        const covering = await page.evaluate(() => {
          const btn = document.querySelector('button[aria-label="Send message"]');
          if (!btn) return "no-send-button";
          const r = btn.getBoundingClientRect();
          const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (!el || btn.contains(el)) return "ok";
          const dlg = typeof el.closest === "function" ? el.closest('[role="dialog"]') : null;
          return `covered-by:${dlg ? dlg.getAttribute("aria-label") : el.tagName}`;
        });
        if (covering !== "ok") throw new Error(`send button not reachable: ${covering}`);
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
        try {
          await typeTurn(run.turns[state.cursor], state.cursor);
        } catch (error) {
          // No reload: a stall mid-run is an app bug until proven
          // otherwise. Dump the sender state, then stop loud.
          const diag = await page
            .evaluate((posts: number) => {
              const btns = Array.from(
                document.querySelectorAll('button[aria-label="Send message"]'),
              ) as HTMLButtonElement[];
              const tbs = Array.from(
                document.querySelectorAll('[aria-label="Type to Vale"]'),
              ) as HTMLInputElement[];
              const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).map((d) =>
                (d.getAttribute("aria-label") ?? "?").slice(0, 40),
              );
              return JSON.stringify({
                posts,
                sendBtns: btns.map((e) => ({
                  disabled: e.disabled,
                  connected: e.isConnected,
                })),
                boxes: tbs.map((e) => ({ value: e.value.slice(0, 60), connected: e.isConnected })),
                dialogs,
                tail: (document.body.innerText ?? "").slice(-200),
              });
            }, voicePosts)
            .catch(() => "diag-failed");
          console.log(`[demo] miss-diag ${run.turns[state.cursor].turn} ${diag}`);
          throw error;
        }
      }
      const flashes = await page
        .evaluate(
          () =>
            JSON.stringify(
              (window as unknown as { __alertFlashes?: unknown }).__alertFlashes ?? [],
            ),
        )
        .catch(() => "n/a");
      console.log(`[demo] alert flashes: ${flashes}`);
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
