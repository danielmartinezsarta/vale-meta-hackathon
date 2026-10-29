// @vitest-environment node
import { describe, expect, it } from "vitest";
import { freshTestDb } from "./db";
import { getBoard } from "./board";
import { runValeTool } from "./vale-tools";

describe("board snapshot", () => {
  it("starts empty with no session, card or items", () => {
    const db = freshTestDb();
    expect(getBoard(db)).toEqual({ session: null, card: null, list: [] });
    db.close();
  });

  it("shows the open session, its card and the list", () => {
    const db = freshTestDb();
    runValeTool(db, "open_session", { client_name: "Ana", service_name: "Retiro de gel" });
    runValeTool(db, "add_note", { client_name: "Ana", text: "prefiere viernes" });
    runValeTool(db, "add_note", { client_name: "Ana", text: "onicolisis", kind: "health" });
    runValeTool(db, "add_to_shopping_list", { item_name: "Esmalte rojo" });

    const board = getBoard(db);
    expect(board.session?.clientName).toBe("Ana Beltran");
    expect(board.session?.serviceName).toBe("Retiro de gel");
    expect(board.session?.startedAt).toBeTruthy();
    expect(board.card?.name).toBe("Ana Beltran");
    expect(board.list).toEqual(["Esmalte rojo"]);

    const health = board.card?.notes.find((note) => note.kind === "health");
    expect(health?.masked).toBe(true);
    expect(health?.text).toBeNull();
    expect(JSON.stringify(board)).not.toContain("onicolisis");
    db.close();
  });

  it("keeps the last touched card after the session closes", () => {
    const db = freshTestDb();
    runValeTool(db, "open_session", { client_name: "Ana", service_name: "Retiro de gel" });
    runValeTool(db, "close_session", { products_used: [] });
    const board = getBoard(db);
    expect(board.session).toBeNull();
    expect(board.card).toBeNull();
    db.close();
  });
});
