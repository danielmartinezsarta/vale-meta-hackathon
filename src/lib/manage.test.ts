// @vitest-environment node
// HACK-030: every management screen writes through manage.ts to the same
// tables as the voice tools, lands in write_log, and reverses with undo.
import { describe, expect, it } from "vitest";
import { freshTestDb, getBusinessSettings } from "./db";
import { undoLastWrite } from "./vale-tools";
import {
  addFixedCost,
  addSupplyToShopping,
  clearVisitPhoto,
  deleteAppointment,
  deleteClient,
  deleteClientNote,
  deleteFixedCost,
  deletePayment,
  deleteReminder,
  deleteService,
  deleteSupply,
  getClient,
  listAgenda,
  listClients,
  listPayableSessions,
  listPayments,
  listServices,
  listShopping,
  listSupplies,
  removeShoppingItem,
  saveAppointment,
  saveClient,
  saveClientNote,
  savePayment,
  saveReminder,
  saveService,
  saveSettings,
  saveSupply,
  saveProfileName,
  setSupplyStock,
} from "./manage";

function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

describe("business settings seed", () => {
  it("seeds goal values and fixed costs from the seed, with the demo profile", () => {
    const db = freshTestDb();
    const settings = getBusinessSettings(db);
    expect(settings.monthlyGoalUsd).toBe(2500);
    expect(settings.marginPct).toBe(30);
    expect(settings.workHoursPerDay).toBe(8);
    expect(settings.fixedCosts).toHaveLength(4);
    db.close();
  });
});

describe("agenda screen writes", () => {
  it("saves and deletes an appointment, and undo restores the booking", () => {
    const db = freshTestDb();
    const client = listClients(db)[0].name;
    const service = listServices(db)[0].name;
    const saved = saveAppointment(db, { clientName: client, serviceName: service, day: tomorrow(), time: "10:00" });
    expect(saved.ok).toBe(true);
    const id = (saved.data as { appointment_id: number }).appointment_id;
    expect(listAgenda(db, tomorrow()).appointments.some((row) => row.id === id)).toBe(true);
    expect(deleteAppointment(db, id).ok).toBe(true);
    expect(listAgenda(db, tomorrow()).appointments.some((row) => row.id === id)).toBe(false);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(listAgenda(db, tomorrow()).appointments.some((row) => row.id === id)).toBe(true);
    db.close();
  });

  it("saves an undated reminder and deletes it, and undo restores it", () => {
    const db = freshTestDb();
    const saved = saveReminder(db, { text: "Call the supplier", kind: "call", noDate: true });
    expect(saved.ok).toBe(true);
    const id = (saved.data as { reminder_id: number }).reminder_id;
    expect(listAgenda(db, tomorrow()).undated.some((row) => row.id === id)).toBe(true);
    expect(deleteReminder(db, id).ok).toBe(true);
    expect(listAgenda(db, tomorrow()).undated.some((row) => row.id === id)).toBe(false);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(listAgenda(db, tomorrow()).undated.some((row) => row.id === id)).toBe(true);
    db.close();
  });
});

describe("client files screen writes", () => {
  it("creates, renames and deletes a client, and undo restores each step", () => {
    const db = freshTestDb();
    const created = saveClient(db, { name: "Test Client", phone: "+1-555-0199" });
    expect(created.ok).toBe(true);
    const id = (created.data as { client_id: number }).client_id;
    expect(getClient(db, id)?.phone).toBe("+1-555-0199");
    expect(saveClient(db, { id, name: "Test Client", phone: "+1-555-0100" }).ok).toBe(true);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(getClient(db, id)?.phone).toBe("+1-555-0199");
    expect(deleteClient(db, id).ok).toBe(true);
    expect(getClient(db, id)).toBeNull();
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(getClient(db, id)?.name).toBe("Test Client");
    db.close();
  });

  it("saves and deletes a note, and undo restores it", () => {
    const db = freshTestDb();
    const client = listClients(db)[0];
    const saved = saveClientNote(db, { clientId: client.id, text: "Prefers morning slots" });
    expect(saved.ok).toBe(true);
    const noteId = (saved.data as { note_id: number }).note_id;
    expect(getClient(db, client.id)?.notes.some((note) => note.id === noteId)).toBe(true);
    expect(deleteClientNote(db, noteId).ok).toBe(true);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(getClient(db, client.id)?.notes.some((note) => note.id === noteId)).toBe(true);
    db.close();
  });

  it("removes a visit photo, and undo restores it", () => {
    const db = freshTestDb();
    const client = getClient(db, listClients(db)[0].id);
    const withPhoto = client?.visits.find((visit) => visit.photo !== "");
    expect(withPhoto).toBeDefined();
    expect(clearVisitPhoto(db, withPhoto!.id).ok).toBe(true);
    expect(getClient(db, client!.id)?.visits.find((visit) => visit.id === withPhoto!.id)?.photo).toBe("");
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(getClient(db, client!.id)?.visits.find((visit) => visit.id === withPhoto!.id)?.photo).toBe(withPhoto!.photo);
    db.close();
  });
});

describe("services screen writes", () => {
  it("creates, edits and deletes a service, and undo restores each step", () => {
    const db = freshTestDb();
    const supplyId = listSupplies(db)[0].id;
    const created = saveService(db, {
      name: "Test Service",
      priceUsd: 40,
      durationMin: 45,
      supplies: [{ supplyId, qty: 2, unit: "pcs" }],
    });
    expect(created.ok).toBe(true);
    const id = (created.data as { service_id: number }).service_id;
    expect(listServices(db).find((row) => row.id === id)?.supplies).toHaveLength(1);
    expect(saveService(db, { id, name: "Test Service", priceUsd: 45, durationMin: 45, supplies: [] }).ok).toBe(true);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(listServices(db).find((row) => row.id === id)?.supplies).toHaveLength(1);
    expect(deleteService(db, id).ok).toBe(true);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(listServices(db).find((row) => row.id === id)?.name).toBe("Test Service");
    db.close();
  });
});

describe("supplies screen writes", () => {
  it("creates, edits and deletes a supply, and undo restores each step", () => {
    const db = freshTestDb();
    const created = saveSupply(db, { name: "Test Supply", unit: "ml", stockQty: 10, minQty: 2, pricePerProductUsd: 5 });
    expect(created.ok).toBe(true);
    const id = (created.data as { supply_id: number }).supply_id;
    expect(saveSupply(db, { id, name: "Test Supply", unit: "ml", stockQty: 12, minQty: 2, pricePerProductUsd: 5 }).ok).toBe(true);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(listSupplies(db).find((row) => row.id === id)?.stockQty).toBe(10);
    expect(deleteSupply(db, id).ok).toBe(true);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(listSupplies(db).find((row) => row.id === id)?.name).toBe("Test Supply");
    db.close();
  });

  it("sets stock through the voice path, and undo restores the quantity", () => {
    const db = freshTestDb();
    const before = listSupplies(db)[0];
    expect(setSupplyStock(db, before.name, before.stockQty + 5).ok).toBe(true);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(listSupplies(db).find((row) => row.id === before.id)?.stockQty).toBe(before.stockQty);
    db.close();
  });
});

describe("shopping list screen writes", () => {
  it("adds and removes an item, and undo restores each step", () => {
    const db = freshTestDb();
    const name = listSupplies(db).find((row) => !listShopping(db).items.some((item) => item.name === row.name))?.name
      ?? listSupplies(db)[0].name;
    expect(addSupplyToShopping(db, name).ok).toBe(true);
    expect(listShopping(db).items.some((item) => item.name === name)).toBe(true);
    expect(removeShoppingItem(db, name).ok).toBe(true);
    expect(listShopping(db).items.some((item) => item.name === name)).toBe(false);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(listShopping(db).items.some((item) => item.name === name)).toBe(true);
    db.close();
  });
});

describe("payments screen writes", () => {
  it("saves and deletes a payment on a closed session, and undo restores each step", () => {
    const db = freshTestDb();
    const session = listPayableSessions(db).find((row) => !row.paid) ?? listPayableSessions(db)[0];
    const saved = savePayment(db, { sessionId: session.sessionId, amountUsd: 55 });
    expect(saved.ok).toBe(true);
    const id = (saved.data as { payment_id: number }).payment_id;
    expect(listPayments(db, "month").some((row) => row.id === id)).toBe(true);
    expect(deletePayment(db, id).ok).toBe(true);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(listPayments(db, "month").some((row) => row.id === id)).toBe(true);
    db.close();
  });
});

describe("goals screen writes", () => {
  it("saves settings and fixed costs, and undo restores each step", () => {
    const db = freshTestDb();
    expect(saveSettings(db, { monthlyGoalUsd: 3000, marginPct: 35, schedule: "lun-sab", workHoursPerDay: 6 }).ok).toBe(true);
    expect(getBusinessSettings(db).monthlyGoalUsd).toBe(3000);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(getBusinessSettings(db).monthlyGoalUsd).toBe(2500);
    const added = addFixedCost(db, { label: "Test rent", amountUsd: 100 });
    expect(added.ok).toBe(true);
    const id = (added.data as { fixed_cost_id: number }).fixed_cost_id;
    expect(deleteFixedCost(db, id).ok).toBe(true);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    expect(getBusinessSettings(db).fixedCosts.some((row) => row.id === id)).toBe(true);
    db.close();
  });
});

describe("preferences screen writes", () => {
  it("renames the profile, and undo restores the demo name", () => {
    const db = freshTestDb();
    expect(saveProfileName(db, "Demo User").ok).toBe(true);
    expect(undoLastWrite(db, "en").ok).toBe(true);
    const row = db.prepare("SELECT name FROM user_profile WHERE id = 1").get() as { name: string };
    expect(row.name).toBe("Demo");
    db.close();
  });
});
