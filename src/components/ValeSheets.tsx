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
import { formatDay, formatVisit, initials, usdWhole } from "@/lib/widget";

/** The lock tag: sensitive data stays on screen, never spoken. */
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

function ClientFileTag() {
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
          <path d="M3.5 7.5A2 2 0 015.5 5.5h4l2 2.5h7a2 2 0 012 2v7.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />
        </g>
      </svg>
      Client file
    </span>
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

const HEART_ICON = (
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

const CAM_ICON = (
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

const PHOTOS_ICON = (
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
      d="M5.5 12.5l4.2 4.2L18.5 7.5"
      pathLength="1"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CHECK_PLAIN_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </g>
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

const CAKE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.500h14V19H5z" />
      <path d="M5 15.500c2 1.500 3 1.500 4.500 0s3.500-1.500 5 0 3 1.500 4.500 0M12 12.500V9.500M12 7.500v.1" />
    </g>
  </svg>
);

const PHONE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6.5 4h3l1.5 4-2 1.3a10 10 0 005.7 5.7L16 13l4 1.5v3a2 2 0 01-2.2 2A15.5 15.5 0 014.500 6.200 2 2 0 016.500 4z" />
    </g>
  </svg>
);

const EMAIL_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="5.5" width="17" height="13" rx="3" />
      <path d="M4 8l8 5.500L20 8" />
    </g>
  </svg>
);

function Grab() {
  return <div className="aw-grab" aria-hidden="true" />;
}

function SheetHead({
  icon,
  title,
  tag,
  closeClass,
  closeLabel,
  onClose,
}: {
  icon?: React.ReactNode;
  title: string;
  tag?: React.ReactNode;
  closeClass?: string;
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
      {closeClass && closeLabel && onClose && (
        <button
          className={`aw-btn ${closeClass}`}
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
      <button className="aw-act aw-reject" type="button" onClick={onReject}>
        Reject
      </button>
      <button className="aw-act aw-accept" type="button" onClick={onAccept}>
        Accept
      </button>
    </div>
  );
}

/** Design placeholder hand: real photos replace it slot by slot. */
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
          <path d="M104 18l2.2 6 2.2-6 2.2-2.2-2.2-2.2-2.2-6-2.2 6-6 2.2 6 2.2z" />
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

function SlotPhoto({
  src,
  seed,
  cover,
}: {
  src: string | null;
  seed: React.ReactNode;
  cover?: boolean;
}) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden="true"
      style={{
        display: "block",
        width: "100%",
        height: cover ? "100%" : "auto",
        objectFit: cover ? "cover" : undefined,
      }}
    />
  ) : (
    seed
  );
}

const CARE_ITEMS = [
  {
    label: "Water",
    path: (
      <>
        <path d="M24 7c-6.500 8-12 14-12 22a12 12 0 0024 0c0-8-5.500-14-12-22z" />
        <path d="M17.500 31a7 7 0 004.500 6.500" />
      </>
    ),
  },
  {
    label: "Food",
    path: (
      <>
        <path d="M24 17c-5-4.500-14-1.500-14 10 0 9.500 6 20 11 20 1.500 0 2-1 3-1s1.500 1 3 1c5 0 11-10.500 11-20 0-11.500-9-14.500-14-10z" />
        <path d="M24 17c0-4.500 2-8 5.500-9.500" />
      </>
    ),
  },
  {
    label: "Stretch",
    path: (
      <>
        <circle cx="24" cy="10" r="4.500" />
        <path d="M24 15.500V34" />
        <path d="M24 21L13 9M24 21L35 9" />
        <path d="M24 34l-7 15M24 34l7 15" />
      </>
    ),
  },
];

/** Good-job overlay: the three care icons, the design markup. The caption zone shows the text. */
export function CareOverlay() {
  return (
    <div className="aw--session is-closing">
      <div className="aw-care" aria-live="polite">
        {CARE_ITEMS.map((item) => (
          <figure className="aw-care__item" key={item.label}>
            <svg viewBox="0 0 48 56" aria-hidden="true">
              <g
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {item.path}
              </g>
            </svg>
            <figcaption>{item.label}</figcaption>
          </figure>
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
  onPhotos?: () => void;
}

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
          {data.birthday !== null && (
            <small>
              {CAKE_ICON}Birthday · {data.birthday}
            </small>
          )}
        </div>
      </div>
      <SexSeg sex={data.sex} />
      {data.phone !== null && (
        <div className="aw-cc__row">
          {PHONE_ICON}
          <span>{data.phone}</span>
        </div>
      )}
      {data.email !== null && (
        <div className="aw-cc__row">
          {EMAIL_ICON}
          <span>{data.email}</span>
        </div>
      )}
      {data.healthNotes.length > 0 && (
        <div className="aw-cc__alert" role="note">
          <div className="aw-cc__h">
            <b>
              {HEART_ICON}Health
            </b>
            <span className="aw-cc__lock">
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
                  aria-label={`${formatVisit(visit.date)}, ${visit.service}: open the photos of this visit`}
                  onClick={() => onVisit?.(visit.date)}
                >
                  <span>{formatVisit(visit.date)}</span>
                  <span>{visit.service}</span>
                  {visit.photo !== null && CAM_ICON}
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
    if (
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
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

/**
 * Photos sheet, no placeholders: a slot without a real image is not
 * rendered at all. One image goes full width; Before + Reference share the
 * 2-up row; Expected (or Final, which replaces it) always goes full width
 * below, with the Muse Image credit only under the Expected preview.
 */
function PhotosBody({ data }: { data: PhotosData }) {
  const result =
    data.final !== null
      ? { slot: "final", label: "Final", src: data.final, credit: false }
      : data.expected !== null
        ? { slot: "expected", label: "Expected", src: data.expected, credit: true }
        : null;
  const tiles = [
    data.before !== null ? { slot: "before", label: "Before", src: data.before } : null,
    data.reference !== null ? { slot: "reference", label: "Reference", src: data.reference } : null,
  ].filter((tile) => tile !== null);
  const solo = tiles.length + (result === null ? 0 : 1) === 1;
  return (
    <div className="aw-pics">
      {tiles.map((tile) => (
        <div
          key={tile.slot}
          className={solo ? "aw-pic aw-pic--solo" : "aw-pic"}
          data-slot={tile.slot}
        >
          <span className="aw-pic__tag">{tile.label}</span>
          <div className="aw-pic__img">
            <SlotPhoto src={tile.src} seed={null} cover />
          </div>
        </div>
      ))}
      {result !== null && (
        <div className="aw-pic aw-pic--wide" data-slot={result.slot}>
          <span className="aw-pic__tag">{result.label}</span>
          <div className="aw-pic__img">
            <SlotPhoto src={result.src} seed={null} cover />
          </div>
          {result.credit && (
            <div className="aw-pics__note" data-l10n="muse">
              {MUSE_ICON}
              <span>Preview generated by Muse Image</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
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

/** The sheet mounts only while its widget is set, so mount means open. */
function useSheetOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof requestAnimationFrame !== "undefined") {
      const id = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(id);
    }
    const id = window.setTimeout(() => setOpen(true), 0);
    return () => window.clearTimeout(id);
  }, []);
  return open;
}

/** The sheet per widget kind; confirm keeps the legacy card elsewhere. */
export function ValeSheets({ widget, ...callbacks }: { widget: Widget } & SheetCallbacks) {
  const { onClose, onAccept, onReject, onChoose, onVisit } = callbacks;
  const open = useSheetOpen();
  const sheet = (base: string): string => (open ? `${base} is-open` : base);
  switch (widget.kind) {
    case "client_card":
      return (
        <section className={sheet("aw-sheet aw-card-sheet")} role="dialog" aria-label="Client card">
          <SheetHead icon={PERSON_ICON} title={widget.title} closeClass="aw-card-close" closeLabel="Close client card" onClose={onClose} />
          <CardBody data={widget.data} onVisit={onVisit} />
        </section>
      );
    case "goal":
      return (
        <section className={sheet("aw-sheet aw-goal-sheet")} role="dialog" aria-label="Monthly goal">
          <Grab />
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
        <section className={sheet("aw-sheet aw-cam-sheet")} role="dialog" aria-label="Save photo as">
          <Grab />
          <div className="aw-sheet__head">
            <span className="aw-sheet__ic" aria-hidden="true">
              {CAM_ICON}
            </span>
            <h2 className="aw-sheet__title">Save photo as</h2>
            <ClientFileTag />
          </div>
          <div className="aw-choices">
            <button className="aw-choice" type="button" data-photo="before" onClick={() => onChoose?.("before")}>
              <span className="aw-choice__n" aria-hidden="true">
                1
              </span>
              <span className="aw-choice__t">
                <b>Before</b>
                <small>Before the service starts</small>
              </span>
            </button>
            <button className="aw-choice" type="button" data-photo="final" onClick={() => onChoose?.("final")}>
              <span className="aw-choice__n" aria-hidden="true">
                2
              </span>
              <span className="aw-choice__t">
                <b>Final photo</b>
                <small>Result of the session</small>
              </span>
            </button>
          </div>
        </section>
      );
    case "photos":
      return (
        <section className={sheet("aw-sheet aw-pics-sheet")} role="dialog" aria-label="Photos">
          <Grab />
          <SheetHead icon={PHOTOS_ICON} title={widget.title} tag={<ClientFileTag />} closeClass="aw-pics-close" closeLabel="Close photos" onClose={onClose} />
          <PhotosBody data={widget.data} />
        </section>
      );
    case "health_note":
      return (
        <section className={sheet("aw-sheet aw-sens-sheet")} role="dialog" aria-label="Health note">
          <Grab />
          <SheetHead title={widget.title} tag={<LockTag />} />
          <SensFields rows={[{ label: "Note", value: widget.data.text, wide: true }, { label: "Client", value: widget.data.client }]} />
        </section>
      );
    case "note":
      return (
        <section className={sheet("aw-sheet aw-sens-sheet")} role="dialog" aria-label="Note saved">
          <Grab />
          <SheetHead title={widget.title} />
          <SensFields rows={[{ label: "Note", value: widget.data.text, wide: true }, { label: "Client", value: widget.data.client }]} />
        </section>
      );
    case "price":
      return (
        <section className={sheet("aw-sheet aw-sens-sheet")} role="dialog" aria-label="Price">
          <Grab />
          <SheetHead title={widget.title} tag={<LockTag />} />
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
        <section className={sheet("aw-sheet aw-final-sheet")} role="dialog" aria-label="Save final photo">
          <Grab />
          <div className="aw-sheet__head">
            <span className="aw-sheet__ic" aria-hidden="true">
              {CAM_ICON}
            </span>
            <h2 className="aw-sheet__title">Final photo</h2>
            <ClientFileTag />
          </div>
          <div className="aw-final-photo" data-final-photo="confirm">
            <SlotPhoto
              src={widget.data.photo}
              seed={<PlaceholderHand bg="#E6329B" skin="#FFD9EC" nail="#E6329B" tip="#8FE6F2" view="0 0 120 140" />}
            />
          </div>
          <p className="aw-final-q">Save this photo as the final result of the job?</p>
          <AcceptReject onAccept={onAccept} onReject={onReject} />
        </section>
      );
    case "final_result":
      return (
        <section className={sheet("aw-sheet aw-result-sheet")} role="dialog" aria-label="Final result">
          <div className="aw-sheet__head">
            <span className="aw-sheet__ic" aria-hidden="true">
              {CHECK_PLAIN_ICON}
            </span>
            <h2 className="aw-sheet__title">Final result</h2>
            {onClose && (
              <button className="aw-btn aw-result-close" type="button" aria-label="Close final result" onClick={onClose}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M6.5 6.5l11 11" />
                    <path d="M17.5 6.5l-11 11" />
                  </g>
                </svg>
              </button>
            )}
          </div>
          <div className="aw-result-photo" data-final-photo="result">
            <SlotPhoto
              src={widget.data.photo}
              seed={<PlaceholderHand bg="#E6329B" skin="#FFD9EC" nail="#E6329B" tip="#8FE6F2" view="0 0 120 140" gems />}
              cover
            />
          </div>
          <div className="aw-result-card">
            <small>Job description</small>
            {widget.data.description !== null && <p className="aw-result-text">{widget.data.description}</p>}
            <span className="aw-muse">
              {MUSE_ICON}Description generated by Muse Spark
            </span>
          </div>
        </section>
      );
    case "booked":
      return (
        <section className={sheet("aw-sheet aw-booked")} role="status" aria-label="Appointment booked">
          <Grab />
          <div className="aw-sheet__head">
            <span className="aw-booked__check" aria-hidden="true">
              {CHECK_ICON}
            </span>
            <h2 className="aw-sheet__title">Appointment booked</h2>
          </div>
          <div className="aw-fields">
            <div className="aw-field">
              <small>Client</small>
              <b className="aw-booked__client">{widget.data.client}</b>
            </div>
            <div className="aw-field">
              <small>Service</small>
              <b className="aw-booked__service">{widget.data.service}</b>
            </div>
            <div className="aw-field aw-field--wide">
              <small>Date</small>
              <b className="aw-booked__date">{formatDay(widget.data.day)}</b>
            </div>
            <div className="aw-field aw-field--wide">
              <small>Time</small>
              <b className="aw-booked__time">{widget.data.time}</b>
            </div>
          </div>
        </section>
      );
    case "session_summary":
      return (
        <section className={sheet("aw-sheet aw-summary-sheet")} role="dialog" aria-label="Session summary">
          <SheetHead icon={SUMMARY_ICON} title={widget.title} />
          <SummaryBody data={widget.data} />
        </section>
      );
    case "good_job":
    case "confirm":
      return null;
    default:
      return null;
  }
}
