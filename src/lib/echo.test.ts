import { describe, expect, it } from "vitest";
import { isEchoOfReply, resemblesReply } from "./echo";

const REPLY = "Te anoto manana a las tres.";

describe("isEchoOfReply", () => {
  it("matches her exact words at any length", () => {
    expect(isEchoOfReply("Te anoto manana a las tres.", REPLY)).toBe(true);
  });
  it("matches a long transcript mostly inside the reply", () => {
    expect(
      isEchoOfReply("Hey there great to hear you today", "Hey there great to hear you today friend"),
    ).toBe(true);
  });
  it("never counts short talk as echo", () => {
    expect(isEchoOfReply("yes", REPLY)).toBe(false);
    expect(isEchoOfReply("confirm it", REPLY)).toBe(false);
  });
  it("rejects dissimilar speech and empty replies", () => {
    expect(isEchoOfReply("Vale book it November first", REPLY)).toBe(false);
    expect(isEchoOfReply(REPLY, null)).toBe(false);
    expect(isEchoOfReply(REPLY, "")).toBe(false);
  });
});

describe("resemblesReply", () => {
  it("counts short fragments fully inside the reply", () => {
    expect(resemblesReply("Vale booking", "Vale booking Ana for noon")).toBe(
      true,
    );
  });
  it("rejects short fragments with words outside the reply", () => {
    expect(resemblesReply("Vale book it", REPLY)).toBe(false);
  });
  it("agrees with the server rule on long transcripts", () => {
    expect(resemblesReply(REPLY, REPLY)).toBe(true);
    expect(resemblesReply("Vale book it November first", REPLY)).toBe(false);
  });
});
