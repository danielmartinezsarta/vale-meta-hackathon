// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bogotaDay, bogotaTime, formatNaturalDateTime, hour12, parseNaturalDate } from "./natural-date";
import type { NaturalDateAnchor } from "./natural-date";

// Monday on the Bogota calendar; the salon clock reads 3 PM.
const MONDAY: NaturalDateAnchor = { today: "2026-11-02", time: "15:00" };

describe("demo phrases (HACK-018 req 7)", () => {
  it("resolves 'next Friday at 5 PM' to the Friday of next week", () => {
    expect(parseNaturalDate("next Friday at 5 PM", MONDAY)).toEqual({
      day: "2026-11-13",
      time: "17:00",
    });
  });
  it("resolves 'Friday the 13th at 4' with the bare-hour PM default", () => {
    expect(parseNaturalDate("Friday the 13th at 4", MONDAY)).toEqual({
      day: "2026-11-13",
      time: "16:00",
    });
  });
  it("resolves 'tomorrow at three PM' with a word hour", () => {
    expect(parseNaturalDate("tomorrow at three PM", MONDAY)).toEqual({
      day: "2026-11-03",
      time: "15:00",
    });
  });
  it("resolves 'in three weeks, same time' to the anchor time", () => {
    expect(parseNaturalDate("in three weeks, same time", MONDAY)).toEqual({
      day: "2026-11-23",
      time: "15:00",
    });
  });
  it("finds the date inside a full booking sentence", () => {
    expect(
      parseNaturalDate("Book David next Friday at 5 PM for a gel removal", MONDAY),
    ).toEqual({ day: "2026-11-13", time: "17:00" });
  });
});

describe("weekday rules", () => {
  it("a bare weekday is the coming one, today excluded only past days", () => {
    expect(parseNaturalDate("Friday at 5 PM", MONDAY)).toEqual({
      day: "2026-11-06",
      time: "17:00",
    });
  });
  it("'this Friday' matches the bare weekday", () => {
    expect(parseNaturalDate("this Friday at 5pm", MONDAY)).toEqual({
      day: "2026-11-06",
      time: "17:00",
    });
  });
  it("'Sunday' from Monday is six days out", () => {
    expect(parseNaturalDate("Sunday at 10 AM", MONDAY)).toEqual({
      day: "2026-11-08",
      time: "10:00",
    });
  });
  it("'Friday' said Friday is today", () => {
    const friday: NaturalDateAnchor = { today: "2026-11-06", time: "15:00" };
    expect(parseNaturalDate("Friday at 5 PM", friday)).toEqual({
      day: "2026-11-06",
      time: "17:00",
    });
  });
  it("'next Friday' said Friday jumps a full week", () => {
    const friday: NaturalDateAnchor = { today: "2026-11-06", time: "15:00" };
    expect(parseNaturalDate("next Friday at 5 PM", friday)).toEqual({
      day: "2026-11-13",
      time: "17:00",
    });
  });
  it("accepts abbreviations and shrugs at case and commas", () => {
    expect(parseNaturalDate("Next Fri, at 5 p.m.", MONDAY)).toEqual({
      day: "2026-11-13",
      time: "17:00",
    });
  });
});

describe("relative days", () => {
  it("handles today, tomorrow and the day after", () => {
    expect(parseNaturalDate("today at 5 PM", MONDAY)).toEqual({
      day: "2026-11-02",
      time: "17:00",
    });
    expect(parseNaturalDate("tomorrow at 9 AM", MONDAY)).toEqual({
      day: "2026-11-03",
      time: "09:00",
    });
    expect(parseNaturalDate("day after tomorrow at noon", MONDAY)).toEqual({
      day: "2026-11-04",
      time: "12:00",
    });
  });
  it("handles digit and word counts for days and weeks", () => {
    expect(parseNaturalDate("in 2 days at 9 AM", MONDAY)).toEqual({
      day: "2026-11-04",
      time: "09:00",
    });
    expect(parseNaturalDate("in one week at 5 PM", MONDAY)).toEqual({
      day: "2026-11-09",
      time: "17:00",
    });
    expect(parseNaturalDate("in a week at 5 PM", MONDAY)).toEqual({
      day: "2026-11-09",
      time: "17:00",
    });
  });
  it("an explicit time beats 'same time'", () => {
    expect(parseNaturalDate("in three weeks at 5 PM", MONDAY)).toEqual({
      day: "2026-11-23",
      time: "17:00",
    });
  });
  it("'same time tomorrow' keeps the anchor time", () => {
    expect(parseNaturalDate("same time tomorrow", MONDAY)).toEqual({
      day: "2026-11-03",
      time: "15:00",
    });
  });
});

describe("month days", () => {
  it("resolves 'November 13' while still ahead", () => {
    expect(parseNaturalDate("November 13 at 5 PM", MONDAY)).toEqual({
      day: "2026-11-13",
      time: "17:00",
    });
  });
  it("rolls a past month-day into next year", () => {
    const late: NaturalDateAnchor = { today: "2026-11-20", time: "15:00" };
    expect(parseNaturalDate("November 13 at 5 PM", late)).toEqual({
      day: "2027-11-13",
      time: "17:00",
    });
  });
  it("accepts ordinals, 'of' and day-first order", () => {
    expect(parseNaturalDate("November 13th at 5 PM", MONDAY)).toEqual({
      day: "2026-11-13",
      time: "17:00",
    });
    expect(parseNaturalDate("13th of November at 5 PM", MONDAY)).toEqual({
      day: "2026-11-13",
      time: "17:00",
    });
    expect(parseNaturalDate("13 November at 5 PM", MONDAY)).toEqual({
      day: "2026-11-13",
      time: "17:00",
    });
  });
  it("checks a weekday named next to a month-day", () => {
    expect(parseNaturalDate("Friday, November 13 at 5 PM", MONDAY)).toEqual({
      day: "2026-11-13",
      time: "17:00",
    });
    expect(parseNaturalDate("Monday, November 13 at 5 PM", MONDAY)).toBeNull();
  });
  it("'the 13th' is the next 13th on or after today", () => {
    expect(parseNaturalDate("the 13th at 5 PM", MONDAY)).toEqual({
      day: "2026-11-13",
      time: "17:00",
    });
    const late: NaturalDateAnchor = { today: "2026-11-20", time: "15:00" };
    expect(parseNaturalDate("the 13th at 5 PM", late)).toEqual({
      day: "2026-12-13",
      time: "17:00",
    });
  });
  it("crosses the year boundary", () => {
    const newYear: NaturalDateAnchor = { today: "2026-12-31", time: "10:00" };
    expect(parseNaturalDate("tomorrow at 3 PM", newYear)).toEqual({
      day: "2027-01-01",
      time: "15:00",
    });
    expect(parseNaturalDate("January 5 at 3 PM", newYear)).toEqual({
      day: "2027-01-05",
      time: "15:00",
    });
  });
  it("reaches February 29th on the next leap year", () => {
    const common: NaturalDateAnchor = { today: "2027-01-15", time: "10:00" };
    expect(parseNaturalDate("February 29 at 3 PM", common)).toEqual({
      day: "2028-02-29",
      time: "15:00",
    });
    const leap: NaturalDateAnchor = { today: "2028-02-01", time: "10:00" };
    expect(parseNaturalDate("February 29 at 3 PM", leap)).toEqual({
      day: "2028-02-29",
      time: "15:00",
    });
  });
});

describe("times", () => {
  it("handles minutes, noon, midnight and 12 AM/PM", () => {
    expect(parseNaturalDate("tomorrow at 5:30 PM", MONDAY)).toEqual({
      day: "2026-11-03",
      time: "17:30",
    });
    expect(parseNaturalDate("tomorrow at noon", MONDAY)).toEqual({
      day: "2026-11-03",
      time: "12:00",
    });
    expect(parseNaturalDate("tomorrow at midnight", MONDAY)).toEqual({
      day: "2026-11-03",
      time: "00:00",
    });
    expect(parseNaturalDate("tomorrow at 12 AM", MONDAY)).toEqual({
      day: "2026-11-03",
      time: "00:00",
    });
    expect(parseNaturalDate("tomorrow at 12 PM", MONDAY)).toEqual({
      day: "2026-11-03",
      time: "12:00",
    });
  });
  it("reads 24h times with minutes", () => {
    expect(parseNaturalDate("tomorrow at 17:30", MONDAY)).toEqual({
      day: "2026-11-03",
      time: "17:30",
    });
  });
  it("a bare word hour defaults to PM like a bare digit", () => {
    expect(parseNaturalDate("tomorrow at three", MONDAY)).toEqual({
      day: "2026-11-03",
      time: "15:00",
    });
  });
  it("a lone time books today", () => {
    expect(parseNaturalDate("at 5 PM", MONDAY)).toEqual({
      day: "2026-11-02",
      time: "17:00",
    });
  });
  it("a lone date keeps the anchor time", () => {
    expect(parseNaturalDate("next Friday", MONDAY)).toEqual({
      day: "2026-11-13",
      time: "15:00",
    });
  });
});

describe("invalid input", () => {
  it("rejects empty and dateless noise", () => {
    expect(parseNaturalDate("", MONDAY)).toBeNull();
    expect(parseNaturalDate("   ", MONDAY)).toBeNull();
    expect(parseNaturalDate("blah blah", MONDAY)).toBeNull();
    expect(parseNaturalDate("gel removal", MONDAY)).toBeNull();
  });
  it("rejects days that do not exist", () => {
    expect(parseNaturalDate("February 30 at 5 PM", MONDAY)).toBeNull();
    expect(parseNaturalDate("April 31 at 5 PM", MONDAY)).toBeNull();
    expect(parseNaturalDate("November 31 at 5 PM", MONDAY)).toBeNull();
    expect(parseNaturalDate("Friday the 32nd at 5 PM", MONDAY)).toBeNull();
  });
  it("rejects a weekday that misses the month-day", () => {
    // November 13th 2026 is a Friday, not a Monday.
    expect(parseNaturalDate("Monday the 13th at 5 PM", MONDAY)).toBeNull();
  });
  it("rejects impossible times", () => {
    expect(parseNaturalDate("tomorrow at 13 PM", MONDAY)).toBeNull();
    expect(parseNaturalDate("tomorrow at 5:99", MONDAY)).toBeNull();
    expect(parseNaturalDate("tomorrow at 25", MONDAY)).toBeNull();
  });
  it("rejects a broken anchor instead of guessing", () => {
    expect(parseNaturalDate("tomorrow at 5 PM", { today: "not-a-date", time: "15:00" })).toBeNull();
    expect(parseNaturalDate("tomorrow at 5 PM", { today: "2026-11-02", time: "3pm" })).toBeNull();
  });
  it("is deterministic: the same input always parses the same way", () => {
    const first = parseNaturalDate("next Friday at 5 PM", MONDAY);
    const second = parseNaturalDate("next Friday at 5 PM", MONDAY);
    expect(second).toEqual(first);
  });
});

describe("bogotaDay", () => {
  it("stays on the Bogota date past UTC midnight", () => {
    // 02:00 UTC is still 21:00 the day before in Bogota (UTC-5, no DST).
    expect(bogotaDay(new Date("2026-11-02T02:00:00Z"))).toBe("2026-11-01");
    expect(bogotaDay(new Date("2026-11-02T12:00:00Z"))).toBe("2026-11-02");
  });
});

describe("bogotaTime and natural sheets (trial 9.7)", () => {
  it("reads the current Bogota time, not the server clock", () => {
    expect(bogotaTime(new Date("2026-11-02T04:30:00.000Z"))).toBe("23:30");
    expect(bogotaTime(new Date("2026-11-02T12:00:00.000Z"))).toBe("07:00");
  });

  it("says sheet dates in words, never ISO", () => {
    expect(formatNaturalDateTime("2026-11-13", "17:00")).toBe("Friday the 13th at 5 PM");
    expect(formatNaturalDateTime("2026-11-13", "09:05")).toBe("Friday the 13th at 9:05 AM");
    expect(formatNaturalDateTime("2026-11-02", "12:00")).toBe("Monday the 2nd at 12 PM");
  });

  it("reads whole hours without minutes", () => {
    expect(hour12("00:00")).toBe("12 AM");
    expect(hour12("12:00")).toBe("12 PM");
    expect(hour12("15:00")).toBe("3 PM");
    expect(hour12("09:30")).toBe("9:30 AM");
  });
});
