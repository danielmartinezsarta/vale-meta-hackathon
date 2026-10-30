// @vitest-environment node
import { describe, expect, it } from "vitest";
import { freshTestDb } from "./db";
import {
  VALE_TOOLS,
  addNote,
  addToShoppingList,
  closeSession,
  createClient,
  findClient,
  logSupplyUse,
  matchOne,
  openSession,
  readShoppingList,
  runValeTool,
  undoLastWrite,
} from "./vale-tools";

function openAna(db: ReturnType<typeof freshTestDb>) {
  const opened = openSession(db, { client_name: "Ana", service_name: "Retiro de gel" });
  expect(opened.ok).toBe(true);
}

describe("tool definitions", () => {
  it("exposes the 8 tools plus undo", () => {
    const names = VALE_TOOLS.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "add_note",
        "add_to_shopping_list",
        "close_session",
        "create_client",
        "find_client",
        "log_supply_use",
        "open_session",
        "read_shopping_list",
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
    expect(addToShoppingList(db, { item_name: "esmalte rojo" }).ok).toBe(true);
    const twice = addToShoppingList(db, { item_name: "Esmalte Rojo" });
    expect(twice.ok).toBe(true);
    expect(twice.message).toContain("ya está en la lista");
    const count = db.prepare("SELECT COUNT(*) AS n FROM shopping_list").get() as { n: number };
    expect(count.n).toBe(1);
    const read = readShoppingList(db);
    expect(read.message).toContain("Esmalte rojo");
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
    expect(logged.message).toContain("Acetona pura");
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
    expect(countBefore.n).toBe(10);
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
    expect(supplies.n).toBe(10);
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
