"use client";

import { useRef } from "react";
import styles from "./SegmentedControl.module.css";

export type SegmentOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

/**
 * Two-sided segmented switch with radio-group keyboard and screen-reader
 * behaviour. All paint comes from the host screen tokens, so one component
 * serves Home, Settings and Preferences.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((option) => !option.disabled);

  const move = (current: T, step: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = enabled.findIndex((option) => option.value === current);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    onChange(next.value);
    refs.current[options.indexOf(next)]?.focus();
  };

  return (
    <div className={styles.seg} role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const selected = option.value === value;
        const focusable =
          !option.disabled &&
          (selected || !options.some((other) => other.value === value && !other.disabled));
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            tabIndex={focusable ? 0 : -1}
            className={selected ? `${styles.opt} ${styles.on}` : styles.opt}
            onClick={() => {
              if (!option.disabled) onChange(option.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(option.value, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(option.value, -1);
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
