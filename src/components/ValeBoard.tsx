"use client";

import { useEffect, useState } from "react";
import type { Board } from "@/lib/board";
import { uiStrings } from "@/lib/vale-ui";
import type { ValeLanguage } from "@/lib/vale-language";

function elapsedSince(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function SessionBlock({ clientName, serviceName, startedAt, language }: { clientName: string; serviceName: string; startedAt: string; language: ValeLanguage }) {
  const [now, setNow] = useState(() => Date.now());
  const ui = uiStrings(language);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <section aria-label={ui.sessionNow}>
      <h2>{ui.sessionNow}</h2>
      <p>
        {clientName} · {serviceName} · {elapsedSince(startedAt, now)}
      </p>
    </section>
  );
}

export function ValeBoard({ board, language = "es" }: { board: Board | null; language?: ValeLanguage }) {
  if (!board) return null;
  const ui = uiStrings(language);
  return (
    <div>
      {board.session ? (
        <SessionBlock
          clientName={board.session.clientName}
          serviceName={board.session.serviceName}
          startedAt={board.session.startedAt}
          language={language}
        />
      ) : (
        <section aria-label={ui.session}>
          <h2>{ui.session}</h2>
          <p>{ui.noSessionOpen}</p>
        </section>
      )}

      {board.card && (
        <section aria-label={ui.cardFor(board.card.name)}>
          <h2>{ui.cardFor(board.card.name)}</h2>
          {board.card.notes.length === 0 ? (
            <p>{ui.noNotes}</p>
          ) : (
            <ul>
              {board.card.notes.map((note) => (
                <li key={note.id}>{note.masked || note.text === null ? ui.privateNote : note.text}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-label={ui.shoppingList}>
        <h2>{ui.shoppingList}</h2>
        {board.list.length === 0 ? (
          <p>{ui.emptyList}</p>
        ) : (
          <ul>
            {board.list.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
