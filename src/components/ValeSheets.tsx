"use client";

import { useEffect, useState } from "react";
import type {
  BookedData,
  ClientCardData,
  FinalPhotoConfirmData,
  FinalResultData,
  GoalData,
  HealthNoteData,
  NoteData,
  PhotosData,
  PriceData,
  SessionSummaryData,
  Widget,
} from "@/lib/widget";
import { formatDay, initials, usdWhole } from "@/lib/widget";

/** Ali's lock tag: sensitive data stays on screen, never spoken. */
function LockTag() {
  return (
    <span className="aw-sheet__tag">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="5" y="10.5" width="14" height="9.5" rx="3" />
          <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" />
        </g>
      </svg>
      On screen only
    </span>
  );
}

function SheetHead({
  icon,
  title,
  tag,
  closeLabel,
  onClose,
}: {
  icon: React.ReactNode;
  title: string;
  tag?: React.ReactNode;
  closeLabel?: string;
  onClose?: () => void;
}) {
  return (
    <div className="aw-sheet__head">
      <span className="aw-sheet__ic" aria-hidden="true">
        {icon}
      </span>
      <h2 className="aw-sheet__title">{title}</h2>
      {tag}
      {closeLabel && onClose && (
        <button
          className="aw-btn aw-card-close"
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <g
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6.5 6.5l11 11" />
              <path d="M17.5 6.5l-11 11" />
            </g>
          </svg>
        </button>
      )}
    </div>
  );
}

function Field({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`aw-field${wide ? " aw-field--wide" : ""}`}>
      <small>{label}</small>
      <b>{value}</b>
    </div>
  );
}

/** Ali's placeholder hand: real photos replace it slot by slot. */
export function PlaceholderHand({
  bg,
  skin,
  nail,
  tip,
  sparks,
  view,
  gems,
}: {
  bg: string;
  skin: string;
  nail: string;
  tip?: string;
  sparks?: boolean;
  view: string;
  gems?: boolean;
}) {
  const fingers: [number, number][] = [
    [26, 56],
    [45, 40],
    [64, 34],
    [83, 44],
  ];
  return (
    <svg viewBox={view} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="120" height="140" fill={bg} />
      <rect x="22" y="92" width="82" height="60" rx="24" fill={skin} />
      <rect
        x="8"
        y="76"
        width="16"
        height="44"
        rx="8"
        fill={skin}
        transform="rotate(-32 16 98)"
      />
      {fingers.map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <rect x={x} y={y} width="16" height="70" rx="8" fill={skin} />
          <rect x={x + 2} y={y + 3} width="12" height="17" rx="6" fill={nail} />
          {tip && <rect x={x + 3} y={y + 4} width="10" height="5" rx="2.5" fill={tip} />}
        </g>
      ))}
      {sparks && (
        <g fill="#fff">
          <path d="M104 18l2.2 6 6 2.2-6 2.2-2.2 6-2.2-6-6-2.2 6-2.2z" />
          <path d="M14 34l1.4 3.6 3.6 1.4-3.6 1.4L14 44l-1.4-3.6L9 39l3.6-1.4z" />
        </g>
      )}
      {gems && (
        <g fill="#fff" stroke="#8FE6F2" strokeWidth=".7">
          <path d="M34 54.5 l3.2 4.5 -3.2 4.5 -3.2 -4.5z" />
          <path d="M53 38.5 l3.2 4.5 -3.2 4.5 -3.2 -4.5z" />
        </g>
      )}
    </svg>
  );
}

function SlotPhoto({ src, seed }: { src: string | null; seed: React.ReactNode }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" aria-hidden="true" />
  ) : (
    seed
  );
}

const PERSON_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="9" r="3.4" />
      <path d="M5.5 19.5c.8-3.6 3.4-5.3 6.5-5.3s5.7 1.7 6.5 5.3" />
    </g>
  </svg>
);

const GOAL_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r=".8" fill="currentColor" />
    </g>
  </svg>
);

const HEALTH_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.600-7 10-7 10z" />
    </g>
  </svg>
);

const PRICE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 12.500V5h7.500l8 8-7.500 7.500z" />
      <circle cx="8.500" cy="9" r="1.200" />
    </g>
  </svg>
);

const PHOTO_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 7.5A2 2 0 015.5 5.5h4l2 2.5h7a2 2 0 012 2v7.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />
    </g>
  </svg>
);

const FOLDER_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 8.5A2.5 2.5 0 016.5 6h1.8l1.2-1.8h5L15.7 6h1.8A2.5 2.5 0 0120 8.5v8a2.5 2.5 0 01-2.5 2.5h-11A2.5 2.5 0 014 16.5z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </g>
  </svg>
);

const IMAGE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="5" width="16" height="14" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 16.5l4.5-4 3.5 3 3-2.5L20 16" />
    </g>
  </svg>
);

const SUMMARY_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 3.500h7.500L19 8v12.500H7z" />
      <path d="M14 3.500V8.500h5M10 13h6M10 16.500h6" />
    </g>
  </svg>
);

const CHECK_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M5 12.5l4.5 4.5L19 7.500"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.600"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const MUSE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9z"
      fill="currentColor"
    />
    <path
      d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"
      fill="currentColor"
    />
  </svg>
);

function SexSeg({ sex }: { sex: ClientCardData["sex"] }) {
  if (sex === null) return null;
  const options = ["Female", "Male", "Not defined"] as const;
  return (
    <div className="aw-seg" role="group" aria-label="Sex">
      {options.map((option) => (
        <span key={option} className={option === sex ? "is-on" : undefined} aria-current={option === sex ? "true" : undefined}>
          {option}
        </span>
      ))}
    </div>
  );
}

function CardBody({ data, onVisit }: { data: ClientCardData; onVisit?: (date: string) => void }) {
  return (
    <div className="aw-cc">
      <div className="aw-cc__who">
        <span className="aw-cc__avatar" aria-hidden="true">
          {initials(data.name)}
        </span>
        <div className="aw-cc__name">
          <b>{data.name}</b>
          {data.birthday !== null && <small>Birthday · {data.birthday}</small>}
        </div>
      </div>
      <SexSeg sex={data.sex} />
      {data.phone !== null && (
        <div className="aw-cc__row">
          <span>{data.phone}</span>
        </div>
      )}
      {data.email !== null && (
        <div className="aw-cc__row">
          <span>{data.email}</span>
        </div>
      )}
      {data.healthNotes.length > 0 && (
        <div className="aw-cc__alert" role="note">
          <div className="aw-cc__h">
            <b>Health</b>
            <span className="aw-cc__lock">On screen only</span>
          </div>
          {data.healthNotes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}
      {(data.visits.length > 0 || data.noteTags.length > 0) && (
        <div className="aw-cc__block">
          {data.visits.length > 0 && (
            <>
              <div className="aw-cc__h">
                <b>Visits</b>
                <span>
                  {data.visits.length + data.visitsMore} visit{data.visits.length + data.visitsMore === 1 ? "" : "s"}
                </span>
              </div>
              {data.visits.map((visit) => (
                <button
                  key={`${visit.date}-${visit.service}`}
                  className="aw-visit"
                  type="button"
                  data-visit={visit.date}
                  aria-label={`${visit.date}, ${visit.service}: open the photos of this visit`}
                  onClick={() => onVisit?.(visit.date)}
                >
                  <span>{visit.date}</span>
                  <span>{visit.service}</span>
                </button>
              ))}
              {data.visitsMore > 0 && <p className="aw-cc__more">+ {data.visitsMore} earlier visits</p>}
            </>
          )}
          {data.noteTags.length > 0 && (
            <>
              <div className="aw-cc__h">
                <b>Notes</b>
              </div>
              <div className="aw-tags">
                {data.noteTags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Count-up bar; restarts on every open, still with reduced motion. */
function GoalBody({ data }: { data: GoalData }) {
  const pct = Math.min(100, Math.round((data.earned / data.goal) * 100));
  const [shown, setShown] = useState({ pct: 0, earned: 0 });
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const timer = window.setTimeout(() => setShown({ pct, earned: data.earned }), 0);
      return () => window.clearTimeout(timer);
    }
    const start = Date.now();
    const duration = 1800;
    const timer = window.setInterval(() => {
      const k = Math.max(0, Math.min(1, (Date.now() - start) / duration));
      const eased = 1 - Math.pow(1 - k, 3);
      setShown({ pct: Math.round(pct * eased), earned: Math.round(data.earned * eased) });
      if (k >= 1) window.clearInterval(timer);
    }, 30);
    return () => window.clearInterval(timer);
  }, [pct, data.earned]);
  return (
    <div className="aw-goal" style={{ "--pct": pct } as React.CSSProperties}>
        <div className="aw-goal__pct">
          <b className="aw-goal__num">{shown.pct}</b>
          <span>%</span>
        </div>
        <div className="aw-goal__row">
          <div
            className="aw-goal__track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label="Monthly goal progress"
          >
            <div className="aw-goal__fill" />
            <i className="aw-goal__tick" style={{ left: "25%" }} />
            <i className="aw-goal__tick" style={{ left: "50%" }} />
            <i className="aw-goal__tick" style={{ left: "75%" }} />
            <span className="aw-goal__now" aria-hidden="true">
              {usdWhole(shown.earned)}
            </span>
          </div>
          <div className="aw-goal__end">
            <svg className="aw-goal__chest" viewBox="0 0 64 64" aria-hidden="true">
              <path d="M12 36L15 14Q32 7 49 14L52 36Z" fill="#2346C8" />
              <path d="M17 34L19.500 17Q32 12.500 44.500 17L47 34Z" fill="#14224F" opacity=".55" />
              <g className="aw-goal__coins">
                <circle className="aw-coin c1" cx="22" cy="31" r="7.500" fill="#7FDDEB" />
                <circle cx="22" cy="31" r="4.500" fill="none" stroke="#fff" strokeWidth="1.400" opacity=".75" />
                <circle className="aw-coin c2" cx="35" cy="27" r="8" fill="#FF6BBE" />
                <circle cx="35" cy="27" r="5" fill="none" stroke="#fff" strokeWidth="1.400" opacity=".75" />
                <circle className="aw-coin c3" cx="46" cy="32" r="6.500" fill="#BFD0FF" />
                <circle cx="46" cy="32" r="4" fill="none" stroke="#fff" strokeWidth="1.400" opacity=".8" />
              </g>
              <rect x="9" y="35" width="46" height="23" rx="5.500" fill="#2F5BFF" />
              <rect x="9" y="43" width="46" height="4.500" fill="#18B8E0" />
              <rect x="28" y="39.500" width="8" height="10" rx="2.200" fill="#E6329B" />
              <circle cx="32" cy="44" r="1.400" fill="#fff" />
              <path
                className="aw-spark s1"
                d="M55 8l1.600 4.400 4.400 1.600-4.400 1.600L55 20l-1.600-4.400L49 14l4.400-1.600z"
                fill="#fff"
              />
              <path
                className="aw-spark s2"
                d="M10 6l1.100 3 3 1.100-3 1.100L10 14.200 8.900 11.200 5.900 10.100l3-1.100z"
                fill="#FF6BBE"
              />
            </svg>
            <div className="aw-goal__target">
              <small>Goal</small>
              <b>{usdWhole(data.goal)}</b>
            </div>
          </div>
        </div>
      </div>
  );
}

function SensFields({ rows }: { rows: { label: string; value: string; wide?: boolean }[] }) {
  return (
    <div className="aw-fields">
      {rows.map((row) => (
        <Field key={row.label} label={row.label} value={row.value} wide={row.wide} />
      ))}
    </div>
  );
}

function AcceptReject({ onAccept, onReject }: { onAccept?: () => void; onReject?: () => void }) {
  return (
    <div className="aw-actions">
      <button className="aw-btn aw-reject" type="button" onClick={onReject}>
        Reject
      </button>
      <button className="aw-btn aw-accept" type="button" onClick={onAccept}>
        Accept
      </button>
    </div>
  );
}

const CAM_SEEDS = {
  before: { bg: "#2C3A6E", skin: "#8FE6F2", nail: "#8FE6F2", view: "0 0 120 140", sparks: true as const },
  final: { bg: "#E6329B", skin: "#FFD9EC", nail: "#E6329B", tip: "#8FE6F2", view: "0 0 120 140" },
  ref: { bg: "#8FA9FF", skin: "#BFD0FF", nail: "#E6329B", view: "0 0 120 140" },
  exp: { bg: "#3E52A2", skin: "#13224F", nail: "#FF6BBE", tip: "#8FE6F2", view: "0 0 120 140", gems: true as const },
};

function PhotosBody({ data }: { data: PhotosData }) {
  return (
    <div className="aw-pics">
      <div className="aw-pic" data-slot="before">
        <span className="aw-pic__tag">Before</span>
        <SlotPhoto
          src={data.before}
          seed={<PlaceholderHand {...CAM_SEEDS.before} />}
        />
      </div>
      <div className="aw-pic" data-slot="reference">
        <span className="aw-pic__tag">Reference</span>
        <SlotPhoto
          src={data.reference}
          seed={<PlaceholderHand {...CAM_SEEDS.ref} />}
        />
      </div>
      <div className="aw-pic aw-pic--wide" data-slot="expected">
        <span className="aw-pic__tag">Expected result</span>
        <SlotPhoto
          src={data.expected}
          seed={<PlaceholderHand {...CAM_SEEDS.exp} />}
        />
      </div>
      <div className="aw-pics__note" data-l10n="muse">
        {MUSE_ICON}
        <span>Photos generated by Muse Spark</span>
      </div>
    </div>
  );
}

/** Good-job overlay: greeting caption plus the three care icons. */
export function CareOverlay({ caption }: { caption: string }) {
  const items = [
    { icon: "💧", label: "Water" },
    { icon: "🍎", label: "Food" },
    { icon: "🧘", label: "Stretch" },
  ];
  return (
    <div className="aw-care" aria-live="polite">
      <b className="aw-care__t">{caption}</b>
      <div className="aw-care__row">
        {items.map((item) => (
          <span className="aw-care__it" key={item.label}>
            <i aria-hidden="true">{item.icon}</i>
            <small>{item.label}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

export interface SheetCallbacks {
  onClose?: () => void;
  onAccept?: () => void;
  onReject?: () => void;
  onChoose?: (choice: "before" | "final") => void;
  onVisit?: (date: string) => void;
}

/** Ali's sheet per widget kind; confirm keeps the legacy card elsewhere. */
export function ValeSheets({ widget, ...callbacks }: { widget: Widget } & SheetCallbacks) {
  const { onClose, onAccept, onReject, onChoose, onVisit } = callbacks;
  switch (widget.kind) {
    case "client_card":
      return (
        <section className="aw-sheet aw-card-sheet is-open" aria-label="Client card">
          <SheetHead icon={PERSON_ICON} title={widget.title} closeLabel="Close client card" onClose={onClose} />
          <CardBody data={widget.data} onVisit={onVisit} />
        </section>
      );
    case "goal":
      return (
        <section className="aw-sheet aw-goal-sheet is-open" aria-label="Monthly goal">
          <div className="aw-sheet__head">
            <span className="aw-sheet__ic" aria-hidden="true">
              {GOAL_ICON}
            </span>
            <div className="aw-goal__titles">
              <h2 className="aw-sheet__title">Monthly goal</h2>
              {widget.data.name !== null && <small className="aw-goal__sub">{widget.data.name}</small>}
            </div>
            <LockTag />
          </div>
          <GoalBody data={widget.data} />
        </section>
      );
    case "camera_save_as":
      return (
        <section className="aw-sheet aw-cam-sheet is-open" aria-label="Save photo as">
          <div className="aw-sheet__head">
            <span className="aw-sheet__ic" aria-hidden="true">
              {PHOTO_ICON}
            </span>
            <h2 className="aw-sheet__title">Save photo as</h2>
          </div>
          <div className="aw-choices">
            <button className="aw-choice" type="button" onClick={() => onChoose?.("before")}>
              <span className="aw-choice__ph" aria-hidden="true">
                <PlaceholderHand {...CAM_SEEDS.before} />
              </span>
              <b>Before</b>
              <small>Start of the session</small>
            </button>
            <button className="aw-choice" type="button" onClick={() => onChoose?.("final")}>
              <span className="aw-choice__ph" aria-hidden="true">
                <PlaceholderHand {...CAM_SEEDS.final} />
              </span>
              <b>Final photo</b>
              <small>Result of the session</small>
            </button>
          </div>
        </section>
      );
    case "photos":
      return (
        <section className="aw-sheet aw-pics-sheet is-open" aria-label="Photos">
          <SheetHead icon={FOLDER_ICON} title={widget.title} closeLabel="Close photos" onClose={onClose} />
          <PhotosBody data={widget.data} />
        </section>
      );
    case "health_note":
      return (
        <section className="aw-sheet aw-sens-sheet is-open" aria-label="Health note">
          <SheetHead icon={HEALTH_ICON} title={widget.title} tag={<LockTag />} />
          <SensFields rows={[{ label: "Note", value: widget.data.text, wide: true }, { label: "Client", value: widget.data.client }]} />
        </section>
      );
    case "note":
      return (
        <section className="aw-sheet aw-sens-sheet is-open" aria-label="Note saved">
          <SheetHead icon={SUMMARY_ICON} title={widget.title} />
          <SensFields rows={[{ label: "Note", value: widget.data.text, wide: true }, { label: "Client", value: widget.data.client }]} />
        </section>
      );
    case "price":
      return (
        <section className="aw-sheet aw-sens-sheet is-open" aria-label="Price">
          <SheetHead icon={PRICE_ICON} title={widget.title} tag={<LockTag />} />
          <SensFields
            rows={[
              { label: "Service", value: widget.data.service },
              ...(widget.data.extras === null ? [] : [{ label: "Extras", value: usdWhole(widget.data.extras) }]),
              { label: "Suggested", value: usdWhole(widget.data.suggested), wide: true },
            ]}
          />
          <AcceptReject onAccept={onAccept} onReject={onReject} />
        </section>
      );
    case "final_photo_confirm":
      return (
        <section className="aw-sheet aw-final-sheet is-open" aria-label="Final photo">
          <SheetHead icon={PHOTO_ICON} title={widget.title} />
          <div className="aw-final-photo">
            <SlotPhoto
              src={widget.data.photo}
              seed={<PlaceholderHand bg="#E6329B" skin="#FFD9EC" nail="#E6329B" tip="#8FE6F2" view="0 0 120 140" />}
            />
          </div>
          <p className="aw-final-q">Is this the final result?</p>
          <AcceptReject onAccept={onAccept} onReject={onReject} />
        </section>
      );
    case "final_result":
      return (
        <section className="aw-sheet aw-result-sheet is-open" aria-label="Final result">
          <SheetHead icon={IMAGE_ICON} title={widget.title} closeLabel="Close final result" onClose={onClose} />
          <div className="aw-result-card">
            <div className="aw-result-photo">
              <SlotPhoto
                src={widget.data.photo}
                seed={<PlaceholderHand bg="#E6329B" skin="#FFD9EC" nail="#E6329B" tip="#8FE6F2" view="0 0 120 140" gems />}
              />
            </div>
            {widget.data.description !== null && <p className="aw-result-text">{widget.data.description}</p>}
          </div>
          <div className="aw-result-close" data-l10n="muse">
            {MUSE_ICON}
            <span>Description generated by Muse Spark</span>
          </div>
        </section>
      );
    case "booked":
      return (
        <section className="aw-sheet aw-booked-sheet is-open" aria-label="Appointment booked">
          <SheetHead icon={CHECK_ICON} title={widget.title} />
          <SensFields
            rows={[
              { label: "Client", value: widget.data.client },
              { label: "Service", value: widget.data.service },
              { label: "Date", value: formatDay(widget.data.day) },
              { label: "Time", value: widget.data.time },
            ]}
          />
        </section>
      );
    case "session_summary":
      return (
        <section className="aw-sheet aw-summary-sheet is-open" aria-label="Session summary">
          <SheetHead icon={SUMMARY_ICON} title={widget.title} />
          <SummaryBody data={widget.data} />
        </section>
      );
    case "good_job":
    case "confirm":
      return null;
  }
}

function SummaryBody({ data }: { data: SessionSummaryData }) {
  return (
    <div className="aw-sum">
      {data.client !== null && (
        <p>
          <b>{data.client}</b>
          {data.date !== null && (
            <>
              {" · "}
              <span>{data.date}</span>
            </>
          )}
        </p>
      )}
      {(data.service !== null || data.extras.length > 0 || data.suggested !== null) && (
        <div className="aw-sum__sec">
          <b>Service</b>
          {data.service !== null && (
            <p>
              <span>{data.service.name}</span>
              <span>{usdWhole(data.service.price)}</span>
            </p>
          )}
          {data.extras.map((extra) => (
            <p key={extra.label}>
              <span>{extra.label}</span>
              <span>{usdWhole(extra.amount)}</span>
            </p>
          ))}
          {data.suggested !== null && (
            <p>
              <span>Suggested</span>
              <span>{usdWhole(data.suggested)}</span>
            </p>
          )}
        </div>
      )}
      {(data.timeTotal !== null || data.timeParts.length > 0) && (
        <div className="aw-sum__sec">
          <b>Time</b>
          {data.timeTotal !== null && (
            <p>
              <span>Total</span>
              <span>{data.timeTotal}</span>
            </p>
          )}
          {data.timeParts.map((part) => (
            <p key={part.label}>
              <span>{part.label}</span>
              <span>{part.time}</span>
            </p>
          ))}
        </div>
      )}
      {(data.charged !== null || data.costs.length > 0 || data.fixedDetail !== null) && (
        <div className="aw-sum__sec">
          <b>Cost</b>
          {data.charged !== null && (
            <p>
              <span>Charged</span>
              <span>{usdWhole(data.charged)}</span>
            </p>
          )}
          {data.costs.map((cost) => (
            <p key={cost.label}>
              <span>{cost.label}</span>
              <span>{usdWhole(cost.amount)}</span>
            </p>
          ))}
          {data.fixedDetail !== null && (
            <p>
              <span>Fixed</span>
              <span>{data.fixedDetail}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
