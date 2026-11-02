// @vitest-environment node
import { describe, expect, it } from "vitest";
import { freshTestDb } from "./db";
import { getBoard } from "./board";
import { runValeTool } from "./vale-tools";

describe("board snapshot", () => {
  it("starts empty with no session, card or items", () => {
    const db = freshTestDb();
    db.prepare("DELETE FROM notes").run();
    db.prepare("DELETE FROM reminder_items").run();
    db.prepare("DELETE FROM shopping_list").run();
    db.prepare("DELETE FROM reminders").run();
    expect(getBoard(db)).toEqual({ session: null, card: null, list: [] });
    db.close();
  });

  it("shows the open session, its card and the list", () => {
    const db = freshTestDb();
    runValeTool(db, "session_open", { client_name: "Ana", service_name: "Retiro de gel" });
    runValeTool(db, "client_note_add", { client_name: "Ana", text: "prefiere viernes" });
    runValeTool(db, "client_note_add", { client_name: "Ana", text: "onicolisis", kind: "health_note" });
    runValeTool(db, "shopping_add", { item_name: "lima" });

    const board = getBoard(db);
    expect(board.session?.clientName).toBe("Ana");
    expect(board.session?.serviceName).toBe("Gel removal");
    expect(board.session?.startedAt).toBeTruthy();
    expect(board.card?.name).toBe("Ana");
    expect(board.list).toEqual(["Acetone", "Foil wraps", "Cotton pads", "Nail file"]);

    const health = board.card?.notes.find((note) => note.kind === "health_note");
    expect(health?.masked).toBe(true);
    expect(health?.text).toBeNull();
    expect(JSON.stringify(board)).not.toContain("onicolisis");
    db.close();
  });

  it("keeps the last touched card after the session closes", () => {
    const db = freshTestDb();
    db.prepare("DELETE FROM notes").run();
    runValeTool(db, "session_open", { client_name: "Ana", service_name: "Retiro de gel" });
    runValeTool(db, "session_close", { products_used: [] });
    const board = getBoard(db);
    expect(board.session).toBeNull();
    expect(board.card).toBeNull();
    db.close();
  });
});
