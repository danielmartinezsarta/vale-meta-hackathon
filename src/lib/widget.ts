/**
 * Screen cards from Ali's demo design (snapshot 2026-11-02_1241). One
 * typed payload per kind; HACK-018's tools fill them. Sizes are fixed per
 * kind: "half" rises to mid-screen with Vale visible behind, "full"
 * covers the screen. Auto-hide and timed chains live in the UI layer.
 */

export type WidgetSize = "half" | "full";

/** Booked and note sheets confirm, then hide by themselves. */
export const AUTO_HIDE_MS = 3000;
/** The summary reads 5 s before the good job takes over. */
export const SUMMARY_MS = 5000;
/** Good job shows 5 s, then Vale is awake again. */
export const GOODBYE_MS = 5000;

export type WidgetKind =
  | "client_card"
  | "goal"
  | "camera_save_as"
  | "photos"
  | "health_note"
  | "note"
  | "price"
  | "final_photo_confirm"
  | "final_result"
  | "booked"
  | "session_summary"
  | "good_job"
  | "confirm";

/** Fixed sheet size per kind; good_job is a screen state, never a sheet. */
export const WIDGET_SIZE: Record<WidgetKind, WidgetSize> = {
  client_card: "full",
  goal: "half",
  camera_save_as: "half",
  photos: "full",
  health_note: "half",
  note: "half",
  price: "half",
  final_photo_confirm: "full",
  final_result: "full",
  booked: "half",
  session_summary: "full",
  good_job: "full",
  confirm: "half",
};

/** Sheet titles, always English. The confirm title names its proposal. */
export function widgetTitle(kind: WidgetKind): string {
  switch (kind) {
    case "client_card":
      return "Client card";
    case "goal":
      return "Monthly goal";
    case "camera_save_as":
      return "Save photo as";
    case "photos":
      return "Photos";
    case "health_note":
      return "Health note";
    case "note":
      return "Note saved";
    case "price":
      return "Price";
    case "final_photo_confirm":
      return "Final photo";
    case "final_result":
      return "Final result";
    case "booked":
      return "Appointment booked";
    case "session_summary":
      return "Session summary";
    case "good_job":
      return "Good job!";
    case "confirm":
      return "Confirm";
  }
}

/** A past visit on the client card; ISO date, display formatted in the UI. */
export interface ClientVisit {
  date: string;
  service: string;
}

/** Ali's client card: health first, then notes, then visits. */
export interface ClientCardData {
  name: string;
  birthday: string | null;
  sex: "Female" | "Male" | "Not defined" | null;
  phone: string | null;
  email: string | null;
  visits: ClientVisit[];
  /** Older visits behind the "+ N earlier visits" line. */
  visitsMore: number;
  healthNotes: string[];
  noteTags: string[];
}

/** Monthly goal: the bar counts to pct, the chip to earned. */
export interface GoalData {
  name: string | null;
  goal: number;
  earned: number;
}

/** Camera choice sheet; the choice itself is UI state, not payload. */
export type CameraSaveAsData = Record<string, never>;

/** Photo slots; null renders Ali's hand placeholder. */
export interface PhotosData {
  before: string | null;
  reference: string | null;
  expected: string | null;
}

/** Health note: one line plus client, lock on, never spoken. */
export interface HealthNoteData {
  text: string;
  client: string;
}

/** Regular note: one line plus client, confirmed on screen. */
export interface NoteData {
  text: string;
  client: string;
}

/** Quoted price: service and suggested always, extras when priced. */
export interface PriceData {
  service: string;
  extras: number | null;
  suggested: number;
}

/** Final photo confirmation; null photo renders the placeholder. */
export interface FinalPhotoConfirmData {
  photo: string | null;
}

/** Finished job: Muse Spark's description under the final photo. */
export interface FinalResultData {
  photo: string | null;
  description: string | null;
}

/** Booked appointment; day is ISO, rendered longhand in the UI. */
export interface BookedData {
  client: string;
  service: string;
  day: string;
  time: string;
}

/** Session summary; null blocks hide, HACK-018 fills the rest. */
export interface SessionSummaryData {
  client: string | null;
  date: string | null;
  service: { name: string; price: number } | null;
  extras: { label: string; amount: number }[];
  suggested: number | null;
  charged: number | null;
  timeTotal: string | null;
  timeParts: { label: string; time: string }[];
  costs: { label: string; amount: number }[];
  fixedDetail: string | null;
}

/** Good-job screen state after the summary; no payload. */
export type GoodJobData = Record<string, never>;

/** Touch fallback for proposals with no widget of their own. */
export type ConfirmData = Record<string, never>;

export type Widget =
  | { kind: "client_card"; title: string; size: "full"; data: ClientCardData }
  | { kind: "goal"; title: string; size: "half"; data: GoalData }
  | { kind: "camera_save_as"; title: string; size: "half"; data: CameraSaveAsData }
  | { kind: "photos"; title: string; size: "full"; data: PhotosData }
  | { kind: "health_note"; title: string; size: "half"; data: HealthNoteData }
  | { kind: "note"; title: string; size: "half"; data: NoteData }
  | { kind: "price"; title: string; size: "half"; data: PriceData }
  | { kind: "final_photo_confirm"; title: string; size: "full"; data: FinalPhotoConfirmData }
  | { kind: "final_result"; title: string; size: "full"; data: FinalResultData }
  | { kind: "booked"; title: string; size: "half"; data: BookedData }
  | { kind: "session_summary"; title: string; size: "full"; data: SessionSummaryData }
  | { kind: "good_job"; title: string; size: "full"; data: GoodJobData }
  | { kind: "confirm"; title: string; size: "half"; data: ConfirmData };

/** Read-only store for card and summary enrichment; columns may be absent. */
export interface CardStore {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dataOf(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return {};
}

/** Whole dollars, Ali's style ($28, $2,000). */
export function usdWhole(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** "2026-11-27" renders "Friday, November 27" (UTC, no local shift). */
export function formatDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** "2026-10-12" or ISO renders "Oct 12, 2026" (UTC, no local shift). */
export function formatVisit(when: string): string {
  const date = new Date(when.includes("T") ? when : `${when}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return when;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** 72 minutes renders "1h 12m", 6 renders "6m". */
export function formatMinutes(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return `${whole}m`;
  return `${Math.floor(whole / 60)}h ${whole % 60}m`;
}

/** "David" renders "D". */
export function initials(name: string): string {
  return name
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** Contact columns are demo-local until HACK-018 owns the schema. */
function contactOf(
  db: CardStore | undefined,
  id: number,
): { birthday: string | null; sex: ClientCardData["sex"]; phone: string | null; email: string | null } {
  const empty = { birthday: null, sex: null, phone: null, email: null } as const;
  if (!db) return empty;
  try {
    const row = db.prepare("SELECT birthday, sex, phone, email FROM clients WHERE id = ?").get(id) as {
      birthday?: unknown;
      sex?: unknown;
      phone?: unknown;
      email?: unknown;
    } | null;
    if (!row) return empty;
    const sex = text(row.sex);
    return {
      birthday: text(row.birthday) === "" ? null : text(row.birthday),
      sex: sex === "Female" || sex === "Male" || sex === "Not defined" ? sex : null,
      phone: text(row.phone) === "" ? null : text(row.phone),
      email: text(row.email) === "" ? null : text(row.email),
    };
  } catch {
    return empty;
  }
}

/** Health text is screen-only: the tool feed stays masked for the model. */
function healthNotesOf(db: CardStore | undefined, id: number): string[] {
  if (!db) return [];
  try {
    const rows = db
      .prepare("SELECT text FROM notes WHERE client_id = ? AND kind = 'health' ORDER BY id")
      .all(id) as { text?: unknown }[];
    return rows.map((row) => text(row.text)).filter((line) => line !== "");
  } catch {
    return [];
  }
}

/** Latest visits first; the card shows three and counts the rest. */
function visitsOf(
  db: CardStore | undefined,
  id: number,
): { visits: ClientVisit[]; visitsMore: number } {
  if (!db) return { visits: [], visitsMore: 0 };
  try {
    const rows = db.prepare(
      "SELECT s.started_at AS started, v.name AS service FROM sessions s JOIN services v ON v.id = s.service_id WHERE s.client_id = ? AND s.ended_at IS NOT NULL ORDER BY s.started_at DESC",
    ).all(id) as { started?: unknown; service?: unknown }[];
    const visits = rows
      .map((row) => ({ date: text(row.started).slice(0, 10), service: text(row.service) }))
      .filter((visit) => visit.date !== "" && visit.service !== "");
    return { visits: visits.slice(0, 3), visitsMore: Math.max(0, visits.length - 3) };
  } catch {
    return { visits: [], visitsMore: 0 };
  }
}

/** Latest closed session: who, what, when, how long (demo heuristic). */
function lastSessionOf(
  db: CardStore | undefined,
): { client: string | null; service: string | null; date: string | null; minutes: number | null } {
  const empty = { client: null, service: null, date: null, minutes: null } as const;
  if (!db) return empty;
  try {
    const row = db.prepare(
      "SELECT c.name AS client, v.name AS service, s.ended_at AS ended, s.duration_s AS duration FROM sessions s JOIN clients c ON c.id = s.client_id JOIN services v ON v.id = s.service_id WHERE s.ended_at IS NOT NULL ORDER BY s.ended_at DESC LIMIT 1",
    ).get() as { client?: unknown; service?: unknown; ended?: unknown; duration?: unknown } | null;
    if (!row || text(row.client) === "") return empty;
    const seconds = num(row.duration);
    return {
      client: text(row.client),
      service: text(row.service) === "" ? null : text(row.service),
      date: formatVisit(text(row.ended)),
      minutes: seconds === null ? null : Math.max(1, Math.round(seconds / 60)),
    };
  } catch {
    return empty;
  }
}

function buildCard(
  info: Record<string, unknown>,
  args: Record<string, unknown>,
  db: CardStore | undefined,
): Widget | null {
  const id = num(info.id);
  const name = text(info.name) === "" ? text(args.client_name) : text(info.name);
  if (name === "") return null;
  const notes = Array.isArray(info.notes) ? info.notes : [];
  const strings = (kind: string): string[] =>
    notes
      .map((note) => (dataOf(note).kind === kind ? dataOf(note).text : null))
      .filter((line): line is string => typeof line === "string" && line !== "");
  const contact = id === null ? null : contactOf(db, id);
  const history = id === null ? { visits: [], visitsMore: 0 } : visitsOf(db, id);
  const health =
    id === null
      ? strings("health")
      : [...healthNotesOf(db, id), ...strings("health")].filter(
          (line, index, lines) => lines.indexOf(line) === index,
        );
  return {
    kind: "client_card",
    title: widgetTitle("client_card"),
    size: "full",
    data: {
      name,
      birthday: contact?.birthday ?? null,
      sex: contact?.sex ?? null,
      phone: contact?.phone ?? null,
      email: contact?.email ?? null,
      visits: history.visits,
      visitsMore: history.visitsMore,
      healthNotes: health,
      noteTags: strings("general"),
    },
  };
}

function buildSummary(
  info: Record<string, unknown>,
  db: CardStore | undefined,
): Widget {
  const seconds = num(info.duration_s);
  const last = lastSessionOf(db);
  return {
    kind: "session_summary",
    title: widgetTitle("session_summary"),
    size: "full",
    data: {
      client: last.client,
      date: last.date,
      service: last.service === null ? null : { name: last.service, price: 0 },
      extras: [],
      suggested: null,
      charged: null,
      timeTotal: seconds === null ? null : formatMinutes(seconds / 60),
      timeParts: [],
      costs: [],
      fixedDetail: null,
    },
  };
}

/**
 * Screen card for a successful tool call, never from reply text. Money,
 * health and goal amounts stay in the payload; the voice never says them.
 * HACK-018 fills service extras, summary money and card contact/visits;
 * until then null blocks hide and the demo store fills what it can.
 */
export function buildWidget(
  tool: string,
  args: Record<string, unknown>,
  data: unknown,
  db?: CardStore,
): Widget | null {
  const info = dataOf(data);
  switch (tool) {
    case "goal_progress": {
      const earned = num(info.earned_usd);
      const goal = num(info.goal_usd);
      if (earned === null || goal === null) return null;
      return {
        kind: "goal",
        title: widgetTitle("goal"),
        size: "half",
        data: { name: null, goal, earned },
      };
    }
    case "find_client":
      return buildCard(info, args, db);
    case "add_note": {
      const client = text(args.client_name);
      const note = text(args.text);
      if (client === "" || note === "") return null;
      if (args.kind === "health") {
        return {
          kind: "health_note",
          title: widgetTitle("health_note"),
          size: "half",
          data: { text: note, client },
        };
      }
      return {
        kind: "note",
        title: widgetTitle("note"),
        size: "half",
        data: { text: note, client },
      };
    }
    case "quote_price": {
      const service = text(info.service);
      const suggested = num(info.final_price_usd);
      if (service === "" || suggested === null) return null;
      return {
        kind: "price",
        title: widgetTitle("price"),
        size: "half",
        data: { service, extras: null, suggested },
      };
    }
    case "create_appointment":
    case "move_appointment": {
      const client = text(args.client_name);
      const service = text(args.service_name);
      const day = text(args.day);
      const time = text(args.time);
      if (client === "" || service === "" || day === "" || time === "") return null;
      return {
        kind: "booked",
        title: widgetTitle("booked"),
        size: "half",
        data: { client, service, day, time },
      };
    }
    case "close_session":
      return buildSummary(info, db);
    default:
      return null;
  }
}
