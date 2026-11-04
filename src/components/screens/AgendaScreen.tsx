"use client";

import { useCallback, useEffect, useState } from "react";
import { ManageField, ManageShell } from "./ManageShell";
import { manageDelete, manageGet, managePost } from "./manageApi";
import styles from "./ManageScreens.module.css";

interface Appointment {
  id: number;
  day: string;
  time: string;
  client: string;
  service: string;
  clientId: number;
  serviceId: number;
  referencePhoto: string;
}

interface Reminder {
  id: number;
  text: string;
  kind: string;
  day: string;
}

interface AgendaData {
  appointments: Appointment[];
  reminders: Reminder[];
  undated: Reminder[];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function prettyDay(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/**
 * Agenda: day picker, the day's bookings with reminders on top, undated
 * reminders below. Appointment and reminder forms follow list → form →
 * save / delete with a two-step confirm.
 */
export function AgendaScreen({ onBack }: { onBack: () => void }) {
  const [day, setDay] = useState(todayIso());
  const [data, setData] = useState<AgendaData | null>(null);
  const [clients, setClients] = useState<{ id: number; name: string }[]>([]);
  const [services, setServices] = useState<{ id: number; name: string }[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<"appointment" | "reminder" | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [appt, setAppt] = useState({ clientName: "", serviceName: "", time: "" });
  const [reminder, setReminder] = useState({ text: "", kind: "general", day: "", noDate: false });

  const load = useCallback(async () => {
    const [agenda, clientRows, serviceRows] = await Promise.all([
      manageGet<AgendaData>("agenda", `?day=${day}`),
      manageGet<{ id: number; name: string }[]>("clients"),
      manageGet<{ id: number; name: string }[]>("services"),
    ]);
    return { agenda, clientRows, serviceRows };
  }, [day]);

  const apply = useCallback(
    ({ agenda, clientRows, serviceRows }: { agenda: AgendaData; clientRows: { id: number; name: string }[]; serviceRows: { id: number; name: string }[] }) => {
      setData(agenda);
      setClients(clientRows);
      setServices(serviceRows);
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      apply(await load());
    } catch {
      setNotice("Could not load the agenda.");
    }
  }, [load, apply]);

  useEffect(() => {
    let live = true;
    load()
      .then((data) => {
        if (live) apply(data);
      })
      .catch(() => {
        if (live) setNotice("Could not load the agenda.");
      });
    return () => {
      live = false;
    };
  }, [load, apply]);

  const save = async () => {
    try {
      if (form === "appointment") {
        const result = await managePost("appointment", {
          id: editingId ?? undefined,
          clientName: appt.clientName,
          serviceName: appt.serviceName,
          day,
          time: appt.time,
        });
        setNotice(result.ok ? result.message : result.message);
        if (!result.ok) return;
      } else if (form === "reminder") {
        const result = await managePost("reminder", reminder);
        setNotice(result.message);
        if (!result.ok) return;
      }
      setForm(null);
      setEditingId(null);
      setConfirmId(null);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    }
  };

  const remove = async (kind: "appointment" | "reminder", id: number) => {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    try {
      const result = await manageDelete(kind, `?id=${id}`);
      setNotice(result.message);
      setConfirmId(null);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  };

  const removePhoto = async (id: number) => {
    try {
      const result = await manageDelete("appointment-photo", `?id=${id}`);
      setNotice(result.message);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  };

  return (
    <ManageShell
      title="Agenda"
      onBack={() => (form ? (setForm(null), setEditingId(null)) : onBack())}
      notice={notice}
      actionLabel={form ? "Save" : undefined}
      onAction={form ? save : undefined}
    >
      {!form && (
        <>
          <div className={styles.card}>
            <div className={styles.inline}>
              <button className={styles.back} type="button" aria-label="Previous day" onClick={() => setDay(shiftDay(day, -1))}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <h2 className={styles.h} style={{ flex: 1, textAlign: "center" }}>{prettyDay(day)}</h2>
              <button className={styles.back} type="button" aria-label="Next day" onClick={() => setDay(shiftDay(day, 1))}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
          {data && data.undated.length > 0 && (
            <section className={styles.card} aria-label="No date">
              <h2 className={styles.h}>No date</h2>
              {data.undated.map((item) => (
                <div className={styles.row} key={item.id}>
                  <span className={styles.grow}>{item.text}</span>
                  <button className={styles.danger} style={{ width: "auto", minHeight: 48, padding: "0 14px" }} type="button" onClick={() => remove("reminder", item.id)}>
                    {confirmId === item.id ? "Confirm" : "Delete"}
                  </button>
                </div>
              ))}
            </section>
          )}
          <section className={styles.card} aria-label="Appointments">
            <h2 className={styles.h}>Appointments</h2>
            {data === null ? (
              <div className={styles.row}><span>Loading…</span></div>
            ) : data.appointments.length === 0 ? (
              <div className={styles.row}><span>Nothing on the books.</span></div>
            ) : (
              data.appointments.map((item) => (
                <button
                  className={styles.row}
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setEditingId(item.id);
                    setAppt({ clientName: item.client, serviceName: item.service, time: item.time });
                    setForm("appointment");
                  }}
                >
                  <span className={styles.grow}>
                    {item.time} · {item.client}
                    <span className={styles.sub}>{item.service}</span>
                  </span>
                </button>
              ))
            )}
          </section>
          <section className={styles.card} aria-label="Reminders">
            <h2 className={styles.h}>Reminders</h2>
            {data === null ? (
              <div className={styles.row}><span>Loading…</span></div>
            ) : data.reminders.length === 0 ? (
              <div className={styles.row}><span>No reminders this day.</span></div>
            ) : (
              data.reminders.map((item) => (
                <div className={styles.row} key={item.id}>
                  <span className={styles.grow}>
                    {item.text}
                    <span className={styles.sub}>{item.kind}</span>
                  </span>
                  <button className={styles.danger} style={{ width: "auto", minHeight: 48, padding: "0 14px" }} type="button" onClick={() => remove("reminder", item.id)}>
                    {confirmId === item.id ? "Confirm" : "Delete"}
                  </button>
                </div>
              ))
            )}
          </section>
          <div className={styles.inline}>
            <button className={styles.action} type="button" onClick={() => { setForm("appointment"); setEditingId(null); setAppt({ clientName: "", serviceName: "", time: "" }); }}>
              + Appointment
            </button>
            <button className={styles.action} type="button" onClick={() => { setForm("reminder"); setReminder({ text: "", kind: "general", day, noDate: false }); }}>
              + Reminder
            </button>
          </div>
        </>
      )}
      {form === "appointment" && (
        <div className={styles.card}>
          <h2 className={styles.h}>{editingId ? "Edit appointment" : "New appointment"}</h2>
          <ManageField label="Client">
            <input
              aria-label="Client"
              list="agenda-clients"
              value={appt.clientName}
              onChange={(event) => setAppt({ ...appt, clientName: event.target.value })}
              placeholder="Search clients"
            />
          </ManageField>
          <datalist id="agenda-clients">
            {clients.map((client) => (
              <option key={client.id} value={client.name} />
            ))}
          </datalist>
          <ManageField label="Service">
            <select aria-label="Service" value={appt.serviceName} onChange={(event) => setAppt({ ...appt, serviceName: event.target.value })}>
              <option value="">Select a service</option>
              {services.map((service) => (
                <option key={service.id} value={service.name}>{service.name}</option>
              ))}
            </select>
          </ManageField>
          <ManageField label="Day">
            <input aria-label="Day" type="date" value={day} onChange={(event) => setDay(event.target.value)} />
          </ManageField>
          <ManageField label="Time">
            <input aria-label="Time" type="time" value={appt.time} onChange={(event) => setAppt({ ...appt, time: event.target.value })} />
          </ManageField>
          {editingId && data?.appointments.find((item) => item.id === editingId)?.referencePhoto && (
            <div className={styles.row}>
              <span className={styles.grow}>Reference photo attached</span>
              <button className={styles.danger} style={{ width: "auto", minHeight: 48, padding: "0 14px" }} type="button" onClick={() => removePhoto(editingId)}>
                Remove
              </button>
            </div>
          )}
          {editingId && (
            <button className={confirmId === editingId ? `${styles.danger} ${styles.armed}` : styles.danger} type="button" onClick={() => remove("appointment", editingId)}>
              {confirmId === editingId ? "Confirm cancel" : "Cancel appointment"}
            </button>
          )}
        </div>
      )}
      {form === "reminder" && (
        <div className={styles.card}>
          <h2 className={styles.h}>New reminder</h2>
          <ManageField label="Text">
            <input aria-label="Text" value={reminder.text} onChange={(event) => setReminder({ ...reminder, text: event.target.value })} placeholder="What to remember" />
          </ManageField>
          <fieldset className={styles.seg}>
            <legend className={styles.h}>Kind</legend>
            {(["general", "call", "shopping"] as const).map((kind) => (
              <label key={kind}>
                <input type="radio" name="reminder-kind" value={kind} checked={reminder.kind === kind} onChange={() => setReminder({ ...reminder, kind })} />{" "}
                {kind[0].toUpperCase() + kind.slice(1)}
              </label>
            ))}
          </fieldset>
          <ManageField label="Day">
            <input aria-label="Day" type="date" value={reminder.day} disabled={reminder.noDate} onChange={(event) => setReminder({ ...reminder, day: event.target.value })} />
          </ManageField>
          <label className={styles.inline}>
            <input type="checkbox" checked={reminder.noDate} onChange={(event) => setReminder({ ...reminder, noDate: event.target.checked })} />{" "}
            No date
          </label>
        </div>
      )}
    </ManageShell>
  );
}
