// @vitest-environment node
import { describe, expect, it } from "vitest";
import { freshTestDb } from "./db";
import {
  buildPendingActions,
  clearPendingAction,
  isConfirmYes,
  isRefusalNo,
  pendingConfirmTitle,
  quoteAcceptSessionId,
  runPendingActions,
  peekPendingAction,
  setPendingAction,
  takePendingAction,
} from "./pending-action";
import { getOpenSession, openSession } from "./vale-tools";
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

  it("hears a bare no addressed to the proposal, nothing else", () => {
    for (const no of ["no", "No", "nope", "no, vale", "vale, no"]) {
      expect(isRefusalNo(no)).toBe(true);
    }
    for (const other of [
      "",
      "vale",
      "sí",
      "yes",
      "no quiero",
      "no, gracias",
      "deshazlo",
      "qué puedes hacer",
    ]) {
      expect(isRefusalNo(other)).toBe(false);
    }
  });

  it("stores a simple supply proposal when the session is open", () => {
    const db = freshTestDb();
    openSession(db, {
      client_name: "Ana",
      service_name: "Gel removal",
    });
    expect(
      buildPendingActions(
        db,
        "session_log_supply",
        { name: "Brillo lunar" },
        { ok: false, pendingCreate: "Brillo lunar" },
      ),
    ).toEqual([
      {
        tool: "session_log_supply",
        args: { name: "Brillo lunar", confirm_create: true },
      },
    ]);
  });

  it("stores a combined create-plus-open proposal for an unknown client", () => {
    const db = freshTestDb();
    expect(
      buildPendingActions(
        db,
        "session_open",
        { client_name: "Vera", service_name: "Gel removal" },
        { ok: false },
      ),
    ).toEqual([
      { tool: "client_create", args: { name: "Vera" } },
      {
        tool: "session_open",
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
        "session_open",
        { client_name: "Vera", service_name: "Corte espacial" },
        { ok: false },
      ),
    ).toBeUndefined();
    // No open session: a supply confirm has nowhere to land.
    expect(
      buildPendingActions(
        db,
        "session_log_supply",
        { name: "Brillo lunar" },
        { ok: false, pendingCreate: "Brillo lunar" },
      ),
    ).toBeUndefined();
    // A close-session doubt proposes nothing.
    expect(
      buildPendingActions(db, "session_close", {}, { ok: false }),
    ).toBeUndefined();
  });

  it("stores the Accept behind a successful quote (9.2)", () => {
    const db = freshTestDb();
    openSession(db, { client_name: "Ana", service_name: "Gel removal" });
    const open = getOpenSession(db);
    expect(
      buildPendingActions(
        db,
        "session_quote",
        {},
        { ok: true, pendingAccept: { amount: 45, session_id: open?.id } },
      ),
    ).toEqual([{ tool: "session_quote_accept", args: { amount: 45, session_id: open?.id } }]);
    // No Accept, no proposal.
    expect(buildPendingActions(db, "session_quote", {}, { ok: true })).toBeUndefined();
    expect(quoteAcceptSessionId([])).toBeNull();
    expect(
      quoteAcceptSessionId([{ tool: "session_quote_accept", args: { amount: 45, session_id: 7 } }]),
    ).toBe(7);
    db.close();
  });

  it("never stores an appointment proposal: booking asks nothing (decision 2)", () => {
    const db = freshTestDb();
    expect(
      buildPendingActions(db, "agenda_create_appointment", { client_name: "Ana" }, { ok: true }),
    ).toBeUndefined();
    expect(
      buildPendingActions(db, "agenda_create_appointment", { client_name: "Ana" }, { ok: false }),
    ).toBeUndefined();
    db.close();
  });

  it("never stores move or cancel proposals: both act at once", () => {
    const db = freshTestDb();
    expect(
      buildPendingActions(db, "agenda_move_appointment", { client_name: "Ana" }, { ok: true }),
    ).toBeUndefined();
    expect(
      buildPendingActions(db, "agenda_cancel_appointment", { client_name: "Ana" }, { ok: true }),
    ).toBeUndefined();
    db.close();
  });

  it("takes once, then expires with the attention window", () => {
    const actions = [{ tool: "client_card_show", args: { name: "Ana" } }];
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
      { tool: "client_create", args: { name: "Vera" } },
      {
        tool: "session_open",
        args: { client_name: "Vera", service_name: "Gel removal" },
      },
    ]);
    expect(executed.toolUsed).toBe("session_open");
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
      { tool: "client_create", args: { name: "Noa" } },
      {
        tool: "session_open",
        args: { client_name: "Noa", service_name: "Corte espacial" },
      },
    ]);
    expect(executed.toolUsed).toBe("session_open");
    expect(executed.text).toContain("Noa registrada");
    const open = db
      .prepare("SELECT id FROM sessions WHERE ended_at IS NULL")
      .get() as { id: number } | undefined;
    expect(open).toBeUndefined();
    clearPendingAction("pend-partial");
  });

  it("titles the confirm card from the stored writes", () => {
    expect(
      pendingConfirmTitle(
        [
          { tool: "client_create", args: { name: "Ana" } },
          {
            tool: "session_open",
            args: { client_name: "Ana", service_name: "Gel refill" },
          },
        ],
        "en",
      ),
    ).toBe("Open session with Ana for Gel refill?");
    expect(
      pendingConfirmTitle(
        [{ tool: "session_log_supply", args: { name: "Top coat" } }],
        "en",
      ),
    ).toBe("Log Top coat?");
    expect(
      pendingConfirmTitle(
        [
          { tool: "client_create", args: { name: "Ana" } },
          {
            tool: "session_open",
            args: { client_name: "Ana", service_name: "Gel refill" },
          },
        ],
        "es",
      ),
    ).toBe("¿Abro sesión con Ana de Gel refill?");
    expect(
      pendingConfirmTitle(
        [{ tool: "session_quote_accept", args: { amount: 45, session_id: 3 } }],
        "en",
      ),
    ).toBe("Register the payment?");
    expect(pendingConfirmTitle([], "en")).toBe("Should I save it?");
  });

  it("peeks without consuming and forgets stale proposals", () => {
    setPendingAction("pend-peek", [{ tool: "client_create", args: { name: "Noa" } }], 1000);
    expect(peekPendingAction("pend-peek", 2000)).toBe(true);
    expect(takePendingAction("pend-peek", 2000)).toHaveLength(1);
    expect(peekPendingAction("pend-peek", 2000)).toBe(false);
    setPendingAction("pend-peek-stale", [{ tool: "client_create", args: { name: "Noa" } }], 1000);
    expect(peekPendingAction("pend-peek-stale", 1000 + 60_000)).toBe(false);
    expect(takePendingAction("pend-peek-stale", 1000 + 60_000)).toBeUndefined();
  });

  it("switches a live session on yes: close, register, open", () => {
    const db = freshTestDb();
    openSession(db, { client_name: "Ana", service_name: "Gel refill" });
    const proposal = buildPendingActions(
      db,
      "session_open",
      { client_name: "Chloe", service_name: "Gel refill" },
      {
        ok: false,
        pendingSessionSwitch: { client_name: "Chloe", service_name: "Gel refill" },
      },
    );
    expect(proposal).toEqual([
      { tool: "session_close", args: {} },
      { tool: "client_create", args: { name: "Chloe" } },
      {
        tool: "session_open",
        args: { client_name: "Chloe", service_name: "Gel refill" },
      },
    ]);
    expect(pendingConfirmTitle(proposal ?? [], "en")).toBe(
      "Close the open session and open Chloe for Gel refill?",
    );
    setPendingAction("pend-switch", proposal ?? []);
    const executed = runPendingActions(db, "pend-switch", takePendingAction("pend-switch") ?? []);
    expect(executed.toolUsed).toBe("session_open");
    const open = getOpenSession(db);
    expect(open?.client_id).toBeGreaterThan(0);
    const name = db.prepare("SELECT name FROM clients WHERE id = ?").get(open?.client_id ?? -1) as { name: string };
    expect(name.name).toBe("Chloe");
    db.close();
  });
});
