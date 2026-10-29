// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chainFailed, chainSucceeded, nextPreviousResponseId } from "./response-chain";
import { checkWake, namesVale } from "./wake";

describe("wake word gate", () => {
  it("names Vale with case, accents and punctuation around it", () => {
    expect(namesVale("vale, abre una sesión")).toBe(true);
    expect(namesVale("¿Vale?")).toBe(true);
    expect(namesVale("Sì, vale")).toBe(true);
    expect(namesVale("hola")).toBe(false);
    expect(namesVale("chavales")).toBe(false);
    expect(namesVale("")).toBe(false);
  });

  it("executes when named and opens the attention window", () => {
    const verdict = checkWake("vale, abre una sesión", "ip-1", 1000);
    expect(verdict).toEqual({ execute: true, namedVale: true });
    const followUp = checkWake("abre la sesión", "ip-1", 1000 + 44_000);
    expect(followUp.execute).toBe(true);
  });

  it("ignores strangers outside the window", () => {
    expect(checkWake("qué hora es", "ip-2", 2000).execute).toBe(false);
  });

  it("ignores after the window expires", () => {
    checkWake("vale, hola", "ip-3", 3000);
    expect(checkWake("sigue hablando", "ip-3", 3000 + 45_000).execute).toBe(false);
    expect(checkWake("sigue hablando", "ip-3", 3000 + 44_999).execute).toBe(true);
  });

  it("keeps windows per client", () => {
    checkWake("vale, hola", "ip-4", 4000);
    expect(checkWake("oye esto", "ip-5", 4000).execute).toBe(false);
    expect(checkWake("oye esto", "ip-4", 4000).execute).toBe(true);
  });

  it("lets empty transcripts through to the silence path", () => {
    expect(checkWake("", "ip-6", 5000)).toEqual({ execute: true, namedVale: false });
  });

  it("never touches the response chain, kept or dropped", () => {
    chainFailed();
    checkWake("ruido de fondo", "ip-7", 6000);
    expect(nextPreviousResponseId()).toBeUndefined();
    chainSucceeded("resp_kept");
    checkWake("más ruido", "ip-8", 6000);
    expect(nextPreviousResponseId()).toBe("resp_kept");
    chainFailed();
  });
});
