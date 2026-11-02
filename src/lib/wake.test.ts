// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  checkWake,
  isGreetingOnly,
  isUndoIntent,
  languageMismatch,
  namesVale,
  requestClientId,
  sanitizeClientId,
  shouldCutPhrase,
  wakeWords,
} from "./wake";

describe("wake word gate", () => {
  it("names Vale with case, accents and punctuation around it", () => {
    expect(namesVale("vale, abre una sesión")).toBe(true);
    expect(namesVale("¿Vale?")).toBe(true);
    expect(namesVale("Sì, vale")).toBe(true);
    expect(namesVale("hola")).toBe(false);
    expect(namesVale("chavales")).toBe(false);
    expect(namesVale("")).toBe(false);
  });

  it("hears Vale in any of the first three words, in either language", () => {
    expect(namesVale("vale, sí agrégalo")).toBe(true);
    expect(namesVale("thanks, Vale")).toBe(true);
    expect(namesVale("okay, Vale")).toBe(true);
    expect(namesVale("hey Bale")).toBe(true);
    expect(namesVale("sí, vale, agrégalo")).toBe(true);
    expect(namesVale("Hola Vale")).toBe(true);
    expect(namesVale("Oye Vale, abre sesión")).toBe(true);
    expect(namesVale("Buenas Vale")).toBe(true);
    expect(namesVale("oye por favor Vale abre")).toBe(false);
    expect(checkWake("thanks, Vale", "ip-confirm", 1000).execute).toBe(true);
    expect(
      checkWake("oye por favor Vale abre", "ip-confirm-cold", 1000).execute,
    ).toBe(false);
  });

  it("executes when named and opens the attention window", () => {
    const verdict = checkWake("vale, open a session", "ip-1", 1000);
    expect(verdict.execute).toBe(true);
    expect(verdict.namedVale).toBe(true);
    expect(verdict.gate).toBe("nombre");
  });

  it("hears the measured ASR spellings of the wake word", () => {
    expect(namesVale("Balle, repeat that please")).toBe(true);
    expect(namesVale("Thanks, Bali. That's all.")).toBe(true);
    expect(namesVale("Vale, open a session")).toBe(true);
    // A positional rule wakes on mentions inside the first three words:
    // the accepted cost of no opener or greeting lists (lead call).
    expect(namesVale("Bale nails are so trendy")).toBe(true);
    expect(namesVale("Nails by Bale are trendy")).toBe(true);
    expect(namesVale("the Vale shop")).toBe(true);
    expect(namesVale("chavales")).toBe(false);
  });

  it("accepts any request inside the window, not just continuations", () => {
    checkWake("vale, open a session", "ip-c1", 1000);
    expect(checkWake("close the session", "ip-c1", 2000)).toEqual({
      execute: true,
      namedVale: false,
      gate: "ventana",
      sinceReplyS: 1,
    });
    expect(checkWake("yes", "ip-c1", 3000).execute).toBe(true);
    expect(checkWake("what time is it", "ip-c1", 4000).execute).toBe(true);
  });

  it("lets an undo through without the name inside the window", () => {
    checkWake("vale, open a session", "ip-u1", 1000);
    expect(checkWake("undo it", "ip-u1", 2000).execute).toBe(true);
    // The nameless turn renewed the window, so expiry counts from it.
    expect(checkWake("undo it", "ip-u1", 2000 + 45_000).execute).toBe(false);
  });

  it("restarts the window on every executed turn", () => {
    checkWake("vale, open a session", "ip-s1", 1000);
    checkWake("close the session", "ip-s1", 1000 + 44_000);
    // The nameless turn renewed the window: still open 44 s later.
    expect(checkWake("what time is it", "ip-s1", 1000 + 88_000).execute).toBe(
      true,
    );
    // ...but it finally expires without turns.
    expect(
      checkWake("what time is it", "ip-s1", 1000 + 88_000 + 45_000).execute,
    ).toBe(false);
  });

  it("reports the gate and the seconds since the last reply", () => {
    expect(checkWake("vale, hi", "ip-g1", 1000)).toMatchObject({
      gate: "nombre",
      sinceReplyS: null,
    });
    expect(checkWake("what time is it", "ip-g1", 4000)).toMatchObject({
      gate: "ventana",
      sinceReplyS: 3,
    });
    expect(checkWake("background chatter", "ip-g2", 4000)).toMatchObject({
      gate: "ignorado",
      sinceReplyS: null,
    });
  });

  it("spots undo intent and bare greetings", () => {
    expect(isUndoIntent("deshazlo")).toBe(true);
    expect(isUndoIntent("vale, deshaz eso")).toBe(true);
    expect(isUndoIntent("undo it")).toBe(true);
    expect(isUndoIntent("deshazlo todo")).toBe(true);
    expect(isUndoIntent("segundo turno")).toBe(false);
    expect(isUndoIntent("abre sesión")).toBe(false);
    expect(isGreetingOnly("hola")).toBe(true);
    expect(isGreetingOnly("vale, hola")).toBe(true);
    expect(isGreetingOnly("buenas tardes")).toBe(true);
    expect(isGreetingOnly("hola, abre sesión")).toBe(false);
    expect(isGreetingOnly("¿qué puedes hacer?")).toBe(false);
    expect(isGreetingOnly("")).toBe(false);
  });

  it("ignores strangers outside the window", () => {
    expect(checkWake("qué hora es", "ip-2", 2000).execute).toBe(false);
  });

  it("never mistakes endearments for the name", () => {
    for (const word of [
      "darling",
      "love",
      "honey",
      "dear",
      "sweetie",
      "babe",
      "hun",
    ]) {
      expect(wakeWords()).not.toContain(word);
      expect(namesVale(`hey ${word}, good morning`)).toBe(false);
    }
    // Field case: with headphones on, 16 min after the last reply, the ASR
    // heard "darling" for "Vale". Outside the window it stays ignored.
    expect(checkWake("Hey darling, good morning", "ip-darling", 1000)).toEqual(
      {
        execute: false,
        namedVale: false,
        gate: "ignorado",
        sinceReplyS: null,
      },
    );
  });

  it("stretches the window to 90 s with an open session", () => {
    checkWake("vale, open a session", "ip-w90", 1000, true);
    // Expiry first: an in-window probe would renew the window itself.
    expect(checkWake("follow up", "ip-w90", 1000 + 90_000, true).execute).toBe(
      false,
    );
    checkWake("vale, open a session", "ip-w90b", 1000, true);
    expect(
      checkWake("follow up", "ip-w90b", 1000 + 89_000, true).execute,
    ).toBe(true);
  });

  it("ignores after the window expires", () => {
    checkWake("vale, hola", "ip-3", 3000);
    // Expiry first: an in-window probe would renew the window itself.
    expect(checkWake("sigue hablando", "ip-3", 3000 + 45_000).execute).toBe(
      false,
    );
    checkWake("vale, hi", "ip-3b", 3000);
    expect(checkWake("sigue hablando", "ip-3b", 3000 + 44_999).execute).toBe(
      true,
    );
  });

  it("keeps windows per client", () => {
    checkWake("vale, hi", "ip-4", 4000);
    expect(checkWake("oye esto", "ip-5", 4000).execute).toBe(false);
    expect(checkWake("oye esto", "ip-4", 4000).execute).toBe(true);
  });

  it("lets empty transcripts through to the silence path", () => {
    expect(checkWake("", "ip-6", 5000)).toEqual({
      execute: true,
      namedVale: false,
      gate: "ignorado",
      sinceReplyS: null,
    });
  });

  it("gives the same verdict for the same background chatter", () => {
    expect(checkWake("background noise", "ip-7", 6000)).toEqual(
      checkWake("background noise", "ip-7", 6000),
    );
    expect(checkWake("vale, hi", "ip-8", 6000).gate).toBe("nombre");
  });

  it("prefers the explicit browser id over the IP", () => {
    const withId = new Request("https://vale.test/api/voice?client=Browser-9", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    expect(requestClientId(withId)).toBe("browser-9");
    const bare = new Request("https://vale.test/api/voice", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    expect(requestClientId(bare)).toBe("10.0.0.1");
    const bad = new Request("https://vale.test/api/voice?client=../../etc", {
      headers: { "x-forwarded-for": "10.0.0.2" },
    });
    expect(requestClientId(bad)).toBe("10.0.0.2");
  });

  it("sanitizes browser ids", () => {
    expect(sanitizeClientId("Abc-123_x")).toBe("abc-123_x");
    expect(sanitizeClientId("")).toBeNull();
    expect(sanitizeClientId("../../etc")).toBeNull();
    expect(sanitizeClientId(42)).toBeNull();
  });
});

describe("language gate (gate:idioma)", () => {
  it("catches the ear-log case: Spanish aside inside the English window", () => {
    expect(languageMismatch("¿Qué le digo?", "en")).toBe(true);
    expect(
      checkWake("¿Qué le digo?", "ip-ear", 1000, false, "en"),
    ).toMatchObject({ execute: false, gate: "idioma" });
  });
  it("never idioma-discards a phrase that names Vale, in either language", () => {
    expect(languageMismatch("vale abre sesion con Ana", "en")).toBe(true);
    expect(
      checkWake("vale abre sesion con Ana", "ip-lang", 1000, false, "en"),
    ).toMatchObject({ execute: true, namedVale: true, gate: "nombre" });
    expect(languageMismatch("vale book Ana for tomorrow", "es")).toBe(true);
    expect(
      checkWake("vale book Ana for tomorrow", "ip-lang-2", 1000, false, "es"),
    ).toMatchObject({ execute: true, namedVale: true, gate: "nombre" });
  });

  it("still discards unnamed content in the other language", () => {
    expect(
      checkWake("abre sesion con Ana", "ip-lang-unnamed", 1000, false, "en"),
    ).toMatchObject({ execute: false, gate: "idioma" });
    // No window opened: a later English turn still needs the name.
    expect(
      checkWake("open a session", "ip-lang-unnamed", 2000, false, "en").execute,
    ).toBe(false);
  });

  it("lets a bare name call through and keeps English flowing", () => {
    expect(languageMismatch("vale", "en")).toBe(false);
    expect(
      checkWake("vale", "ip-lang-bare", 1000, false, "en"),
    ).toMatchObject({ execute: true, gate: "nombre" });
    expect(languageMismatch("vale book Ana for gel refill", "en")).toBe(
      false,
    );
  });

  it("lets matching content through under its own selector", () => {
    expect(
      checkWake("vale abre sesion con Ana", "ip-lang-es", 1000, false, "es"),
    ).toMatchObject({ execute: true, gate: "nombre" });
  });
});

describe("shouldCutPhrase (client-side early cut)", () => {
  it("cuts a long unnamed phrase with no session and a closed window", () => {
    expect(
      shouldCutPhrase({
        text: "I was talking to my neighbor about the appointment",
        sessionOpen: false,
        windowOpen: false,
      }),
    ).toBe(true);
  });

  it("waits for the opening words before judging", () => {
    expect(
      shouldCutPhrase({
        text: "I was talking",
        sessionOpen: false,
        windowOpen: false,
      }),
    ).toBe(false);
  });

  it("never cuts a phrase that names her, however long", () => {
    expect(
      shouldCutPhrase({
        text: "please book my neighbor Ana for a gel removal tomorrow Vale",
        sessionOpen: false,
        windowOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldCutPhrase({
        text: "Vale please book my neighbor Ana for a gel removal tomorrow",
        sessionOpen: false,
        windowOpen: false,
      }),
    ).toBe(false);
  });

  it("stays off with a session open or the window open", () => {
    const text = "I was talking to my neighbor about the appointment";
    expect(
      shouldCutPhrase({ text, sessionOpen: true, windowOpen: false }),
    ).toBe(false);
    expect(
      shouldCutPhrase({ text, sessionOpen: false, windowOpen: true }),
    ).toBe(false);
  });
});
