// @vitest-environment node
import { describe, expect, it } from "vitest";
import { freshTestDb } from "./db";
import { PRICING } from "./db";
import { quotePrice } from "./quote";
import seedData from "./seed-data.json";
import {
  VALE_TOOLS,
  addNote,
  addStock,
  addToShoppingList,
  closeSession,
  createAppointment,
  createClient,
  findClient,
  goalProgress,
  listToday,
  localDay,
  logSupplyUse,
  matchAliased,
  matchOne,
  moveAppointment,
  nextAppointment,
  openSession,
  readShoppingList,
  readStock,
  runValeTool,
  setStock,
  undoLastWrite,
} from "./vale-tools";

function openAna(db: ReturnType<typeof freshTestDb>) {
  const opened = openSession(db, { client_name: "Ana", service_name: "Retiro de gel" });
  expect(opened.ok).toBe(true);
}

describe("tool definitions", () => {
  it("exposes the 8 HACK-002 tools plus undo and the 9 HACK-003 tools", () => {
    const names = VALE_TOOLS.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "add_note",
        "add_stock",
        "add_to_shopping_list",
        "close_session",
        "create_appointment",
        "create_client",
        "find_client",
        "goal_progress",
        "list_today",
        "log_supply_use",
        "move_appointment",
        "next_appointment",
        "open_session",
        "quote_price",
        "read_shopping_list",
        "read_stock",
        "set_stock",
        "undo_last_write",
      ].sort(),
    );
    for (const tool of VALE_TOOLS) expect(tool.type).toBe("function");
  });
});

describe("sessions", () => {
  it("opens and closes a session with duration and products", () => {
    const db = freshTestDb();
    const opened = openSession(db, { client_name: "ana", service_name: "retiro" });
    expect(opened.ok).toBe(true);
    expect(opened.message).toContain("Ana Beltran");
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
    expect(openSession(db, { client_name: "Maria", service_name: "Manicura" }).ok).toBe(false);
    closeSession(db, {});
    expect(closeSession(db, {}).ok).toBe(false);
    expect(closeSession(db, {}).message).toBe("No hay sesión abierta.");
    db.close();
  });

  it("reports unknown clients and services without inventing", () => {
    const db = freshTestDb();
    expect(openSession(db, { client_name: "Nadie", service_name: "Retiro" }).message).toContain("No encuentro");
    expect(openSession(db, { client_name: "Ana", service_name: "Cohetes" }).message).toContain("No encuentro");
    db.close();
  });
});

describe("find_client", () => {
  it("finds by approximate name and asks when ambiguous", () => {
    const db = freshTestDb();
    const found = findClient(db, { name: "ana" });
    expect(found.ok).toBe(true);
    expect(found.card?.name).toBe("Ana Beltran");
    expect(findClient(db, { name: "nadie" }).ok).toBe(false);
    db.close();
  });
});

describe("add_note", () => {
  it("saves general notes and private health notes", () => {
    const db = freshTestDb();
    const general = addNote(db, { client_name: "Ana", text: "prefiere viernes", kind: "general" });
    expect(general.ok).toBe(true);
    const health = addNote(db, { client_name: "Ana", text: "onicolisis pulgar", kind: "health" });
    expect(health.ok).toBe(true);
    expect(health.message).toBe("Nota privada guardada.");
    const stored = db.prepare("SELECT kind, private_for_glimmer FROM notes ORDER BY id").all() as {
      kind: string;
      private_for_glimmer: number;
    }[];
    expect(stored).toEqual([
      { kind: "general", private_for_glimmer: 0 },
      { kind: "health", private_for_glimmer: 1 },
    ]);
    db.close();
  });

  it("never lets private text reach the model context", () => {
    const db = freshTestDb();
    const secret = "onicocriptosis severa inventada xyz";
    const result = runValeTool(db, "add_note", { client_name: "Ana", text: secret, kind: "health" });
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

  it("offers to create unknown supplies and only creates on yes", () => {
    const db = freshTestDb();
    openAna(db);
    const asked = logSupplyUse(db, { name: "Esmalte verde" });
    expect(asked.ok).toBe(false);
    expect(asked.pendingCreate).toBe("Esmalte verde");
    expect(asked.message).toContain("¿lo creo");
    const countBefore = db.prepare("SELECT COUNT(*) AS n FROM supplies").get() as { n: number };
    expect(countBefore.n).toBe(23);
    const created = logSupplyUse(db, { name: "Esmalte verde", confirm_create: true });
    expect(created.ok).toBe(true);
    expect(created.message).toContain("creado y anotado");
    db.close();
  });
});

describe("undo_last_write", () => {
  it("reverts a note and a list addition", () => {
    const db = freshTestDb();
    addNote(db, { client_name: "Ana", text: "temporal", kind: "general" });
    expect(undoLastWrite(db).message).toContain("Deshecho");
    const notes = db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number };
    expect(notes.n).toBe(0);
    addToShoppingList(db, { item_name: "Algodon" });
    undoLastWrite(db);
    expect(readShoppingList(db).message).toBe("La lista está vacía.");
    expect(undoLastWrite(db).ok).toBe(false);
    db.close();
  });

  it("reverts created clients, supply uses and session lifecycle", () => {
    const db = freshTestDb();
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
    const session = db.prepare("SELECT ended_at FROM sessions").get() as { ended_at: string | null };
    expect(session.ended_at).toBeNull();
    undoLastWrite(db);
    const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(sessions.n).toBe(0);
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

describe("quote_price", () => {
  it("matches five hand-computed prices with a spoken breakdown", () => {
    const db = freshTestDb();
    // Hand-computed finals live in quote.test.ts for the October 2026
    // reference month (22 weekday days); here the tool must agree with
    // the same math in whatever month the suite runs.
    const names = ["semipermanente", "Gel refill", "acrílico", "diseño", "pedicura"];
    for (const name of names) {
      const quoted = runValeTool(db, "quote_price", { service_name: name });
      expect(quoted.ok).toBe(true);
      const data = quoted.data as { service: string; final_price_usd: number; margin_earned_usd: number };
      const expected = expectedQuote(data.service);
      expect(data.final_price_usd).toBe(expected.final);
      expect(data.margin_earned_usd).toBeCloseTo(expected.margin, 5);
      expect(quoted.message).toContain("insumos");
      expect(quoted.message).toContain("tiempo");
      expect(quoted.message).toContain("fijos");
      expect(quoted.message).toContain("margen 30%");
      expect(quoted.message).toContain(`${expected.final} USD`);
    }
    db.close();
  });

  it("rejects unknown services and supplies without inventing", () => {
    const db = freshTestDb();
    const badService = runValeTool(db, "quote_price", { service_name: "Cohetes" });
    expect(badService.ok).toBe(false);
    expect(badService.message).toContain("No encuentro");
    const badSupply = runValeTool(db, "quote_price", {
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
    const quoted = runValeTool(db, "quote_price", { service_name: "retiro" });
    expect(quoted.ok).toBe(true);
    expect((quoted.data as { minutes: number }).minutes).toBe(1);
    const other = runValeTool(db, "quote_price", { service_name: "semipermanente" });
    expect((other.data as { minutes: number }).minutes).toBe(60);
    db.close();
  });

  it("understands English and Spanish names alike", () => {
    const db = freshTestDb();
    const english = runValeTool(db, "quote_price", { service_name: "Acrylic full set" });
    const spanish = runValeTool(db, "quote_price", { service_name: "Set completo de acrílico" });
    expect(english.ok).toBe(true);
    expect(spanish.ok).toBe(true);
    expect((english.data as { final_price_usd: number }).final_price_usd).toBe(
      (spanish.data as { final_price_usd: number }).final_price_usd,
    );
    db.close();
  });
});

describe("bilingual matching", () => {
  it("matches canonical, Spanish and alias names to one supply", () => {
    const db = freshTestDb();
    for (const query of ["Top coat", "Sellador", "top", "sellador"]) {
      const result = runValeTool(db, "set_stock", { name: query, qty: 5 });
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
      confirm_off_hours: true,
    });
  }

  it("answers what is today and who is next, including an empty day", () => {
    const db = freshTestDb();
    expect(listToday(db).message).toBe("No tienes nada hoy.");
    const inAnHour = new Date(Date.now() + 60 * 60000);
    const inTwoHours = new Date(Date.now() + 120 * 60000);
    const pad = (value: number): string => String(value).padStart(2, "0");
    const timeOf = (when: Date): string => `${pad(when.getHours())}:${pad(when.getMinutes())}`;
    expect(bookToday(db, "Ana", timeOf(inAnHour)).ok).toBe(true);
    expect(bookToday(db, "Maria", timeOf(inTwoHours)).ok).toBe(true);
    const today = listToday(db);
    expect(today.ok).toBe(true);
    expect(today.message).toContain(`Ana Beltran ${timeOf(inAnHour)}`);
    expect(today.message).toContain(`Maria Solis ${timeOf(inTwoHours)}`);
    const next = nextAppointment(db);
    expect(next.ok).toBe(true);
    expect(next.message).toBe(`Sigue Ana Beltran a las ${timeOf(inAnHour)}.`);
    db.close();
  });

  it("refuses unknown clients without creating anything", () => {
    const db = freshTestDb();
    const result = createAppointment(db, {
      client_name: "Nadie",
      service_name: "retiro",
      day: localDay(),
      time: "10:00",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No encuentro");
    const count = db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number };
    expect(count.n).toBe(0);
    const moved = moveAppointment(db, { client_name: "Nadie", new_day: localDay(), new_time: "11:00" });
    expect(moved.ok).toBe(false);
    db.close();
  });

  it("asks before acting on ambiguous clients or broken dates", () => {
    const db = freshTestDb();
    createClient(db, { name: "Ana Ruiz" });
    const asked = createAppointment(db, {
      client_name: "ana",
      service_name: "retiro",
      day: localDay(),
      time: "10:00",
    });
    expect(asked.ok).toBe(false);
    expect(asked.message).toContain("¿Cuál");
    const count = db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number };
    expect(count.n).toBe(0);
    expect(createAppointment(db, { client_name: "Ana", service_name: "retiro", day: localDay() }).ok).toBe(false);
    db.close();
  });

  it("moves an appointment and undoes the move", () => {
    const db = freshTestDb();
    bookToday(db, "Ana", "10:00");
    const moved = moveAppointment(db, { client_name: "Ana", new_day: localDay(), new_time: "12:00" });
    expect(moved.ok).toBe(true);
    expect(moved.message).toContain("12:00");
    expect(undoLastWrite(db).ok).toBe(true);
    expect(listToday(db).message).toContain("10:00");
    expect(undoLastWrite(db).message).toContain("Deshecho");
    expect(listToday(db).message).toBe("No tienes nada hoy.");
    db.close();
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

  it("starts at zero against the 2500 goal", () => {
    const db = freshTestDb();
    const progress = goalProgress(db);
    expect(progress.ok).toBe(true);
    expect(progress.message).toContain("2500 USD");
    expect((progress.data as { earned_usd: number }).earned_usd).toBe(0);
    db.close();
  });

  it("adds the closing margin and ignores other months", () => {
    const db = freshTestDb();
    closeHourSession(db);
    const first = db.prepare("SELECT margin_earned FROM sessions").get() as { margin_earned: number };
    expect(first.margin_earned).toBeGreaterThan(0);
    closeHourSession(db);
    const progress = goalProgress(db);
    const data = progress.data as { earned_usd: number };
    const rows = db.prepare("SELECT margin_earned FROM sessions").all() as { margin_earned: number }[];
    const total = rows.reduce((sum, row) => sum + row.margin_earned, 0);
    expect(data.earned_usd).toBe(Math.round(total * 100) / 100);
    db.prepare("UPDATE sessions SET ended_at = '2026-01-15T12:00:00.000Z' WHERE id = 1").run();
    const backdated = goalProgress(db);
    expect((backdated.data as { earned_usd: number }).earned_usd).toBe(Math.round(rows[1].margin_earned * 100) / 100);
    db.close();
  });

  it("clears the margin when the close is undone", () => {
    const db = freshTestDb();
    closeHourSession(db);
    expect(undoLastWrite(db).ok).toBe(true);
    const row = db.prepare("SELECT margin_earned FROM sessions").get() as { margin_earned: number | null };
    expect(row.margin_earned).toBeNull();
    db.close();
  });
});

describe("off-hours warning", () => {
  it("asks before booking on weekends or outside 9-17, and writes nothing until yes", () => {
    const db = freshTestDb();
    const saturday = createAppointment(db, {
      client_name: "Ana",
      service_name: "retiro",
      day: "2026-10-31",
      time: "10:00",
    });
    expect(saturday.ok).toBe(false);
    expect(saturday.message.startsWith("Ojo,")).toBe(true);
    expect(saturday.message).toContain("fin de semana");
    expect(saturday.message).toContain("¿La guardo igual?");
    expect(saturday.pendingOffHours).toBe(true);
    const early = createAppointment(db, {
      client_name: "Maria",
      service_name: "retiro",
      day: "2026-10-29",
      time: "08:00",
    });
    expect(early.ok).toBe(false);
    expect(early.message).toContain("fuera de 9 a 17");
    const both = createAppointment(db, {
      client_name: "Carmen",
      service_name: "retiro",
      day: "2026-10-31",
      time: "18:00",
    });
    expect(both.ok).toBe(false);
    expect(both.message).toContain("fin de semana y queda fuera de 9 a 17");
    const count = db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number };
    expect(count.n).toBe(0);
    const confirmed = createAppointment(db, {
      client_name: "Ana",
      service_name: "retiro",
      day: "2026-10-31",
      time: "10:00",
      confirm_off_hours: true,
    });
    expect(confirmed.ok).toBe(true);
    expect(confirmed.message).toContain("Cita guardada");
    expect((confirmed.data as { off_hours: boolean }).off_hours).toBe(true);
    const after = db.prepare("SELECT COUNT(*) AS n FROM appointments").get() as { n: number };
    expect(after.n).toBe(1);
    expect(undoLastWrite(db).ok).toBe(true);
    db.close();
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
    expect(booked.message.startsWith("Cita guardada")).toBe(true);
    expect((booked.data as { off_hours: boolean }).off_hours).toBe(false);
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
