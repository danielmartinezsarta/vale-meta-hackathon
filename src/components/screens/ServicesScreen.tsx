"use client";

import { useCallback, useEffect, useState } from "react";
import { ManageField, ManageShell } from "./ManageShell";
import { manageDelete, manageGet, managePost } from "./manageApi";
import styles from "./ManageScreens.module.css";

interface RecipeLine {
  supplyId: number;
  name: string;
  qty: number;
  unit: string;
}

interface Service {
  id: number;
  name: string;
  es: string;
  priceUsd: number;
  durationMin: number;
  supplies: RecipeLine[];
}

interface Supply {
  id: number;
  name: string;
  unit: string;
}

/**
 * Services: list with price and duration, form with Spanish name, USD
 * price, 15-minute duration stepper, and the supplies recipe.
 */
export function ServicesScreen({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Service[] | null>(null);
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", es: "", priceUsd: "", durationMin: 60 });
  const [lines, setLines] = useState<RecipeLine[]>([]);
  const [lineSupply, setLineSupply] = useState("");
  const [lineQty, setLineQty] = useState("1");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    const [serviceRows, supplyRows] = await Promise.all([
      manageGet<Service[]>("services"),
      manageGet<Supply[]>("supplies"),
    ]);
    return { serviceRows, supplyRows };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { serviceRows, supplyRows } = await load();
      setRows(serviceRows);
      setSupplies(supplyRows);
    } catch {
      setNotice("Could not load services.");
    }
  }, [load]);

  useEffect(() => {
    let live = true;
    load()
      .then(({ serviceRows, supplyRows }) => {
        if (!live) return;
        setRows(serviceRows);
        setSupplies(supplyRows);
      })
      .catch(() => {
        if (live) setNotice("Could not load services.");
      });
    return () => {
      live = false;
    };
  }, [load]);

  const open = (service: Service | null) => {
    setEditingId(service?.id ?? null);
    setCreating(service === null);
    setConfirmDelete(false);
    setForm(
      service
        ? { name: service.name, es: service.es, priceUsd: String(service.priceUsd), durationMin: service.durationMin }
        : { name: "", es: "", priceUsd: "", durationMin: 60 },
    );
    setLines(service?.supplies ?? []);
  };

  const save = async () => {
    try {
      const result = await managePost("service", {
        id: editingId ?? undefined,
        name: form.name,
        es: form.es,
        priceUsd: form.priceUsd,
        durationMin: form.durationMin,
        supplies: lines,
      });
      setNotice(result.message);
      if (!result.ok) return;
      setEditingId(null);
      setCreating(false);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    }
  };

  const remove = async () => {
    if (editingId === null) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      const result = await manageDelete("service", `?id=${editingId}`);
      setNotice(result.message);
      setConfirmDelete(false);
      setEditingId(null);
      setCreating(false);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  };

  const addLine = () => {
    const supply = supplies.find((row) => row.name === lineSupply);
    const qty = Number(lineQty);
    if (!supply || !Number.isFinite(qty) || qty <= 0) {
      setNotice("Pick a supply and a quantity.");
      return;
    }
    if (lines.some((line) => line.supplyId === supply.id)) {
      setNotice("That supply is already in the recipe.");
      return;
    }
    setLines([...lines, { supplyId: supply.id, name: supply.name, qty, unit: supply.unit }]);
    setLineSupply("");
    setLineQty("1");
  };

  const editing = creating || editingId !== null;

  return (
    <ManageShell
      title="Services"
      onBack={() => (editing ? (setEditingId(null), setCreating(false)) : onBack())}
      notice={notice}
      actionLabel={editing ? "Save" : undefined}
      onAction={editing ? save : undefined}
    >
      {!editing && (
        <>
          <section className={styles.card} aria-label="Services">
            {rows === null ? (
              <div className={styles.row}><span>Loading…</span></div>
            ) : (
              rows.map((row) => (
                <button className={styles.row} key={row.id} type="button" onClick={() => open(row)}>
                  <span className={styles.grow}>
                    {row.name}
                    <span className={styles.sub}>${row.priceUsd} · {row.durationMin} min</span>
                  </span>
                </button>
              ))
            )}
          </section>
          <button className={styles.action} type="button" onClick={() => open(null)}>+ Service</button>
        </>
      )}
      {editing && (
        <div className={styles.card}>
          <h2 className={styles.h}>{creating ? "New service" : "Service"}</h2>
          <ManageField label="Name">
            <input aria-label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </ManageField>
          <ManageField label="Spanish name">
            <input aria-label="Spanish name" value={form.es} onChange={(event) => setForm({ ...form, es: event.target.value })} />
          </ManageField>
          <ManageField label="Price USD">
            <input aria-label="Price USD" type="number" min="0" step="0.01" value={form.priceUsd} onChange={(event) => setForm({ ...form, priceUsd: event.target.value })} />
          </ManageField>
          <div className={styles.field}>
            <span>Duration min</span>
            <div className={styles.stepper}>
              <button type="button" aria-label="Shorter" onClick={() => setForm({ ...form, durationMin: Math.max(15, form.durationMin - 15) })}>−</button>
              <output>{form.durationMin}</output>
              <button type="button" aria-label="Longer" onClick={() => setForm({ ...form, durationMin: form.durationMin + 15 })}>+</button>
            </div>
          </div>
          <h2 className={styles.h}>Supplies used</h2>
          {lines.map((line) => (
            <div className={styles.row} key={line.supplyId}>
              <span className={styles.grow}>{line.name}<span className={styles.sub}>{line.qty} {line.unit}</span></span>
              <button className={styles.danger} style={{ width: "auto", minHeight: 48, padding: "0 14px" }} type="button" onClick={() => setLines(lines.filter((item) => item.supplyId !== line.supplyId))}>
                Remove
              </button>
            </div>
          ))}
          <div className={styles.inline}>
            <select className={styles.select} aria-label="Supply" value={lineSupply} onChange={(event) => setLineSupply(event.target.value)} style={{ flex: 2, minHeight: 48, minWidth: 0 }}>
              <option value="">Select a supply</option>
              {supplies.map((supply) => (
                <option key={supply.id} value={supply.name}>{supply.name}</option>
              ))}
            </select>
            <input className={styles.qty} aria-label="Quantity" type="number" min="0" step="any" value={lineQty} onChange={(event) => setLineQty(event.target.value)} style={{ flex: 1 }} />
            <button className={styles.action} style={{ width: "auto", padding: "0 16px" }} type="button" onClick={addLine}>+ Add</button>
          </div>
          {!creating && (
            <button className={confirmDelete ? `${styles.danger} ${styles.armed}` : styles.danger} type="button" onClick={remove}>
              {confirmDelete ? "Confirm delete" : "Delete"}
            </button>
          )}
        </div>
      )}
    </ManageShell>
  );
}
