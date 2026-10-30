// @vitest-environment node
import { describe, expect, it } from "vitest";
import { freshTestDb } from "./db";
import {
  buildPendingActions,
  clearPendingAction,
  isConfirmYes,
  runPendingActions,
  setPendingAction,
  takePendingAction,
} from "./pending-action";
import { openSession } from "./vale-tools";
import { windowMs } from "./wake";

describe("pending action", () => {
  it("hears a yes addressed to the proposal, nothing else", () => {
    for (const yes of [
      "sí",
      "Sí, por favor",
      "por favor, sí",
      "sí, hazlo",
      "yes, do it",
      "hazlo",
      "sí, vale",
      "vale, sí",
      "yes",
      "yes please",
      "yes, save it",
      "claro",
      "dale",
    ]) {
      expect(isConfirmYes(yes)).toBe(true);
    }
    for (const no of [
      "",
      "vale",
      "hola",
      "esmaltado",
      "deshazlo",
      "undo it",
      "sí, pero con Ana",
      "qué puedes hacer",
    ]) {
      expect(isConfirmYes(no)).toBe(false);
    }
  });

  it("stores a simple supply proposal when the session is open", () => {
    const db = freshTestDb();
    openSession(db, {
      client_name: "Ana Beltran",
      service_name: "Gel removal",
    });
    expect(
      buildPendingActions(
        db,
        "log_supply_use",
        { name: "Brillo lunar" },
        { ok: false, pendingCreate: "Brillo lunar" },
      ),
    ).toEqual([
      {
        tool: "log_supply_use",
        args: { name: "Brillo lunar", confirm_create: true },
      },
    ]);
  });

  it("stores a combined create-plus-open proposal for an unknown client", () => {
    const db = freshTestDb();
    expect(
      buildPendingActions(
        db,
        "open_session",
        { client_name: "Vera", service_name: "Gel removal" },
        { ok: false },
      ),
    ).toEqual([
      { tool: "create_client", args: { name: "Vera" } },
      {
        tool: "open_session",
        args: { client_name: "Vera", service_name: "Gel removal" },
      },
    ]);
  });

  it("stores nothing when the proposal is incomplete", () => {
    const db = freshTestDb();
    // Unknown service: the model must ask, a yes cannot complete it.
    expect(
      buildPendingActions(
        db,
        "open_session",
        { client_name: "Vera", service_name: "Corte espacial" },
        { ok: false },
      ),
    ).toBeUndefined();
    // No open session: a supply confirm has nowhere to land.
    expect(
      buildPendingActions(
        db,
        "log_supply_use",
        { name: "Brillo lunar" },
        { ok: false, pendingCreate: "Brillo lunar" },
      ),
    ).toBeUndefined();
    // A close-session doubt proposes nothing.
    expect(
      buildPendingActions(db, "close_session", {}, { ok: false }),
    ).toBeUndefined();
  });

  it("takes once, then expires with the attention window", () => {
    const actions = [{ tool: "find_client", args: { name: "Ana" } }];
    setPendingAction("pend-take", actions);
    expect(takePendingAction("pend-take")).toEqual(actions);
    expect(takePendingAction("pend-take")).toBeUndefined();
    setPendingAction(
      "pend-old",
      actions,
      Date.now() - windowMs() - 1000,
    );
    expect(takePendingAction("pend-old")).toBeUndefined();
    clearPendingAction("pend-take");
    clearPendingAction("pend-old");
  });

  it("runs the combined proposal: client created and session open", () => {
    const db = freshTestDb();
    const executed = runPendingActions(db, "pend-run", [
      { tool: "create_client", args: { name: "Vera" } },
      {
        tool: "open_session",
        args: { client_name: "Vera", service_name: "Gel removal" },
      },
    ]);
    expect(executed.toolUsed).toBe("open_session");
    expect(executed.text).toContain("Vera registrada");
    expect(executed.text).toContain("Sesión abierta");
    const clients = db
      .prepare("SELECT name FROM clients WHERE name = ?")
      .get("Vera") as { name: string } | undefined;
    expect(clients?.name).toBe("Vera");
    const open = db
      .prepare("SELECT id FROM sessions WHERE ended_at IS NULL")
      .get() as { id: number } | undefined;
    expect(open?.id).toBeGreaterThan(0);
    clearPendingAction("pend-run");
  });

  it("stops at the first failing step", () => {
    const db = freshTestDb();
    const executed = runPendingActions(db, "pend-partial", [
      { tool: "create_client", args: { name: "Noa" } },
      {
        tool: "open_session",
        args: { client_name: "Noa", service_name: "Corte espacial" },
      },
    ]);
    expect(executed.toolUsed).toBe("open_session");
    expect(executed.text).toContain("Noa registrada");
    const open = db
      .prepare("SELECT id FROM sessions WHERE ended_at IS NULL")
      .get() as { id: number } | undefined;
    expect(open).toBeUndefined();
    clearPendingAction("pend-partial");
  });
});
