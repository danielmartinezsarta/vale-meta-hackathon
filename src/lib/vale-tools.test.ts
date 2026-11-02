// @vitest-environment node
import { describe, expect, it } from "vitest";
import { freshTestDb } from "./db";
import { PRICING } from "./db";
import { quotePrice } from "./quote";
import seedData from "./seed-data.json";
import { bogotaDay } from "./natural-date";
import { buildPendingActions } from "./pending-action";
import {
  VALE_TOOLS,
  acceptQuote,
  addNote,
  addStock,
  addToShoppingList,
  cancelAppointment,
  closeSession,
  createAppointment,
  createClient,
  createReminder,
  findClient,
  getToolDetails,
  goalProgress,
  isQuoteAwaiting,
  listToday,
  localDay,
  localTime,
  logSupplyUse,
  matchAliased,
  matchOne,
  moveAppointment,
  nextAppointment,
  offHoursReasons,
  openSession,
  quoteSession,
  readShoppingList,
  readStock,
  rejectQuote,
  removeFromShoppingList,
  runValeTool,
  setStock,
  showAgenda,
  showClientCard,
  showService,
  showWidget,
  undoLastWrite,
} from "./vale-tools";

function openAna(db: ReturnType<typeof freshTestDb>) {
  const opened = openSession(db, { client_name: "Ana", service_name: "Retiro de gel" });
  expect(opened.ok).toBe(true);
}

describe("tool definitions", () => {
  it("exposes the demo path plus support tools, nothing else", () => {
    const names = VALE_TOOLS.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "agenda_create_appointment",
        "agenda_show",
        "client_card_show",
        "client_create",
        "client_note_add",
        "goal_show",
        "session_close",
        "session_log_supply",
        "session_open",
        "session_quote",
        "stock_set",
        "tool_get_details",
        "undo_last",
        "widget_show",
      ].sort(),
    );
    for (const tool of VALE_TOOLS) expect(tool.type).toBe("function");
  });

  it("routes delete-note phrases to undo_last", () => {
    const undo = VALE_TOOLS.find((tool) => tool.name === "undo_last")!;
    for (const phrase of ["delete that note", "remove that note", "borra esa nota", "elimina la nota"]) {
      expect(undo.description).toContain(phrase);
    }
  });

  it("keeps booking and card lookups internal-only", () => {
    const names = VALE_TOOLS.map((tool) => tool.name);
    for (const internal of [
      "agenda_move_appointment",
      "agenda_cancel_appointment",
      "agenda_get_next",
      "agenda_create_reminder",
      "shopping_add",
      "shopping_show",
      "shopping_remove",
      "service_show",
      "stock_show_low",
      "stock_add",
      "session_quote_accept",
    ]) {
      expect(names).not.toContain(internal);
    }
  });
});

describe("sessions", () => {
  it("opens and closes a session with duration and products", () => {
    const db = freshTestDb();
    const opened = openSession(db, { client_name: "ana", service_name: "retiro" });
    expect(opened.ok).toBe(true);
    expect(opened.message).toContain("Ana");
    const closed = closeSession(db, { products_used: ["Acetona", "Algodon"] });
    expect(closed.ok).toBe(true);
    expect(closed.message).toMatch(/Duró \d+ minutos/);
    const row = db.prepare("SELECT ended_at, duration_s FROM sessions").get() as {
      ended_at: string;
      duration_s: number;
    };
    expect(row.ended_at).toBeTruthy();
    expect(row.duration_s).toBeGreaterThanOrEqual(0);
    const links = db.prepare("SELECT COUNT(*) AS n FROM session_supplies").get() as { n: number };
    expect(links.n).toBe(2);
    db.close();
  });

  it("rejects a second open session and a close without one", () => {
    const db = freshTestDb();
    openAna(db);
    expect(openSession(db, { client_name: "Sofia", service_name: "Manicura" }).ok).toBe(false);
    closeSession(db, {});
    expect(closeSession(db, {}).ok).toBe(false);
    expect(closeSession(db, {}).message).toBe("No hay sesión abierta.");
    db.close();
  });
  it("names the open session and the next step instead of reopening", () => {
    const db = freshTestDb();
    openAna(db);
    const refused = openSession(
      db,
      { client_name: "Sofia", service_name: "Manicura" },
      "en",
    );
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("already an open session");
    expect(refused.message).toContain("Ana");
    expect(refused.message).toContain("Do not call session_close yet");
    db.close();
  });


  it("reports unknown clients and services without inventing", () => {
    const db = freshTestDb();
    expect(openSession(db, { client_name: "Nadie", service_name: "Retiro" }).message).toContain("No encuentro");
    expect(openSession(db, { client_name: "Ana", service_name: "Cohetes" }).message).toContain("No encuentro");
    db.close();
  });
});

describe("session_open with only a client (9.5)", () => {
  it("resolves the service from today's appointment", () => {
    const db = freshTestDb();
    // "Start a session with David", "David is here",
    // "my client David is getting near": the client alone is enough.
    const opened = openSession(db, { client_name: "David" });
    expect(opened.ok).toBe(true);
    expect(opened.message).toContain("David");
    const session = db
      .prepare(
        `SELECT s.name AS service FROM sessions
         JOIN services s ON s.id = sessions.service_id
         WHERE ended_at IS NULL`,
      )
      .get() as { service: string };
    expect(session.service).toBe("Semi-permanent manicure");
    db.close();
  });

  it("asks for the service when nothing is booked today", () => {
    const db = freshTestDb();
    createClient(db, { name: "Vera" });
    const asked = openSession(db, { client_name: "Vera" }, "en");
    expect(asked.ok).toBe(false);
    expect(asked.message).toContain("Which service for Vera?");
    db.close();
  });
});

describe("find_client", () => {
  it("finds by approximate name and asks when ambiguous", () => {
    const db = freshTestDb();
    const found = findClient(db, { name: "ana" });
    expect(found.ok).toBe(true);
    expect(found.card?.name).toBe("Ana");
    expect(findClient(db, { name: "nadie" }).ok).toBe(false);
    db.close();
  });
});

describe("client_card_show (1.1)", () => {
  it("opens the full sheet without speaking health", () => {
    const db = freshTestDb();
    const card = showClientCard(db, { name: "David" }, "en");
    expect(card.ok).toBe(true);
    const data = card.data as {
      card: {
        name: string;
        phone: string;
        health_alert: boolean;
        visits: { service: string; photo: string }[];
        upcoming: { service: string; day: string; time: string }[];
      };
    };
    expect(data.card.name).toBe("David");
    expect(data.card.phone).toBe("+1-555-0101");
    expect(data.card.health_alert).toBe(true);
    expect(data.card.upcoming[0].service).toBe("Semi-permanent manicure");
    expect(data.card.visits[0].photo).toContain("demo-visit-david");
    // The alert rides the screen only: nothing health-related is spoken.
    expect(JSON.stringify(card)).not.toContain("latex");
    expect(card.message).not.toContain("latex");
    expect(card.message).not.toContain("allergy");
    db.close();
  });

  it("lists health notes first on the card", () => {
    const db = freshTestDb();
    runValeTool(db, "client_note_add", { client_name: "David", text: "Likes neon colors", kind: "note" });
    const card = showClientCard(db, { name: "David" }, "en");
    const kinds = (card.data as { card: { notes: { kind: string }[] } }).card.notes.map((note) => note.kind);
    expect(kinds[0]).toBe("health_note");
    expect(kinds).toContain("note");
    db.close();
  });
});

describe("add_note", () => {
  it("saves notes and private health notes", () => {
    const db = freshTestDb();
    const general = addNote(db, { client_name: "Ana", text: "prefiere viernes", kind: "note" });
    expect(general.ok).toBe(true);
    const health = addNote(db, { client_name: "Ana", text: "onicolisis pulgar", kind: "health_note" });
    expect(health.ok).toBe(true);
    expect(health.message).toBe("Nota privada guardada.");
    const anaId = (db.prepare("SELECT id FROM clients WHERE name = ?").get("Ana") as { id: number }).id;
    const stored = db
      .prepare("SELECT kind, private_for_glimmer FROM notes WHERE client_id = ? ORDER BY id")
      .all(anaId) as {
      kind: string;
      private_for_glimmer: number;
    }[];
    expect(stored).toEqual([
      { kind: "note", private_for_glimmer: 0 },
      { kind: "health_note", private_for_glimmer: 1 },
    ]);
    db.close();
  });

  it("saves immediately with no confirm question", () => {
    const db = freshTestDb();
    const saved = runValeTool(
      db,
      "client_note_add",
      { client_name: "Ana", text: "He likes neon colors", kind: "note" },
      "en",
    );
    expect(saved.ok).toBe(true);
    expect(
      buildPendingActions(db, "client_note_add", { client_name: "Ana", text: "He likes neon colors" }, saved),
    ).toBeUndefined();
    // Unknown clients fail outright: register them first, then save.
    const unknown = runValeTool(db, "client_note_add", { client_name: "Nadie", text: "hola" });
    expect(unknown.ok).toBe(false);
    expect(
      buildPendingActions(db, "client_note_add", { client_name: "Nadie", text: "hola" }, unknown),
    ).toBeUndefined();
    db.close();
  });

  it("names the removed text when a note is undone, never a health text", () => {
    const db = freshTestDb();
    addNote(db, { client_name: "Ana", text: "Likes neon colors", kind: "note" }, "en");
    const undone = undoLastWrite(db, "en");
    expect(undone.ok).toBe(true);
    expect(undone.message).toBe("Done, I removed the note 'Likes neon colors'.");
    addNote(db, { client_name: "Ana", text: "Allergic to monomer", kind: "health_note" }, "en");
    const hidden = undoLastWrite(db, "en");
    expect(hidden.ok).toBe(true);
    expect(hidden.message).toBe("Done, I removed the private note.");
    expect(hidden.message).not.toContain("monomer");
    db.close();
  });

  it("never lets private text reach the model context", () => {
    const db = freshTestDb();
    const secret = "onicocriptosis severa inventada xyz";
    const result = runValeTool(db, "client_note_add", { client_name: "Ana", text: secret, kind: "health_note" });
    expect(result.ok).toBe(true);
    // Everything this tool hands back toward the model: result + public card.
    const card = findClient(db, { name: "Ana" });
    const modelSees = JSON.stringify({ result, card: card.data });
    expect(modelSees).not.toContain(secret);
    expect(modelSees).not.toContain("onicocriptosis");
    db.close();
  });
});

describe("shopping list", () => {
  it("adds once, reads, and reports unknown items", () => {
    const db = freshTestDb();
    db.prepare("DELETE FROM reminder_items").run();
    db.prepare("DELETE FROM shopping_list").run();
    db.prepare("DELETE FROM reminders").run();
    expect(readShoppingList(db).message).toBe("La lista está vacía.");
    expect(addToShoppingList(db, { item_name: "lima" }).ok).toBe(true);
    const twice = addToShoppingList(db, { item_name: "Lima de Uñas" });
    expect(twice.ok).toBe(true);
    expect(twice.message).toContain("ya está en la lista");
    const count = db.prepare("SELECT COUNT(*) AS n FROM shopping_list").get() as { n: number };
    expect(count.n).toBe(1);
    const read = readShoppingList(db);
    expect(read.message).toContain("Nail file");
    expect(addToShoppingList(db, { item_name: "cohetes" }).ok).toBe(false);
    db.close();
  });

  it("removes an item and undoes the removal", () => {
    const db = freshTestDb();
    db.prepare("DELETE FROM reminder_items").run();
    db.prepare("DELETE FROM shopping_list").run();
    db.prepare("DELETE FROM reminders").run();
    addToShoppingList(db, { item_name: "lima" });
    const removed = removeFromShoppingList(db, { item_name: "Lima" }, "en");
    expect(removed.ok).toBe(true);
    expect(removed.message).toBe("Nail file removed from the list.");
    expect(readShoppingList(db).message).toBe("La lista está vacía.");
    expect(undoLastWrite(db).ok).toBe(true);
    expect(readShoppingList(db).message).toContain("Nail file");
    expect(removeFromShoppingList(db, { item_name: "Lima" }).ok).toBe(true);
    expect(removeFromShoppingList(db, { item_name: "Lima" }).ok).toBe(false);
    db.close();
  });
});

describe("create_client", () => {
  it("registers new clients and refuses lookalikes", () => {
    const db = freshTestDb();
    const created = createClient(db, { name: "Elena Vidal" });
    expect(created.ok).toBe(true);
    expect(createClient(db, { name: "elena vidal" }).ok).toBe(false);
    expect(createClient(db, { name: "Ana" }).message).toContain("ya está registrada");
    expect(createClient(db, { name: "  " }).ok).toBe(false);
    db.close();
  });
});

describe("log_supply_use", () => {
  it("needs an open session and matches similar names", () => {
    const db = freshTestDb();
    expect(logSupplyUse(db, { name: "Acetona" }).ok).toBe(false);
    openAna(db);
    const logged = logSupplyUse(db, { name: "acetona" });
    expect(logged.ok).toBe(true);
    expect(logged.message).toContain("Acetone");
    db.close();
  });

  it("saves unknown supplies at once like notes", () => {
    const db = freshTestDb();
    openAna(db);
    const saved = logSupplyUse(db, { name: "Esmalte verde" }, "en");
    expect(saved.ok).toBe(true);
    expect(saved.message).toBe("Esmalte verde added to Ana's session.");
    const rows = db.prepare(
      "SELECT s.name FROM session_supplies ss JOIN supplies s ON s.id = ss.supply_id",
    ).all() as { name: string }[];
    expect(rows.map((row) => row.name)).toContain("Esmalte verde");
    db.close();
  });
});

describe("undo_last_write", () => {
  it("reverts a note and a list addition", () => {
    const db = freshTestDb();
    const seededNotes = (db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
    db.prepare("DELETE FROM reminder_items").run();
    db.prepare("DELETE FROM shopping_list").run();
    db.prepare("DELETE FROM reminders").run();
    addNote(db, { client_name: "Ana", text: "temporal", kind: "note" });
    expect(undoLastWrite(db).message).toContain("quité la nota 'temporal'");
    const notes = db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number };
    expect(notes.n).toBe(seededNotes);
    addToShoppingList(db, { item_name: "Algodon" });
    undoLastWrite(db);
    expect(readShoppingList(db).message).toBe("La lista está vacía.");
    expect(undoLastWrite(db).ok).toBe(false);
    db.close();
  });

  it("reverts created clients, supply uses and session lifecycle", () => {
    const db = freshTestDb();
    const seededSessions = (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    createClient(db, { name: "Elena Vidal" });
    undoLastWrite(db);
    expect(findClient(db, { name: "Elena" }).ok).toBe(false);
    openAna(db);
    logSupplyUse(db, { name: "Esmalte verde", confirm_create: true });
    undoLastWrite(db);
    const supplies = db.prepare("SELECT COUNT(*) AS n FROM supplies").get() as { n: number };
    expect(supplies.n).toBe(23);
    closeSession(db, { products_used: ["Algodon"] });
    undoLastWrite(db);
    const session = db.prepare("SELECT ended_at FROM sessions ORDER BY id DESC LIMIT 1").get() as {
      ended_at: string | null;
    };
    expect(session.ended_at).toBeNull();
    undoLastWrite(db);
    const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(sessions.n).toBe(seededSessions);
    db.close();
  });
});

function expectedQuote(serviceName: string): { final: number; margin: number } {
  const seed = seedData as unknown as {
    services: { name: string; minutes: number; supplies: { name: string; qty: number }[] }[];
    supplies: { name: string; price_per_product_usd: number; content_per_product: number }[];
  };
  const service = seed.services.find((item) => item.name === serviceName)!;
  const master = new Map(seed.supplies.map((item) => [item.name, item]));
  const breakdown = quotePrice(
    PRICING,
    service.minutes,
    service.supplies.map((line) => ({
      qty: line.qty,
      pricePerProductUsd: master.get(line.name)!.price_per_product_usd,
      contentPerProduct: master.get(line.name)!.content_per_product,
    })),
  );
  return { final: breakdown.finalPrice, margin: breakdown.marginEarned };
}

describe("session_quote", () => {
  it("matches five hand-computed prices with a screen-only breakdown", () => {
    const db = freshTestDb();
    // Hand-computed finals live in quote.test.ts for the October 2026
    // reference month (22 weekday days); here the tool must agree with
    // the same math in whatever month the suite runs.
    const names = ["semipermanente", "Gel refill", "acrílico", "diseño", "pedicura"];
    for (const name of names) {
      const quoted = runValeTool(db, "session_quote", { service_name: name }, "en");
      expect(quoted.ok).toBe(true);
      const data = quoted.data as { service: string; final_price_usd: number; margin_earned_usd: number };
      const expected = expectedQuote(data.service);
      expect(data.final_price_usd).toBe(expected.final);
      expect(data.margin_earned_usd).toBeCloseTo(expected.margin, 5);
      // The voice only points at the sheet: the totals never reach it.
      expect(quoted.message).toContain("on screen");
      expect(quoted.message).not.toContain(String(expected.final));
      expect((quoted as { pendingAccept?: { amount: number } }).pendingAccept).toBeUndefined();
    }
    db.close();
  });

  it("rejects unknown services and supplies without inventing", () => {
    const db = freshTestDb();
    const badService = runValeTool(db, "session_quote", { service_name: "Cohetes" });
    expect(badService.ok).toBe(false);
    expect(badService.message).toContain("No encuentro");
    const badSupply = runValeTool(db, "session_quote", {
      service_name: "retiro",
      supply_names: ["Cohetes"],
    });
    expect(badSupply.ok).toBe(false);
    expect(badSupply.message).toContain("No encuentro");
    const both = db.prepare("SELECT COUNT(*) AS n FROM supplies").get() as { n: number };
    expect(both.n).toBe(23);
    db.close();
  });

  it("uses the open session minutes for its own service", () => {
    const db = freshTestDb();
    openSession(db, { client_name: "Ana", service_name: "Gel removal" });
    const quoted = runValeTool(db, "session_quote", { service_name: "retiro" });
    expect(quoted.ok).toBe(true);
    expect((quoted.data as { minutes: number }).minutes).toBe(1);
    const other = runValeTool(db, "session_quote", { service_name: "semipermanente" });
    expect((other.data as { minutes: number }).minutes).toBe(60);
    db.close();
  });

  it("understands English and Spanish names alike", () => {
    const db = freshTestDb();
    const english = runValeTool(db, "session_quote", { service_name: "Acrylic full set" });
    const spanish = runValeTool(db, "session_quote", { service_name: "Set completo de acrílico" });
    expect(english.ok).toBe(true);
    expect(spanish.ok).toBe(true);
    expect((english.data as { final_price_usd: number }).final_price_usd).toBe(
      (spanish.data as { final_price_usd: number }).final_price_usd,
    );
    db.close();
  });

  it("prices the extras logged in the open session", () => {
    const db = freshTestDb();
    openSession(db, { client_name: "Ana", service_name: "Gel removal" });
    const before = quoteSession(db, {}, "en");
    const base = (before.data as { final_price_usd: number }).final_price_usd;
    logSupplyUse(db, { name: "Top coat" }, "en");
    const after = quoteSession(db, {}, "en");
    expect((after.data as { supplies_cost: number }).supplies_cost).toBeGreaterThan(
      (before.data as { supplies_cost: number }).supplies_cost,
    );
    expect((after.data as { final_price_usd: number }).final_price_usd).toBeGreaterThanOrEqual(base);
    db.close();
  });

  it("Accept registers the suggested total and leaves the session open (decision 1)", () => {
    const db = freshTestDb();
    openSession(db, { client_name: "Ana", service_name: "Gel removal" });
    const quoted = quoteSession(db, {}, "en");
    expect(quoted.ok).toBe(true);
    const pending = (quoted as { pendingAccept?: { amount: number; session_id: number } }).pendingAccept;
    expect(pending?.amount).toBeGreaterThan(0);
    expect(pending?.session_id).toBeGreaterThan(0);
    const accepted = acceptQuote(db, { amount: pending?.amount, session_id: pending?.session_id }, "en");
    expect(accepted.ok).toBe(true);
    expect(accepted.message).toBe("Payment registered.");
    expect(accepted.message).not.toContain(String(pending?.amount));
    const rows = db.prepare("SELECT amount_usd FROM payments").all() as { amount_usd: number }[];
    expect(rows).toEqual([{ amount_usd: pending?.amount }]);
    // Booking talk asserts this shape; nothing closes the session.
    const open = db.prepare("SELECT id FROM sessions WHERE ended_at IS NULL").get() as { id: number };
    expect(open.id).toBe(pending?.session_id);
    db.close();
  });

  it("Reject waits for the spoken amount, which registers instead", () => {
    const db = freshTestDb();
    openSession(db, { client_name: "Ana", service_name: "Gel removal" });
    const sessionId = (db.prepare("SELECT id FROM sessions WHERE ended_at IS NULL").get() as { id: number }).id;
    const rejected = rejectQuote(db, sessionId, "en");
    expect(rejected.ok).toBe(true);
    expect(rejected.message).toBe("Tell me the amount and I'll register it.");
    expect((rejected.data as { awaiting: string }).awaiting).toBe("amount");
    expect(isQuoteAwaiting(sessionId)).toBe(true);
    const paid = quoteSession(db, { amount: 35 }, "en");
    expect(paid.ok).toBe(true);
    expect(paid.message).toBe("Payment registered.");
    const rows = db.prepare("SELECT amount_usd FROM payments").all() as { amount_usd: number }[];
    expect(rows).toEqual([{ amount_usd: 35 }]);
    expect(isQuoteAwaiting(sessionId)).toBe(false);
    // The session stays open through the whole flow.
    const open = db.prepare("SELECT id FROM sessions WHERE ended_at IS NULL").get() as { id: number };
    expect(open.id).toBe(sessionId);
    db.close();
  });

  it("refuses a stray amount with no quote waiting", () => {
    const db = freshTestDb();
    openAna(db);
    expect(quoteSession(db, { amount: 35 }, "en").ok).toBe(false);
    db.close();
  });
});

describe("bilingual matching", () => {
  it("matches canonical, Spanish and alias names to one supply", () => {
    const db = freshTestDb();
    for (const query of ["Top coat", "Sellador", "top", "sellador"]) {
      const result = runValeTool(db, "stock_set", { name: query, qty: 5 });
      expect(result.ok).toBe(true);
    }
    expect(matchAliased([{ id: 1, name: "Lima", es: "", aliases: [] }], "zzz").kind).toBe("none");
    db.close();
  });
});

describe("appointments", () => {
  function bookToday(db: ReturnType<typeof freshTestDb>, client: string, time: string) {
    return createAppointment(db, {
      client_name: client,
      service_name: "retiro",
      day: localDay(),
      time,
    });
  }

  function bogotaPlus(minutes: number): string {
    return localTime(new Date(Date.now() + minutes * 60000));
  }

  it("answers what is today and who is next, including an empty day", () => {
    const db = freshTestDb();
    expect(listToday(db).message).toContain("David 15:00");
    db.prepare("DELETE FROM appointments").run();
    expect(listToday(db).message).toBe("No tienes nada hoy.");
    const inAnHour = bogotaPlus(60);
    const inTwoHours = bogotaPlus(120);
    expect(bookToday(db, "Ana", inAnHour).ok).toBe(true);
    expect(bookToday(db, "Sofia", inTwoHours).ok).toBe(true);
    const today = listToday(db);
    expect(today.ok).toBe(true);
    expect(today.message).toContain(`Ana ${inAnHour}`);
    expect(today.message).toContain(`Sofia ${inTwoHours}`);
    const next = nextAppointment(db);
    expect(next.ok).toBe(true);
    expect(next.message).toBe(`Sigue Ana a las ${inAnHour}.`);
    db.close();
  });

  it("books from natural words on the Bogota calendar (req 7)", () => {
    const db = freshTestDb();
    const booked = createAppointment(
      db,
      { client_name: "Ana", service_name: "retiro", when: "tomorrow at three PM" },
      "en",
    );
    expect(booked.ok).toBe(true);
    const data = booked.data as { day: string; time: string };
    expect(data.time).toBe("15:00");
    expect(data.day).toBe(localDay(new Date(Date.now() + 24 * 3600000)));
    expect(booked.message).toContain("Ana");
    expect(booked.message).toContain("for Gel removal");
    expect(booked.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    db.close();
  });

  it("answers the day plan in English when asked", () => {
    const db = freshTestDb();
    db.prepare("DELETE FROM appointments").run();
    expect(listToday(db, "en").message).toBe("Nothing today.");
    expect(nextAppointment(db, "en").message).toBe("Nobody else today.");
    const inAnHour = new Date(Date.now() + 60 * 60000);
    const pad = (value: number): string => String(value).padStart(2, "0");
    const time = `${pad(inAnHour.getHours())}:${pad(inAnHour.getMinutes())}`;
    expect(bookToday(db, "Ana", time).ok).toBe(true);
    expect(listToday(db, "en").message).toBe(`Today: Ana ${time}.`);
    expect(nextAppointment(db, "en").message).toBe(`Next is Ana at ${time}.`);
    db.close();
  });

  it("refuses unknown clients without creating anything", () => {
    const db = freshTestDb();
    const seeded = (db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number }).n;
    const result = createAppointment(db, {
      client_name: "Nadie",
      service_name: "retiro",
      day: localDay(),
      time: "10:00",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No encuentro");
    const count = db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number };
    expect(count.n).toBe(seeded);
    const moved = moveAppointment(db, { client_name: "Nadie", new_day: localDay(), new_time: "11:00" });
    expect(moved.ok).toBe(false);
    db.close();
  });

  it("rejects days missing from the calendar", () => {
    const db = freshTestDb();
    const nov31 = createAppointment(
      db,
      {
        client_name: "Ana",
        service_name: "retiro",
        day: "2026-11-31",
        time: "18:00",
      },
      "en",
    );
    expect(nov31.ok).toBe(false);
    expect(nov31.message).toContain("30 days");
    const feb29 = createAppointment(db, {
      client_name: "Ana",
      service_name: "retiro",
      day: "2025-02-29",
      time: "18:00",
    });
    expect(feb29.ok).toBe(false);
    const feb29Leap = createAppointment(
      db,
      {
        client_name: "Ana",
        service_name: "retiro",
        day: "2024-02-29",
        time: "18:00",
      },
      "en",
    );
    expect(feb29Leap.ok).toBe(true);
    const count = db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number };
    expect(count.n).toBe(5);
    db.close();
  });

  it("asks before acting on ambiguous clients or broken dates", () => {
    const db = freshTestDb();
    createClient(db, { name: "Sofia Vega" });
    const asked = createAppointment(db, {
      client_name: "sof",
      service_name: "retiro",
      day: localDay(),
      time: "10:00",
    });
    expect(asked.ok).toBe(false);
    expect(asked.message).toContain("¿Cuál");
    const count = db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number };
    expect(count.n).toBe(4);
    expect(createAppointment(db, { client_name: "Ana", service_name: "retiro", day: localDay() }).ok).toBe(false);
    db.close();
  });

  it("moves an appointment and undoes the move", () => {
    const db = freshTestDb();
    db.prepare("DELETE FROM appointments").run();
    bookToday(db, "Ana", "10:00");
    const moved = moveAppointment(
      db,
      { client_name: "Ana", new_day: localDay(), new_time: "12:00", confirm_move: true },
    );
    expect(moved.ok).toBe(true);
    expect(moved.message).toContain("12 PM");
    expect(undoLastWrite(db).ok).toBe(true);
    expect(listToday(db).message).toContain("10:00");
    expect(undoLastWrite(db).message).toContain("Deshecho");
    expect(listToday(db).message).toBe("No tienes nada hoy.");
    db.close();
  });

  it("asks first on a move, then moves on yes (decision 2)", () => {
    const db = freshTestDb();
    db.prepare("DELETE FROM appointments").run();
    bookToday(db, "Ana", "10:00");
    const asked = moveAppointment(db, { client_name: "Ana", new_day: localDay(), new_time: "12:00" });
    expect(asked.ok).toBe(false);
    expect(asked.pendingMove).toEqual({ client_name: "Ana", new_day: localDay(), new_time: "12:00" });
    expect(listToday(db).message).toContain("10:00");
    db.close();
  });

  it("keeps the original time when only the date is corrected (9.4)", () => {
    const db = freshTestDb();
    createClient(db, { name: "Vera" });
    createAppointment(db, { client_name: "Vera", service_name: "retiro", day: localDay(), time: "10:00" });
    // "no, it's for next Friday": the date moves, the 10:00 stays.
    const corrected = moveAppointment(db, { client_name: "Vera", new_when: "next Friday" }, "en");
    expect(corrected.ok).toBe(false);
    expect(corrected.pendingMove?.new_time).toBe("10:00");
    expect(corrected.pendingMove?.new_day).not.toBe(localDay());
    const saved = moveAppointment(
      db,
      { client_name: "Vera", new_when: "next Friday", confirm_move: true },
      "en",
    );
    expect(saved.ok).toBe(true);
    expect((saved.data as { time: string }).time).toBe("10:00");
    db.close();
  });
});

describe("off-hours saving (decision 2)", () => {
  it("saves off-hours bookings directly and marks them", () => {
    const db = freshTestDb();
    const seeded = (db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number }).n;
    const saturday = createAppointment(db, {
      client_name: "Ana",
      service_name: "retiro",
      day: "2026-10-31",
      time: "10:00",
    });
    expect(saturday.ok).toBe(true);
    expect((saturday.data as { off_hours: boolean }).off_hours).toBe(true);
    expect(saturday.message).toContain("fuera de horario");
    const count = db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number };
    expect(count.n).toBe(seeded + 1);
    expect(undoLastWrite(db).ok).toBe(true);
    db.close();
  });

  it("counts 17:00 as in-hours", () => {
    expect(offHoursReasons("2026-10-29", "17:00")).toEqual([]);
    expect(offHoursReasons("2026-10-29", "17:01")).toHaveLength(1);
    expect(offHoursReasons("2026-10-29", "10:00")).toEqual([]);
    expect(offHoursReasons("2026-10-31", "10:00")).toHaveLength(1);
  });

  it("books quietly inside hours on a weekday", () => {
    const db = freshTestDb();
    const booked = createAppointment(db, {
      client_name: "Ana",
      service_name: "retiro",
      day: "2026-10-29",
      time: "10:00",
    });
    expect(booked.ok).toBe(true);
    expect(booked.message.startsWith("Guardada")).toBe(true);
    expect((booked.data as { off_hours: boolean }).off_hours).toBe(false);
    db.close();
  });
});

describe("agenda_show (0.2, X.1)", () => {
  it("shows today with appointments and reminders, voice only (9.6)", () => {
    const db = freshTestDb();
    const shown = showAgenda(db, { range: "today" }, "en");
    expect(shown.ok).toBe(true);
    expect(shown.message).toContain("Today:");
    expect(shown.message).toContain("David at 3 PM for Semi-permanent manicure");
    expect(shown.message).toContain("Reminders:");
    expect(shown.message).toContain("Buy acetone");
    expect(shown.message).toContain("cleaning company");
    const data = shown.data as { appointments: unknown[]; reminders: unknown[] };
    expect(data.appointments).toHaveLength(3);
    expect(data.reminders).toHaveLength(2);
    db.close();
  });

  it("shows a date, the week and a range", () => {
    const db = freshTestDb();
    const week = showAgenda(db, { range: "week" }, "en");
    expect(week.ok).toBe(true);
    expect(week.message).toContain("David");
    expect(week.message).toContain("Ana");
    const today = localDay();
    const date = showAgenda(db, { range: "date", day: today }, "en");
    expect(date.ok).toBe(true);
    expect((date.data as { appointments: { client: string }[] }).appointments.every((row) => row.client !== "Ana")).toBe(true);
    const range = showAgenda(db, { range: "range", from: today, to: today }, "en");
    expect(range.ok).toBe(true);
    expect(range.message).toContain("David");
    expect(showAgenda(db, { range: "someday" }, "en").ok).toBe(false);
    db.close();
  });
});

describe("agenda_create_reminder", () => {
  it("saves a reminder linked to shopping supplies and undoes it", () => {
    const db = freshTestDb();
    const saved = createReminder(db, { text: "Buy more acetone", items: ["Acetona"] }, "en");
    expect(saved.ok).toBe(true);
    expect(saved.message).toBe("Reminder saved.");
    const shown = showAgenda(db, { range: "today" }, "en");
    expect(shown.message).toContain("Buy more acetone");
    expect(undoLastWrite(db).ok).toBe(true);
    const after = showAgenda(db, { range: "today" }, "en");
    expect(after.message).not.toContain("Buy more acetone");
    expect(createReminder(db, { text: "   " }, "en").ok).toBe(false);
    db.close();
  });
});

describe("agenda_cancel_appointment", () => {
  it("asks first, then cancels and undoes", () => {
    const db = freshTestDb();
    const seeded = (db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number }).n;
    const asked = cancelAppointment(db, { client_name: "Ana" }, "en");
    expect(asked.ok).toBe(false);
    expect(typeof asked.pendingCancel?.appointment_id).toBe("number");
    const done = cancelAppointment(
      db,
      { appointment_id: asked.pendingCancel?.appointment_id, confirm_cancel: true },
      "en",
    );
    expect(done.ok).toBe(true);
    expect(done.message).toContain("Cancelled");
    const count = db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number };
    expect(count.n).toBe(seeded - 1);
    expect(undoLastWrite(db).ok).toBe(true);
    const back = db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number };
    expect(back.n).toBe(seeded);
    db.close();
  });
});

describe("service_show and support tools", () => {
  it("shows the service without speaking the price", () => {
    const db = freshTestDb();
    const shown = showService(db, { service_name: "acrílico" }, "en");
    expect(shown.ok).toBe(true);
    expect((shown.data as { list_price_usd: number }).list_price_usd).toBeGreaterThan(0);
    expect(shown.message).not.toContain("USD");
    const list = showService(db, {}, "en");
    expect((list.data as { services: unknown[] }).services.length).toBeGreaterThan(0);
    db.close();
  });

  it("shows the shopping list and the open session on demand", () => {
    const db = freshTestDb();
    const list = showWidget(db, { name: "shopping" }, "en");
    expect(list.ok).toBe(true);
    expect((list.data as { items: string[] }).items).toContain("Acetone");
    expect(showWidget(db, { name: "session" }, "en").ok).toBe(false);
    openAna(db);
    expect(showWidget(db, { name: "session" }, "en").ok).toBe(true);
    expect(showWidget(db, { name: "caja" }, "en").ok).toBe(false);
    db.close();
  });

  it("details one tool at a time", () => {
    const details = getToolDetails({ name: "session_quote" }, "en");
    expect(details.ok).toBe(true);
    expect((details.data as { parameters: unknown }).parameters).toBeTruthy();
    expect(getToolDetails({ name: "session_quote_accept" }, "en").ok).toBe(true);
    expect(getToolDetails({ name: "cohetes" }, "en").ok).toBe(false);
  });
});

describe("salon clock (America/Bogota)", () => {
  it("reads today and now on one clock", () => {
    // 04:30 UTC is 23:30 the day before in Bogota (no DST there).
    expect(localDay(new Date("2026-11-02T04:30:00.000Z"))).toBe("2026-11-01");
    expect(localTime(new Date("2026-11-02T04:30:00.000Z"))).toBe("23:30");
    expect(localDay()).toBe(bogotaDay(new Date()));
  });
});

describe("stock", () => {
  it("sets and adds exact quantities in both languages", () => {
    const db = freshTestDb();
    expect(setStock(db, { name: "guantes", qty: 3 }).message).toContain("quedan 3");
    expect(addStock(db, { name: "Disposable gloves", qty: 2 }).message).toContain("3 + 2 = 5");
    expect(setStock(db, { name: "Top coat", qty: 0 }).message).toContain("quedan 0");
    const row = db.prepare("SELECT stock_qty FROM supplies WHERE name = 'Top coat'").get() as {
      stock_qty: number;
    };
    expect(row.stock_qty).toBe(0);
    db.close();
  });

  it("rejects negative quantities without writing", () => {
    const db = freshTestDb();
    const before = db.prepare("SELECT stock_qty FROM supplies WHERE name = 'Acetone'").get() as {
      stock_qty: number;
    };
    expect(setStock(db, { name: "Acetone", qty: -1 }).ok).toBe(false);
    expect(addStock(db, { name: "Acetone", qty: 0 }).ok).toBe(false);
    const after = db.prepare("SELECT stock_qty FROM supplies WHERE name = 'Acetone'").get() as {
      stock_qty: number;
    };
    expect(after.stock_qty).toBe(before.stock_qty);
    db.close();
  });

  it("warns only about supplies at or below their minimum", () => {
    const db = freshTestDb();
    setStock(db, { name: "Top coat", qty: 5 });
    const read = readStock(db);
    expect(read.ok).toBe(true);
    const low = (read.data as { low: { name: string }[] }).low;
    expect(low.map((item) => item.name)).toContain("Top coat");
    expect(low.every((item) => item.name !== "Acetone")).toBe(true);
    expect(read.message).toContain("mínimo 5");
    db.close();
  });

  it("never moves stock on its own when logging or closing", () => {
    const db = freshTestDb();
    const before = db.prepare("SELECT stock_qty FROM supplies WHERE name = 'Acetone'").get() as {
      stock_qty: number;
    };
    openSession(db, { client_name: "Ana", service_name: "Gel removal" });
    logSupplyUse(db, { name: "Acetone" });
    closeSession(db, { products_used: ["Acetone", "Cotton pads"] });
    const after = db.prepare("SELECT stock_qty FROM supplies WHERE name = 'Acetone'").get() as {
      stock_qty: number;
    };
    expect(after.stock_qty).toBe(before.stock_qty);
    db.close();
  });

  it("undoes stock writes", () => {
    const db = freshTestDb();
    setStock(db, { name: "Acetone", qty: 7 });
    expect(undoLastWrite(db).ok).toBe(true);
    const row = db.prepare("SELECT stock_qty FROM supplies WHERE name = 'Acetone'").get() as {
      stock_qty: number;
    };
    expect(row.stock_qty).toBe(500);
    db.close();
  });
});

describe("goal_progress", () => {
  function closeHourSession(db: ReturnType<typeof freshTestDb>): void {
    openSession(db, { client_name: "Ana", service_name: "Gel removal" });
    db.prepare("UPDATE sessions SET started_at = datetime('now', '-61 minutes') WHERE ended_at IS NULL").run();
    const closed = closeSession(db, { products_used: [] });
    expect(closed.ok).toBe(true);
  }

  it("reports the seeded month progress against the 2500 goal", () => {
    const db = freshTestDb();
    const progress = goalProgress(db);
    expect(progress.ok).toBe(true);
    expect(progress.message).toContain("2500 USD");
    const rows = db
      .prepare(
        `SELECT margin_earned FROM sessions
         WHERE ended_at IS NOT NULL AND strftime('%Y-%m', ended_at) = strftime('%Y-%m', 'now')`,
      )
      .all() as { margin_earned: number }[];
    const total = rows.reduce((sum, row) => sum + row.margin_earned, 0);
    expect(total).toBeGreaterThan(0);
    expect((progress.data as { earned_usd: number }).earned_usd).toBe(Math.round(total * 100) / 100);
    db.close();
  });

  it("adds the closing margin and ignores other months", () => {
    const db = freshTestDb();
    closeHourSession(db);
    const first = db.prepare("SELECT id, margin_earned FROM sessions ORDER BY id DESC LIMIT 1").get() as {
      id: number;
      margin_earned: number;
    };
    expect(first.margin_earned).toBeGreaterThan(0);
    closeHourSession(db);
    const progress = goalProgress(db);
    const data = progress.data as { earned_usd: number };
    const rows = db
      .prepare(
        `SELECT id, margin_earned FROM sessions
         WHERE ended_at IS NOT NULL AND strftime('%Y-%m', ended_at) = strftime('%Y-%m', 'now')`,
      )
      .all() as { id: number; margin_earned: number }[];
    const total = rows.reduce((sum, row) => sum + row.margin_earned, 0);
    expect(data.earned_usd).toBe(Math.round(total * 100) / 100);
    db.prepare("UPDATE sessions SET ended_at = '2026-01-15T12:00:00.000Z' WHERE id = ?").run(first.id);
    const backdated = goalProgress(db);
    expect((backdated.data as { earned_usd: number }).earned_usd).toBe(
      Math.round((total - first.margin_earned) * 100) / 100,
    );
    db.close();
  });

  it("clears the margin when the close is undone", () => {
    const db = freshTestDb();
    closeHourSession(db);
    expect(undoLastWrite(db).ok).toBe(true);
    const row = db.prepare("SELECT margin_earned FROM sessions ORDER BY id DESC LIMIT 1").get() as {
      margin_earned: number | null;
    };
    expect(row.margin_earned).toBeNull();
    db.close();
  });
});

describe("error style", () => {
  it("keeps every error message short", () => {
    const db = freshTestDb();
    const errors = [
      openSession(db, { client_name: "Nadie", service_name: "Retiro" }),
      closeSession(db, {}),
      findClient(db, { name: "Nadie" }),
      addNote(db, { client_name: "Ana", text: "   " }),
      addToShoppingList(db, { item_name: "cohetes" }),
      createClient(db, { name: "" }),
      logSupplyUse(db, { name: "Acetona" }),
      undoLastWrite(db),
    ];
    for (const result of errors) {
      expect(result.ok).toBe(false);
      expect(result.message.length).toBeLessThanOrEqual(120);
    }
    db.close();
  });

  it("matches names deterministically", () => {
    expect(matchOne([{ id: 1, name: "Ana Beltran" }], "ANA").kind).toBe("match");
    expect(
      matchOne(
        [
          { id: 1, name: "Esmalte rojo" },
          { id: 2, name: "Esmalte nude" },
        ],
        "esmalte",
      ).kind,
    ).toBe("ambiguous");
    expect(matchOne([{ id: 1, name: "Ana Beltran" }], "cohetes").kind).toBe("none");
  });
});
