"use client";

import { useCallback, useEffect, useState } from "react";
import { ManageField, ManageShell } from "./ManageShell";
import { manageDelete, manageGet, managePost } from "./manageApi";
import styles from "./ManageScreens.module.css";

interface Payment {
  id: number;
  amountUsd: number;
  createdAt: string;
  client: string;
  service: string;
  sessionId: number;
  durationS: number | null;
}

interface PayableSession {
  sessionId: number;
  client: string;
  service: string;
  startedAt: string;
  durationS: number | null;
  supplies: { name: string; qty: number }[];
  paid: boolean;
}

/**
 * Payments: charges by date with This week / This month filter. A charge
 * attaches an amount to a closed session; the session detail stays
 * read-only with duration and supplies.
 */
export function PaymentsScreen({ onBack }: { onBack: () => void }) {
  const [range, setRange] = useState<"week" | "month">("week");
  const [rows, setRows] = useState<Payment[] | null>(null);
  const [sessions, setSessions] = useState<PayableSession[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [amount, setAmount] = useState("");
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [payments, payable] = await Promise.all([
      manageGet<Payment[]>("payments", `?range=${range}`),
      manageGet<PayableSession[]>("sessions"),
    ]);
    return { payments, payable };
  }, [range]);

  const refresh = useCallback(async () => {
    try {
      const { payments, payable } = await load();
      setRows(payments);
      setSessions(payable);
    } catch {
      setNotice("Could not load payments.");
    }
  }, [load]);

  useEffect(() => {
    let live = true;
    load()
      .then(({ payments, payable }) => {
        if (!live) return;
        setRows(payments);
        setSessions(payable);
      })
      .catch(() => {
        if (live) setNotice("Could not load payments.");
      });
    return () => {
      live = false;
    };
  }, [load]);

  const save = async () => {
    try {
      const result = await managePost("payment", { sessionId, amountUsd: amount });
      setNotice(result.message);
      if (!result.ok) return;
      setCreating(false);
      setSessionId("");
      setAmount("");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    }
  };

  const remove = async (id: number) => {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    try {
      const result = await manageDelete("payment", `?id=${id}`);
      setNotice(result.message);
      setConfirmId(null);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  };

  const picked = sessions?.find((row) => String(row.sessionId) === sessionId);

  return (
    <ManageShell
      title="Payments"
      onBack={() => (creating ? setCreating(false) : onBack())}
      notice={notice}
      actionLabel={creating ? "Save" : undefined}
      onAction={creating ? save : undefined}
    >
      {!creating && (
        <>
          <fieldset className={styles.seg}>
            <legend className={styles.h}>Filter</legend>
            {(["week", "month"] as const).map((value) => (
              <label key={value}>
                <input type="radio" name="payment-range" value={value} checked={range === value} onChange={() => setRange(value)} />{" "}
                {value === "week" ? "This week" : "This month"}
              </label>
            ))}
          </fieldset>
          <section className={styles.card} aria-label="Charges">
            {rows === null ? (
              <div className={styles.row}><span>Loading…</span></div>
            ) : rows.length === 0 ? (
              <div className={styles.row}><span>No charges in this period.</span></div>
            ) : (
              rows.map((row) => (
                <div className={styles.row} key={row.id}>
                  <span className={styles.grow}>
                    {row.createdAt.slice(0, 10)} · {row.client}
                    <span className={styles.sub}>{row.service} · ${row.amountUsd}</span>
                  </span>
                  <button
                    className={styles.danger}
                    style={{ width: "auto", minHeight: 48, padding: "0 14px" }}
                    type="button"
                    onClick={() => remove(row.id)}
                  >
                    {confirmId === row.id ? "Confirm" : "Delete"}
                  </button>
                </div>
              ))
            )}
          </section>
          <button className={styles.action} type="button" onClick={() => { setCreating(true); setConfirmId(null); }}>+ Charge</button>
        </>
      )}
      {creating && (
        <div className={styles.card}>
          <h2 className={styles.h}>New charge</h2>
          <ManageField label="Session">
            <select aria-label="Session" value={sessionId} onChange={(event) => setSessionId(event.target.value)}>
              <option value="">Select a session</option>
              {(sessions ?? []).map((row) => (
                <option key={row.sessionId} value={row.sessionId}>
                  {row.startedAt.slice(0, 10)} · {row.client} · {row.service}{row.paid ? " (paid)" : ""}
                </option>
              ))}
            </select>
          </ManageField>
          {picked && (
            <div className={styles.row}>
              <span className={styles.grow}>
                Session detail
                <span className={styles.sub}>
                  {picked.durationS !== null ? `${Math.round(picked.durationS / 60)} min` : "Duration unknown"}
                  {picked.supplies.length > 0
                    ? ` · ${picked.supplies.map((line) => `${line.name} × ${line.qty}`).join(", ")}`
                    : " · no supplies"}
                </span>
              </span>
            </div>
          )}
          <ManageField label="Amount USD">
            <input aria-label="Amount USD" type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </ManageField>
        </div>
      )}
    </ManageShell>
  );
}
