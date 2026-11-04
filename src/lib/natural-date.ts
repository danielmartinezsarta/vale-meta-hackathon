/**
 * Natural EN date/time parsing on the America/Bogota calendar (HACK-018 req 7).
 *
 * Pure: the clock is injected through the anchor, never read here. The
 * server resolves "next Friday at 5 PM" with the local date so the model
 * never invents one; Vale still says the date back in natural words,
 * never in ISO.
 *
 * Clock agreement: `bogotaDay` uses the same Intl en-CA America/Bogota
 * formatting as `bogotaParts` in agent.ts, so the anchor day matches the
 * session facts. (vale-tools `localDay`/`localTime` read the server-local
 * clock instead; pass the Bogota day explicitly to stay on one clock.)
 */

export interface NaturalDateAnchor {
  /** Today on the America/Bogota calendar (YYYY-MM-DD). */
  today: string;
  /**
   * Current Bogota time (HH:MM). Fills "same time" and any phrase with
   * no explicit time, so a date correction keeps the original time.
   */
  time: string;
}

export interface NaturalDate {
  /** Calendar day (YYYY-MM-DD). */
  day: string;
  /** Time of day (HH:MM, 24h). */
  time: string;
}

import type { ValeLanguage } from "./vale-language";

/** Today on the America/Bogota calendar for `when`. Same clock as bogotaParts. */
export function bogotaDay(when: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

/** Current time on the America/Bogota clock for `when` (HH:MM, 24h). */
export function bogotaTime(when: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(when);
}

const ORDINALS: Record<number, string> = {
  1: "1st",
  2: "2nd",
  3: "3rd",
};

/** "13" -> "13th": the day words Vale says on screen and aloud. */
function ordinal(day: number): string {
  return ORDINALS[day] ?? `${day}th`;
}

/** "17:00" -> "5 PM": the hour words Vale says and shows. */
export function hour12(time: string): string {
  const [rawHour, minute] = time.split(":");
  const hour = Number(rawHour);
  if (!Number.isInteger(hour) || minute === undefined) return time;
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return minute === "00" ? `${twelve} ${suffix}` : `${twelve}:${minute} ${suffix}`;
}

/**
 * Natural words for a Bogota day + time, for sheets and speech.
 * "2026-11-13" + "17:00" becomes "Friday the 13th at 5 PM", or with
 * "es" (the voice language), "el viernes 13 a las 5 PM".
 * Never ISO: sheets and Vale both show this, never the raw stamps.
 */
export function formatNaturalDateTime(day: string, time: string, language: ValeLanguage = "en"): string {
  const parsed = parseYmd(day);
  if (parsed === null || !isCalendarDay(parsed) || !TIME_RE.test(time)) {
    return `${day} ${time}`;
  }
  const noon = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12));
  if (language === "es") {
    const weekday = new Intl.DateTimeFormat("es", {
      timeZone: "America/Bogota",
      weekday: "long",
    }).format(noon);
    return `el ${weekday} ${parsed.day} a las ${hour12(time)}`;
  }
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    weekday: "long",
  }).format(noon);
  return `${weekday} the ${ordinal(parsed.day)} at ${hour12(time)}`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const WEEKDAY_RE =
  /\b(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\b/;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

function weekdayIndex(token: string): number {
  const short = token.slice(0, 3);
  const full: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  return full[short] ?? -1;
}

/** 1-based month for Ymd; -1 when the token names no month. */
function monthIndex(token: string): number {
  const short = token.slice(0, 3);
  const found = MONTHS.findIndex((name) => name.slice(0, 3) === short);
  return found === -1 ? -1 : found + 1;
}

interface Ymd {
  year: number;
  month: number;
  day: number;
}

function parseYmd(text: string): Ymd | null {
  const parts = text.split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  const [year, month, day] = parts;
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isCalendarDay(value: Ymd): boolean {
  if (value.month < 1 || value.month > 12 || value.day < 1) return false;
  return value.day <= daysInMonth(value.year, value.month);
}

function formatYmd(value: Ymd): string {
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${value.year}-${pad(value.month)}-${pad(value.day)}`;
}

/** Noon-UTC arithmetic: Bogota never observes DST, so the date is stable. */
function addDays(value: Ymd, delta: number): Ymd {
  const base = new Date(Date.UTC(value.year, value.month - 1, value.day, 12));
  const next = new Date(base.getTime() + delta * 86_400_000);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function weekdayOf(value: Ymd): number {
  return new Date(Date.UTC(value.year, value.month - 1, value.day, 12)).getUTCDay();
}

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/(\d)\.(\d{2})/g, "$1:$2")
    .replace(/[.,]/g, "")
    .replace(/\bo\s?clock\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface FoundTime {
  time: string;
  rest: string;
}

function to24h(hour: number, minute: number, meridiem: string | null): string | null {
  if (minute > 59) return null;
  if (meridiem === null) {
    // Bare salon hour ("Friday the 13th at 4"): afternoons win, so 1-11
    // mean PM and 12 means noon; 13-23 already ride 24h. Anything else is
    // not a time.
    if (hour >= 1 && hour <= 11) return `${hour + 12}:${String(minute).padStart(2, "0")}`;
    if (hour === 12) return `12:${String(minute).padStart(2, "0")}`;
    if (hour >= 13 && hour <= 23 && minute >= 0) {
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    return null;
  }
  if (hour < 1 || hour > 12) return null;
  if (meridiem === "am") return `${String(hour % 12).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return `${String(hour % 12 + 12).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Pull the time out of the phrase; the date pass owns what is left. */
function extractTime(text: string): FoundTime | null {
  const wordList = Object.keys(WORD_NUMBERS).join("|");
  const patterns = [
    // "at 5:30 PM", "5pm", "at three PM".
    new RegExp(`\\b(\\d{1,2}):(\\d{2})\\s*(am|pm)\\b`),
    new RegExp(`\\b(${wordList}|\\d{1,2})\\s*(am|pm)\\b`),
    // 24h with minutes: "at 17:30".
    /\bat\s+(\d{1,2}):(\d{2})\b/,
    // Bare salon hour: "at 4", "at three".
    new RegExp(`\\bat\\s+(${wordList}|\\d{1,2})\\b`),
    /\b(noon|midnight)\b/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (match[1] === "noon" || match[0] === "noon" || match[1] === "midnight") {
      const word = match[1] ?? match[0];
      return {
        time: word === "noon" ? "12:00" : "00:00",
        rest: text.replace(match[0], " "),
      };
    }
    const rawHour = match[1];
    const hour = /^\d+$/.test(rawHour) ? Number(rawHour) : WORD_NUMBERS[rawHour];
    const minute = match[2] !== undefined && /^\d+$/.test(match[2]) ? Number(match[2]) : 0;
    const meridiem: string | null =
      match[3] === "am" || match[3] === "pm"
        ? match[3]
        : match[2] === "am" || match[2] === "pm"
          ? match[2]
          : null;
    const time = to24h(hour, minute, meridiem);
    if (time === null) return null;
    return { time, rest: text.replace(match[0], " ") };
  }
  return null;
}

/**
 * Parse EN natural dates into a Bogota calendar day plus a 24h time.
 * Returns null when the phrase names no date or names an impossible one
 * (February 30th, a weekday that misses the month-day, a 13 PM).
 *
 * Weekday rule: a bare or "this" weekday is the coming one, today
 * included ("Friday" said Friday is today); "next" always jumps a full
 * week further ("next Friday" said Friday is seven days out). A missing
 * date means today, a missing time means the anchor time.
 */
export function parseNaturalDate(
  input: string,
  anchor: NaturalDateAnchor,
): NaturalDate | null {
  const today = parseYmd(anchor.today);
  if (today === null || !isCalendarDay(today)) return null;
  if (!TIME_RE.test(anchor.time)) return null;

  const text = normalize(input);
  if (text === "") return null;

  const found = extractTime(text);
  if (found === null) {
    // A time was attempted but impossible ("13 PM", "at 5:99"), or a
    // dangling "at <hour>" stayed behind: reject instead of guessing.
    if (/(am|pm)\b/.test(text)) return null;
    const words = Object.keys(WORD_NUMBERS).join("|");
    if (/\d:\d/.test(text)) return null;
    if (new RegExp(`\\bat\\s+(${words}|\\d+)\\b`).test(text)) return null;
  }
  const time = found?.time ?? anchor.time;
  const rest = found ? found.rest : text;

  const day = extractDay(rest, today);
  if (day === null) {
    // A lone time ("at 5 PM") still books today. But date words that
    // resolve to nothing ("February 30th", a weekday missing its
    // month-day) are impossible dates, never a silent today.
    if (found === null || hasDateSignal(rest)) return null;
    return { day: formatYmd(today), time };
  }
  return { day: formatYmd(day), time };
}

/**
 * The phrase carries date words even though none resolved: an impossible
 * date, not an empty one. "may" stays out of the month list on purpose:
 * it is usually the verb, and a bare "may" never parses as a date anyway
 * (month-day needs a day number beside it).
 */
function hasDateSignal(text: string): boolean {
  const names = MONTHS.filter((name) => name !== "may").join("|");
  const words = Object.keys(WORD_NUMBERS).join("|");
  return (
    WEEKDAY_RE.test(text) ||
    new RegExp(`\\b(${names})\\b`).test(text) ||
    /\btomorrow\b/.test(text) ||
    /\btoday\b/.test(text) ||
    /\bthe\s+\d{1,2}(?:st|nd|rd|th)?\b/.test(text) ||
    new RegExp(`\\bin\\s+(a|an|${words}|\\d+)\\s+(day|week)s?\\b`).test(text)
  );
}

function extractDay(text: string, today: Ymd): Ymd | null {
  const weekdayTheOrdinal =
    /(\b(?:sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\b)\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(
      text,
    );
  if (weekdayTheOrdinal) {
    const target = Number(weekdayTheOrdinal[2]);
    const day = nextMonthDay(today, target);
    if (day === null) return null;
    return weekdayOf(day) === weekdayIndex(weekdayTheOrdinal[1]) ? day : null;
  }

  const monthDay = monthDayMatch(text);
  if (monthDay) {
    const day = nextMonthDayInMonth(today, monthDay.month, monthDay.day);
    if (day === null) return null;
    // "Friday, November 13th": a named weekday next to a month-day is a
    // constraint, not decoration; a miss means an impossible date.
    const stray = WEEKDAY_RE.exec(text);
    if (stray && weekdayOf(day) !== weekdayIndex(stray[1])) return null;
    return day;
  }

  const bareOrdinal = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (bareOrdinal) return nextMonthDay(today, Number(bareOrdinal[1]));

  const relative = relativeMatch(text);
  if (relative) return addDays(today, relative);

  const weekday = /(this|next)?\s*\b(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)\b/.exec(
    text,
  );
  if (weekday) {
    const target = weekdayIndex(weekday[2]);
    const ahead = (target - weekdayOf(today) + 7) % 7;
    if (weekday[1] === "next") return addDays(today, ahead === 0 ? 7 : ahead + 7);
    return addDays(today, ahead);
  }

  if (/\bday\s+after\s+tomorrow\b/.test(text)) return addDays(today, 2);
  if (/\btomorrow\b/.test(text)) return addDays(today, 1);
  if (/\btoday\b/.test(text)) return today;
  return null;
}

function monthDayMatch(text: string): { month: number; day: number } | null {
  const names = MONTHS.join("|");
  const after = new RegExp(`\\b(${names})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(text);
  if (after) return { month: monthIndex(after[1]), day: Number(after[2]) };
  const before = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+(${names})\\b`,
  ).exec(text);
  if (before) return { month: monthIndex(before[2]), day: Number(before[1]) };
  const plain = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${names})\\b`).exec(text);
  if (plain) return { month: monthIndex(plain[2]), day: Number(plain[1]) };
  return null;
}

/** Next month-day on or after today (this month, else next month). */
function nextMonthDay(today: Ymd, day: number): Ymd | null {
  if (day < 1 || day > 31) return null;
  if (day >= today.day && day <= daysInMonth(today.year, today.month)) {
    return { ...today, day };
  }
  let year = today.year;
  let month = today.month + 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  if (day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** Next month-day in a named month: this year when still ahead, else next. */
function nextMonthDayInMonth(
  today: Ymd,
  month: number,
  day: number,
): Ymd | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const thisYear = daysInMonth(today.year, month);
  if (day > thisYear) {
    // February 29th on a common year falls through to the next leap year.
    for (let year = today.year + 1; year <= today.year + 8; year += 1) {
      if (day <= daysInMonth(year, month)) return { year, month, day };
    }
    return null;
  }
  if (month > today.month || (month === today.month && day >= today.day)) {
    return { year: today.year, month, day };
  }
  if (day > daysInMonth(today.year + 1, month)) return null;
  return { year: today.year + 1, month, day };
}

function relativeMatch(text: string): number | null {
  const wordList = Object.keys(WORD_NUMBERS).join("|");
  const match = new RegExp(
    `\\bin\\s+(a|an|${wordList}|\\d+)\\s+(day|week)s?\\b`,
  ).exec(text);
  if (!match) return null;
  const count =
    match[1] === "a" || match[1] === "an"
      ? 1
      : /^\d+$/.test(match[1])
        ? Number(match[1])
        : WORD_NUMBERS[match[1]];
  if (!Number.isInteger(count) || count < 0 || count > 52) return null;
  return match[2] === "week" ? count * 7 : count;
}
