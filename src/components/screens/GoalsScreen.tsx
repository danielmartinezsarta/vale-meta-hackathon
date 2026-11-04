"use client";

import { useCallback, useEffect, useState } from "react";
import { ManageField, ManageShell } from "./ManageShell";
import { manageDelete, manageGet, managePost } from "./manageApi";
import styles from "./ManageScreens.module.css";

interface GoalProgress {
  earned_usd: number;
  goal_usd: number;
  month: string;
}

interface Settings {
  monthlyGoalUsd: number;
  marginPct: number;
  schedule: string;
  workHoursPerDay: number;
  fixedCosts: { id: number; label: string; amountUsd: number }[];
}

const SCHEDULES = ["lun-vie", "lun-sab", "lun-dom"] as const;

function monthLabel(month: string): string {
  const date = new Date(`${month}-01T00:00:00`);
  return Number.isNaN(date.getTime()) ? month : date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/**
 * Goals: month progress (same goal_show figure the voice reports) and the
 * goal form with fixed costs. Seeded from the seed; edits save to
 * business_settings.
 */
export function GoalsScreen({ onBack }: { onBack: () => void }) {
  const [progress, setProgress] = useState<GoalProgress | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ goal: "", margin: "", schedule: "lun-vie", hours: 8 });
  const [costLabel, setCostLabel] = useState("");
  const [costAmount, setCostAmount] = useState("");
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [goal, next] = await Promise.all([
      manageGet<{ ok: boolean; data?: GoalProgress }>("goal"),
      manageGet<Settings>("settings"),
    ]);
    return { progress: goal.data ?? null, settings: next };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { progress, settings } = await load();
      setProgress(progress);
      setSettings(settings);
    } catch {
      setNotice("Could not load goals.");
    }
  }, [load]);

  useEffect(() => {
    let live = true;
    load()
      .then(({ progress, settings }) => {
        if (!live) return;
        setProgress(progress);
        setSettings(settings);
      })
      .catch(() => {
        if (live) setNotice("Could not load goals.");
      });
    return () => {
      live = false;
    };
  }, [load]);

  const startEdit = () => {
    if (!settings) return;
    setForm({
      goal: String(settings.monthlyGoalUsd),
      margin: String(settings.marginPct),
      schedule: settings.schedule,
      hours: settings.workHoursPerDay,
    });
    setEditing(true);
  };

  const save = async () => {
    try {
      const result = await managePost("settings", {
        monthlyGoalUsd: form.goal,
        marginPct: form.margin,
        schedule: form.schedule,
        workHoursPerDay: form.hours,
      });
      setNotice(result.message);
      if (!result.ok) return;
      setEditing(false);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    }
  };

  const addCost = async () => {
    try {
      const result = await managePost("fixed-cost", { label: costLabel, amountUsd: costAmount });
      setNotice(result.message);
      if (!result.ok) return;
      setCostLabel("");
      setCostAmount("");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Save failed.");
    }
  };

  const removeCost = async (id: number) => {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    try {
      const result = await manageDelete("fixed-cost", `?id=${id}`);
      setNotice(result.message);
      setConfirmId(null);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    }
  };

  const pct = progress && progress.goal_usd > 0 ? Math.min(100, Math.round((progress.earned_usd / progress.goal_usd) * 100)) : 0;

  return (
    <ManageShell
      title="Goals"
      onBack={() => (editing ? setEditing(false) : onBack())}
      notice={notice}
      actionLabel={editing ? "Save" : undefined}
      onAction={editing ? save : undefined}
    >
      <div className={styles.card}>
        <h2 className={styles.h}>This month{progress ? ` · ${monthLabel(progress.month)}` : ""}</h2>
        {progress === null ? (
          <div className={styles.row}><span>Loading…</span></div>
        ) : (
          <div className={styles.row}>
            <span className={styles.grow}>
              ${progress.earned_usd} of ${progress.goal_usd}
              <span className={styles.sub}>{pct}% of the monthly goal</span>
            </span>
          </div>
        )}
      </div>
      {!editing && settings && (
        <>
          <div className={styles.card}>
            <div className={styles.row}><span className={styles.grow}>Monthly goal<span className={styles.sub}>${settings.monthlyGoalUsd}</span></span></div>
            <div className={styles.row}><span className={styles.grow}>Margin<span className={styles.sub}>{settings.marginPct}%</span></span></div>
            <div className={styles.row}><span className={styles.grow}>Work days<span className={styles.sub}>{settings.schedule}</span></span></div>
            <div className={styles.row}><span className={styles.grow}>Hours per day<span className={styles.sub}>{settings.workHoursPerDay} h</span></span></div>
          </div>
          <button className={styles.action} type="button" onClick={startEdit}>Edit goal</button>
          <div className={styles.card}>
            <h2 className={styles.h}>Fixed costs</h2>
            {settings.fixedCosts.map((cost) => (
              <div className={styles.row} key={cost.id}>
                <span className={styles.grow}>
                  {cost.label}
                  <span className={styles.sub}>${cost.amountUsd}</span>
                </span>
                <button
                  className={styles.danger}
                  style={{ width: "auto", minHeight: 48, padding: "0 14px" }}
                  type="button"
                  onClick={() => removeCost(cost.id)}
                >
                  {confirmId === cost.id ? "Confirm" : "Delete"}
                </button>
              </div>
            ))}
            <ManageField label="Label">
              <input aria-label="Label" value={costLabel} onChange={(event) => setCostLabel(event.target.value)} placeholder="e.g. studio rent" />
            </ManageField>
            <ManageField label="Amount USD">
              <input aria-label="Amount USD" type="number" min="0" step="0.01" value={costAmount} onChange={(event) => setCostAmount(event.target.value)} />
            </ManageField>
            <button className={styles.action} type="button" onClick={addCost}>+ Add</button>
          </div>
        </>
      )}
      {editing && (
        <div className={styles.card}>
          <h2 className={styles.h}>Edit goal</h2>
          <ManageField label="Monthly goal USD">
            <input aria-label="Monthly goal USD" type="number" min="0" step="1" value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} />
          </ManageField>
          <ManageField label="Margin %">
            <input aria-label="Margin %" type="number" min="0" max="90" step="1" value={form.margin} onChange={(event) => setForm({ ...form, margin: event.target.value })} />
          </ManageField>
          <fieldset className={styles.seg}>
            <legend className={styles.h}>Work days</legend>
            {SCHEDULES.map((value) => (
              <label key={value}>
                <input type="radio" name="work-days" value={value} checked={form.schedule === value} onChange={() => setForm({ ...form, schedule: value })} />{" "}
                {value}
              </label>
            ))}
          </fieldset>
          <div className={styles.field}>
            <span>Hours per day</span>
            <div className={styles.stepper}>
              <button type="button" aria-label="Fewer hours" onClick={() => setForm({ ...form, hours: Math.max(1, form.hours - 1) })}>−</button>
              <output>{form.hours}</output>
              <button type="button" aria-label="More hours" onClick={() => setForm({ ...form, hours: Math.min(24, form.hours + 1) })}>+</button>
            </div>
          </div>
        </div>
      )}
    </ManageShell>
  );
}
