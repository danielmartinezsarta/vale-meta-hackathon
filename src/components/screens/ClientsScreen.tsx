"use client";

import { useCallback, useEffect, useState } from "react";
import { ManageField, ManageShell } from "./ManageShell";
import { manageDelete, manageGet, managePost } from "./manageApi";
import styles from "./ManageScreens.module.css";
import { SegmentedControl } from "../SegmentedControl";

interface ClientRow {
  id: number;
  name: string;
  phone: string;
  next: string | null;
}

interface ClientNote {
  id: number;
  kind: string;
  text: string | null;
  masked: boolean;
}

interface ClientVisit {
  id: number;
  visitedAt: string;
  service: string;
  photo: string;
  note: string;
}

interface ClientDetail {
  id: number;
  name: string;
  sex: string;
  phone: string;
  email: string;
  birthday: string;
  notes: ClientNote[];
  healthAlert: boolean;
  visits: ClientVisit[];
  brief: string[] | null;
}

/**
 * Client files: search, list with next visit, full card with contact,
 * notes (health badge), read-only visits, and the private Glimmer brief.
 */
export function ClientsScreen({ onBack }: { onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ClientRow[] | null>(null);
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", sex: "", phone: "", email: "", birthday: "" });
  const [noteText, setNoteText] = useState("");
  const [healthNote, setHealthNote] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    return manageGet<ClientRow[]>("clients", query ? `?q=${encodeURIComponent(query)}` : "");
  }, [query]);

  const refreshList = useCallback(async () => {
    try {
      setRows(await loadList());
    } catch {
      setNotice("Could not load clients.");
    }
  }, [loadList]);

  useEffect(() => {
    let live = true;
    loadList()
      .then((rows) => {
        if (live) setRows(rows);
      })
      .catch(() => {
        if (live) setNotice("Could not load clients.");
      });
    return () => {
      live = false;
    };
  }, [loadList]);

  const open = async (id: number) => {
    try {
      const card = await manageGet<ClientDetail>("client", `?id=${id}`);
      setDetail(card);
      setForm({ name: card.name, sex: card.sex, phone: card.phone, email: card.email, birthday: card.birthday });
      setCreating(false);
      setConfirmId(null);
    } catch {
      setNotice("Could not open the client file.");
    }
  };

  const save = async () => {
    try {
      const result = await managePost("client", detail && !creating ? { ...form, id: detail.id } : form);
      setNotice(result.message);
      if (!result.ok) return;
      setCreating(false);
      await refreshList();
      const id = (result.data as { client_id: number } | undefined)?.client_id ?? detail?.id;
      if (id) await open(id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    }
  };

  const remove = async (kind: "client" | "note" | "visit-photo", id: number) => {
    const key = `${kind}:${id}`;
    if (confirmId !== key) {
      setConfirmId(key);
      return;
    }
    try {
      const result = await manageDelete(kind, `?id=${id}`);
      setNotice(result.message);
      setConfirmId(null);
      if (kind === "client") {
        setDetail(null);
        await refreshList();
      } else if (detail) {
        await open(detail.id);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  };

  const addNote = async () => {
    if (!detail) return;
    try {
      const result = await managePost("note", { clientId: detail.id, text: noteText, healthNote });
      setNotice(result.message);
      if (!result.ok) return;
      setNoteText("");
      setHealthNote(false);
      await open(detail.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    }
  };

  const editing = creating || detail !== null;

  return (
    <ManageShell
      title="Client files"
      onBack={() => (editing ? (setDetail(null), setCreating(false)) : onBack())}
      notice={notice}
      actionLabel={editing ? "Save" : undefined}
      onAction={editing ? save : undefined}
    >
      {!editing && (
        <>
          <ManageField label="Search">
            <input aria-label="Search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, phone or email" />
          </ManageField>
          <section className={styles.card} aria-label="Clients">
            {rows === null ? (
              <div className={styles.row}><span>Loading…</span></div>
            ) : rows.length === 0 ? (
              <div className={styles.row}><span>No clients found.</span></div>
            ) : (
              rows.map((row) => (
                <button className={styles.row} key={row.id} type="button" onClick={() => open(row.id)}>
                  <span className={styles.grow}>
                    {row.name}
                    <span className={styles.sub}>{row.next ? `Next: ${row.next}` : "No upcoming visit"}</span>
                  </span>
                </button>
              ))
            )}
          </section>
          <button className={styles.action} type="button" onClick={() => { setCreating(true); setDetail(null); setForm({ name: "", sex: "", phone: "", email: "", birthday: "" }); }}>
            + Client
          </button>
        </>
      )}
      {editing && (
        <>
          <div className={styles.card}>
            <h2 className={styles.h}>{creating ? "New client" : "Client"}</h2>
            <ManageField label="Name">
              <input aria-label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </ManageField>
            <fieldset className={styles.seg}>
              <legend className={styles.h}>Sex</legend>
              <SegmentedControl<string>
                label="Sex"
                value={form.sex}
                onChange={(sex) => setForm({ ...form, sex })}
                options={(["", "female", "male"] as const).map((sex) => ({
                  value: sex,
                  label: sex === "" ? "Unspecified" : sex[0].toUpperCase() + sex.slice(1),
                }))}
              />
            </fieldset>
            <ManageField label="Phone">
              <input aria-label="Phone" type="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
            </ManageField>
            <ManageField label="Email">
              <input aria-label="Email" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
            </ManageField>
            <ManageField label="Birthday">
              <input aria-label="Birthday" type="date" value={form.birthday} onChange={(event) => setForm({ ...form, birthday: event.target.value })} />
            </ManageField>
            {detail && !creating && (
              <button
                className={confirmId === `client:${detail.id}` ? `${styles.danger} ${styles.armed}` : styles.danger}
                type="button"
                onClick={() => remove("client", detail.id)}
              >
                {confirmId === `client:${detail.id}` ? "Confirm delete" : "Delete client"}
              </button>
            )}
          </div>
          {detail && !creating && (
            <>
              <div className={styles.card}>
                <h2 className={styles.h}>Notes</h2>
                {detail.notes.length === 0 && <div className={styles.row}><span>No notes yet.</span></div>}
                {detail.notes.map((note) => (
                  <div className={styles.row} key={note.id}>
                    <span className={styles.grow}>{note.masked ? "Private health note" : note.text}</span>
                    {note.kind === "health_note" && <span className={styles.badge}>Health</span>}
                    <button
                      className={styles.danger}
                      style={{ width: "auto", minHeight: 48, padding: "0 14px" }}
                      type="button"
                      onClick={() => remove("note", note.id)}
                    >
                      {confirmId === `note:${note.id}` ? "Confirm" : "Delete"}
                    </button>
                  </div>
                ))}
                <ManageField label="New note">
                  <textarea aria-label="New note" value={noteText} onChange={(event) => setNoteText(event.target.value)} placeholder="One-line note" />
                </ManageField>
                <label className={styles.inline}>
                  <input type="checkbox" checked={healthNote} onChange={(event) => setHealthNote(event.target.checked)} />{" "}
                  Health note
                </label>
                <button className={styles.action} type="button" onClick={addNote}>+ Note</button>
              </div>
              <div className={styles.card}>
                <h2 className={styles.h}>Visits and photos</h2>
                {detail.visits.length === 0 && <div className={styles.row}><span>No visits yet.</span></div>}
                {detail.visits.map((visit) => (
                  <div className={styles.row} key={visit.id}>
                    <span className={styles.grow}>
                      {visit.visitedAt.slice(0, 10)} · {visit.service || "Visit"}
                      <span className={styles.sub}>{visit.photo ? "Photo attached" : visit.note || "No photo"}</span>
                    </span>
                    {visit.photo && (
                      <button
                        className={styles.danger}
                        style={{ width: "auto", minHeight: 48, padding: "0 14px" }}
                        type="button"
                        onClick={() => remove("visit-photo", visit.id)}
                      >
                        {confirmId === `visit-photo:${visit.id}` ? "Confirm" : "Delete"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className={styles.card}>
                <h2 className={styles.h}>Private brief</h2>
                <p className={styles.sub}>Prepared privately by Muse Glimmer (open weights)</p>
                {detail.brief === null ? (
                  <div className={styles.row}><span>No brief yet.</span></div>
                ) : (
                  detail.brief.map((line, index) => (
                    <div className={styles.row} key={index}><span>{line}</span></div>
                  ))
                )}
              </div>
            </>
          )}
        </>
      )}
    </ManageShell>
  );
}
