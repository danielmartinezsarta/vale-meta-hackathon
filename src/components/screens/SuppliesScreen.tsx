"use client";

import { useCallback, useEffect, useState } from "react";
import { ManageField, ManageShell } from "./ManageShell";
import { manageDelete, manageGet, managePost } from "./manageApi";
import styles from "./ManageScreens.module.css";

interface Supply {
  id: number;
  name: string;
  es: string;
  unit: string;
  contentPerProduct: number;
  stockQty: number;
  minQty: number;
  pricePerProductUsd: number;
  low: boolean;
}

/**
 * Supplies and stock: All / Low filter, stock / minimum with a Low badge,
 * form with unit picker, steppers, and add-to-shopping-list.
 */
export function SuppliesScreen({ onBack }: { onBack: () => void }) {
  const [filter, setFilter] = useState<"all" | "low">("all");
  const [rows, setRows] = useState<Supply[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", es: "", unit: "pcs", content: "1", stock: "0", min: "0", price: "0" });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    return manageGet<Supply[]>("supplies", `?filter=${filter}`);
  }, [filter]);

  const refresh = useCallback(async () => {
    try {
      setRows(await load());
    } catch {
      setNotice("Could not load supplies.");
    }
  }, [load]);

  useEffect(() => {
    let live = true;
    load()
      .then((rows) => {
        if (live) setRows(rows);
      })
      .catch(() => {
        if (live) setNotice("Could not load supplies.");
      });
    return () => {
      live = false;
    };
  }, [load]);

  const open = (supply: Supply | null) => {
    setEditingId(supply?.id ?? null);
    setCreating(supply === null);
    setConfirmDelete(false);
    setForm(
      supply
        ? {
            name: supply.name,
            es: supply.es,
            unit: supply.unit,
            content: String(supply.contentPerProduct),
            stock: String(supply.stockQty),
            min: String(supply.minQty),
            price: String(supply.pricePerProductUsd),
          }
        : { name: "", es: "", unit: "pcs", content: "1", stock: "0", min: "0", price: "0" },
    );
  };

  const save = async () => {
    try {
      const result = await managePost("supply", {
        id: editingId ?? undefined,
        name: form.name,
        es: form.es,
        unit: form.unit,
        contentPerProduct: form.content,
        stockQty: form.stock,
        minQty: form.min,
        pricePerProductUsd: form.price,
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
      const result = await manageDelete("supply", `?id=${editingId}`);
      setNotice(result.message);
      setConfirmDelete(false);
      setEditingId(null);
      setCreating(false);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  };

  const addToShopping = async () => {
    try {
      const result = await managePost("shopping-add", { name: form.name });
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    }
  };

  const step = (key: "stock" | "min", delta: number) => {
    const next = Math.max(0, Number(form[key]) + delta);
    if (Number.isFinite(next)) setForm({ ...form, [key]: String(next) });
  };

  const editing = creating || editingId !== null;

  return (
    <ManageShell
      title="Supplies & stock"
      onBack={() => (editing ? (setEditingId(null), setCreating(false)) : onBack())}
      notice={notice}
      actionLabel={editing ? "Save" : undefined}
      onAction={editing ? save : undefined}
    >
      {!editing && (
        <>
          <fieldset className={styles.seg}>
            <legend className={styles.h}>Filter</legend>
            {(["all", "low"] as const).map((value) => (
              <label key={value}>
                <input type="radio" name="supply-filter" value={value} checked={filter === value} onChange={() => setFilter(value)} />{" "}
                {value === "all" ? "All" : "Low stock"}
              </label>
            ))}
          </fieldset>
          <section className={styles.card} aria-label="Supplies">
            {rows === null ? (
              <div className={styles.row}><span>Loading…</span></div>
            ) : rows.length === 0 ? (
              <div className={styles.row}><span>No supplies found.</span></div>
            ) : (
              rows.map((row) => (
                <button className={styles.row} key={row.id} type="button" onClick={() => open(row)}>
                  <span className={styles.grow}>
                    {row.name}
                    <span className={styles.sub}>{row.stockQty} / min {row.minQty}</span>
                  </span>
                  {row.low && <span className={styles.badge}>Low</span>}
                </button>
              ))
            )}
          </section>
          <button className={styles.action} type="button" onClick={() => open(null)}>+ Supply</button>
        </>
      )}
      {editing && (
        <div className={styles.card}>
          <h2 className={styles.h}>{creating ? "New supply" : "Supply"}</h2>
          <ManageField label="Name">
            <input aria-label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </ManageField>
          <ManageField label="Spanish name">
            <input aria-label="Spanish name" value={form.es} onChange={(event) => setForm({ ...form, es: event.target.value })} />
          </ManageField>
          <ManageField label="Unit">
            <select aria-label="Unit" value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })}>
              <option value="pcs">pcs</option>
              <option value="ml">ml</option>
              <option value="g">g</option>
            </select>
          </ManageField>
          <ManageField label="Content per product">
            <input aria-label="Content per product" type="number" min="0" step="any" value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} />
          </ManageField>
          <div className={styles.field}>
            <span>Stock</span>
            <div className={styles.stepper}>
              <button type="button" aria-label="Less stock" onClick={() => step("stock", -1)}>−</button>
              <output>{form.stock}</output>
              <button type="button" aria-label="More stock" onClick={() => step("stock", 1)}>+</button>
            </div>
          </div>
          <div className={styles.field}>
            <span>Minimum</span>
            <div className={styles.stepper}>
              <button type="button" aria-label="Lower minimum" onClick={() => step("min", -1)}>−</button>
              <output>{form.min}</output>
              <button type="button" aria-label="Raise minimum" onClick={() => step("min", 1)}>+</button>
            </div>
          </div>
          <ManageField label="Price per product USD">
            <input aria-label="Price per product USD" type="number" min="0" step="0.01" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} />
          </ManageField>
          {!creating && (
            <>
              <button className={styles.action} type="button" onClick={addToShopping}>Add to shopping list</button>
              <button className={confirmDelete ? `${styles.danger} ${styles.armed}` : styles.danger} type="button" onClick={remove}>
                {confirmDelete ? "Confirm delete" : "Delete"}
              </button>
            </>
          )}
        </div>
      )}
    </ManageShell>
  );
}
