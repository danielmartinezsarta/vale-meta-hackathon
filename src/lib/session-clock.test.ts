import { describe, expect, it } from "vitest";
import { sessionClock } from "./session-clock";

describe("session clock", () => {
  it("formats HH:MM:SS from the table start", () => {
    const start = new Date("2026-11-02T10:00:00Z").getTime();
    expect(sessionClock(new Date(start).toISOString(), start)).toBe("00:00:00");
    expect(sessionClock(new Date(start).toISOString(), start + 3723 * 1000)).toBe("01:02:03");
    expect(sessionClock("not-a-date", start)).toBe("00:00:00");
  });
});
