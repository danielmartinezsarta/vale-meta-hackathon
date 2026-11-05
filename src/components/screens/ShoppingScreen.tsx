"use client";

import { useCallback, useEffect, useState } from "react";
import { ManageShell } from "./ManageShell";
import { manageDelete, manageGet, managePost } from "./manageApi";
import styles from "./ManageScreens.module.css";
import { SegmentedControl } from "../SegmentedControl";

interface ShoppingItem {
  id: number;
  supplyId: number;
  name: string;
  stockQty: number;
}

interface Suggestion {
  supplyId: number;
  name: string;
  stockQty: number;
}

interface ShoppingData {
  items: ShoppingItem[];
  suggestions: Suggestion[];
}

/**
 * Shopping list: items to buy with remove, an item picker, and low-stock
 * suggestions with one-tap add.
 */
export function ShoppingScreen({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<ShoppingData | null>(null);
  const [supplies, setSupplies] = useState<{ id: number; name: string }[]>([]);
  const [pick, setPick] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [shopping, supplyRows] = await Promise.all([
      manageGet<ShoppingData>("shopping"),
      manageGet<{ id: number; name: string }[]>("supplies"),
    ]);
    return { shopping, supplyRows };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { shopping, supplyRows } = await load();
      setData(shopping);
      setSupplies(supplyRows);
    } catch {
      setNotice("Could not load the shopping list.");
    }
  }, [load]);

  useEffect(() => {
    let live = true;
    load()
      .then(({ shopping, supplyRows }) => {
        if (!live) return;
        setData(shopping);
        setSupplies(supplyRows);
      })
      .catch(() => {
        if (live) setNotice("Could not load the shopping list.");
      });
    return () => {
      live = false;
    };
  }, [load]);

  const add = async (name: string) => {
    if (!name) return;
    try {
      const result = await managePost("shopping-add", { name });
      setNotice(result.message);
      setPick("");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    }
  };

  const remove = async (name: string) => {
    try {
      const result = await manageDelete("shopping", `?name=${encodeURIComponent(name)}`);
      setNotice(result.message);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  };

  const options = supplies.filter((row) => !data?.items.some((item) => item.name === row.name));

  return (
    <ManageShell title="Shopping list" onBack={onBack} notice={notice}>
      <section className={styles.card} aria-label="To buy">
        <h2 className={styles.h}>To buy</h2>
        {data === null ? (
          <div className={styles.row}><span>Loading…</span></div>
        ) : data.items.length === 0 ? (
          <div className={styles.row}><span>The list is empty.</span></div>
        ) : (
          data.items.map((item) => (
            <div className={styles.row} key={item.id}>
              <span className={styles.grow}>
                {item.name}
                <span className={styles.sub}>Stock: {item.stockQty}</span>
              </span>
              <button
                className={styles.danger}
                style={{ width: "auto", minHeight: 48, padding: "0 14px" }}
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => remove(item.name)}
              >
                Remove
              </button>
            </div>
          ))
        )}
        <fieldset className={styles.seg}>
          <legend className={styles.h}>Add item</legend>
          <SegmentedControl<string>
            label="Add item"
            value={pick}
            onChange={setPick}
            variant="chips"
            options={options.map((row) => ({ value: row.name, label: row.name }))}
          />
        </fieldset>
        <button className={styles.action} type="button" onClick={() => add(pick)}>+ Item</button>
      </section>
      <section className={styles.card} aria-label="Suggestions">
        <h2 className={styles.h}>Suggestions</h2>
        {data === null ? (
          <div className={styles.row}><span>Loading…</span></div>
        ) : data.suggestions.length === 0 ? (
          <div className={styles.row}><span>Nothing running low.</span></div>
        ) : (
          data.suggestions.map((row) => (
            <div className={styles.row} key={row.supplyId}>
              <span className={styles.grow}>
                {row.name}
                <span className={styles.sub}>Stock: {row.stockQty}</span>
              </span>
              <button
                className={styles.action}
                style={{ width: "auto", minHeight: 48, padding: "0 16px" }}
                type="button"
                aria-label={`Add ${row.name}`}
                onClick={() => add(row.name)}
              >
                Add
              </button>
            </div>
          ))
        )}
      </section>
    </ManageShell>
  );
}
