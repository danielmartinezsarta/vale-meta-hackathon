import { getBusinessSettings, getDb, userName } from "@/lib/db";
import { goalProgress } from "@/lib/vale-tools";
import {
  addSupplyToShopping,
  clearAppointmentPhoto,
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
  addFixedCost,
  saveSupply,
  saveProfileName,
  setSupplyStock,
} from "@/lib/manage";

export const runtime = "nodejs";

type Params = { params: Promise<{ entity: string }> };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function fail(message: string, status = 400): Response {
  return Response.json({ ok: false, message }, { status });
}

/** Management screens read model: one list per entity, same rows as the voice tools. */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { entity } = await params;
  const url = new URL(request.url);
  const db = getDb();
  try {
    switch (entity) {
      case "agenda":
        return json(listAgenda(db, url.searchParams.get("day") ?? new Date().toISOString().slice(0, 10)));
      case "clients":
        return json(listClients(db, url.searchParams.get("q") ?? ""));
      case "client": {
        const id = Number(url.searchParams.get("id"));
        if (!Number.isFinite(id)) return fail("Missing id.");
        const detail = getClient(db, id);
        return detail ? json(detail) : fail("Client not found.", 404);
      }
      case "services":
        return json(listServices(db));
      case "supplies":
        return json(listSupplies(db, url.searchParams.get("filter") === "low" ? "low" : "all"));
      case "shopping":
        return json(listShopping(db));
      case "payments":
        return json(listPayments(db, url.searchParams.get("range") === "month" ? "month" : "week"));
      case "sessions":
        return json(listPayableSessions(db));
      case "settings":
        return json(getBusinessSettings(db));
      case "profile":
        return json({ name: userName(db) });
      case "goal":
        return json(goalProgress(db));
      default:
        return fail("Unknown entity.", 404);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Read failed.", 500);
  }
}

/** Management screens write model: same tables, write_log and undo as the voice tools. */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  const { entity } = await params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("Missing body.");
  const db = getDb();
  try {
    switch (entity) {
      case "appointment":
        return json(saveAppointment(db, body));
      case "reminder":
        return json(saveReminder(db, body));
      case "client":
        return json(saveClient(db, body));
      case "note":
        return json(saveClientNote(db, body));
      case "service":
        return json(saveService(db, body));
      case "supply":
        return json(saveSupply(db, body));
      case "stock": {
        const name = typeof body.name === "string" ? body.name : "";
        const qty = typeof body.qty === "string" && body.qty.trim() !== "" ? Number(body.qty) : body.qty;
        return json(setSupplyStock(db, name, typeof qty === "number" ? qty : Number.NaN));
      }
      case "shopping-add":
        return json(addSupplyToShopping(db, typeof body.name === "string" ? body.name : ""));
      case "payment":
        return json(savePayment(db, body));
      case "settings":
        return json(saveSettings(db, body));
      case "fixed-cost":
        return json(addFixedCost(db, body));
      case "profile":
        return json(saveProfileName(db, typeof body.name === "string" ? body.name : ""));
      default:
        return fail("Unknown entity.", 404);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Save failed.", 500);
  }
}

/** Management screens delete model: every delete asks first on screen, then reverses with undo. */
export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const { entity } = await params;
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  const db = getDb();
  try {
    switch (entity) {
      case "appointment":
        return json(deleteAppointment(db, id));
      case "reminder":
        return json(deleteReminder(db, id));
      case "client":
        return json(deleteClient(db, id));
      case "note":
        return json(deleteClientNote(db, id));
      case "visit-photo":
        return json(clearVisitPhoto(db, id));
      case "appointment-photo":
        return json(clearAppointmentPhoto(db, id));
      case "service":
        return json(deleteService(db, id));
      case "supply":
        return json(deleteSupply(db, id));
      case "shopping":
        return json(removeShoppingItem(db, url.searchParams.get("name") ?? ""));
      case "payment":
        return json(deletePayment(db, id));
      case "fixed-cost":
        return json(deleteFixedCost(db, id));
      default:
        return fail("Unknown entity.", 404);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Delete failed.", 500);
  }
}
