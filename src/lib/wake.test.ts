// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chainFailed, chainSucceeded, nextPreviousResponseId } from "./response-chain";
import {
  checkWake,
  clearQuestion,
  collapseEcho,
  isGreetingOnly,
  isUndoIntent,
  markQuestionAsked,
  namesVale,
  requestClientId,
  sanitizeClientId,
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

  it("hears Vale in either confirm word order", () => {
    expect(namesVale("vale, sí agrégalo")).toBe(true);
    expect(namesVale("sí, vale, agrégalo")).toBe(true);
    expect(checkWake("sí, vale, agrégalo", "ip-confirm", 1000).execute).toBe(
      true,
    );
  });

  it("executes when named and opens the attention window", () => {
    const verdict = checkWake("vale, abre una sesión", "ip-1", 1000);
    expect(verdict).toEqual({ execute: true, namedVale: true });
    // A fresh request without the name stays ignored inside the window.
    expect(checkWake("abre la sesión", "ip-1", 1000 + 44_000).execute).toBe(
      false,
    );
  });

  it("covers only continuations inside the window", () => {
    checkWake("vale, gasta algo", "ip-c1", 1000);
    // Vale asked: the answer and the completion run nameless.
    markQuestionAsked("ip-c1", 1000);
    expect(checkWake("brillo lunar", "ip-c1", 2000).execute).toBe(true);
    expect(checkWake("sí", "ip-c1", 2000).execute).toBe(true);
    clearQuestion("ip-c1");
    // No pending question: fresh requests need the name.
    expect(checkWake("abre otra sesión", "ip-c1", 2000).execute).toBe(false);
    expect(checkWake("¿qué hora es?", "ip-c1", 2000).execute).toBe(false);
  });

  it("lets an undo through without the name inside the window", () => {
    checkWake("vale, abre una sesión", "ip-u1", 1000);
    expect(checkWake("deshazlo", "ip-u1", 2000).execute).toBe(true);
    expect(checkWake("undo it", "ip-u1", 2000).execute).toBe(true);
    expect(checkWake("deshazlo", "ip-u1", 1000 + 45_000).execute).toBe(false);
  });

  it("retires the pending question with the window", () => {
    checkWake("vale, gasta algo", "ip-c2", 1000);
    markQuestionAsked("ip-c2", 1000);
    expect(checkWake("brillo lunar", "ip-c2", 1000 + 44_999).execute).toBe(
      true,
    );
    expect(checkWake("brillo lunar", "ip-c2", 1000 + 45_000).execute).toBe(
      false,
    );
    clearQuestion("ip-c2");
  });

  it("collapses echoed repeats before the gate", () => {
    expect(collapseEcho("Hola,Hola")).toBe("Hola");
    expect(collapseEcho("mí? mí?")).toBe("mí?");
    expect(collapseEcho("abre sesión abre sesión")).toBe("abre sesión");
    expect(collapseEcho("la la clienta")).toBe("la clienta");
    expect(collapseEcho("vale abre una sesión")).toBe("vale abre una sesión");
    expect(collapseEcho("muy bueno")).toBe("muy bueno");
    expect(collapseEcho("")).toBe("");
    expect(collapseEcho("  ")).toBe("");
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

  it("ignores after the window expires", () => {
    checkWake("vale, hola", "ip-3", 3000);
    expect(checkWake("sigue hablando", "ip-3", 3000 + 45_000).execute).toBe(false);
    expect(checkWake("sigue hablando", "ip-3", 3000 + 44_999).execute).toBe(false);
  });

  it("keeps windows per client", () => {
    checkWake("vale, hola", "ip-4", 4000);
    expect(checkWake("oye esto", "ip-5", 4000).execute).toBe(false);
    expect(checkWake("oye esto", "ip-4", 4000).execute).toBe(false);
  });

  it("lets empty transcripts through to the silence path", () => {
    expect(checkWake("", "ip-6", 5000)).toEqual({ execute: true, namedVale: false });
  });

  it("never touches the response chain, kept or dropped", () => {
    chainFailed();
    checkWake("ruido de fondo", "ip-7", 6000);
    expect(nextPreviousResponseId()).toBeUndefined();
    chainSucceeded("resp_kept", true);
    checkWake("más ruido", "ip-8", 6000);
    expect(nextPreviousResponseId()).toBe("resp_kept");
    chainFailed();
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
