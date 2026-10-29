"use client";

import { useEffect, useState } from "react";
import type { Board } from "@/lib/board";

function elapsedSince(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function SessionBlock({ clientName, serviceName, startedAt }: { clientName: string; serviceName: string; startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <section aria-label="Sesión en curso">
      <h2>Sesión en curso</h2>
      <p>
        {clientName} · {serviceName} · {elapsedSince(startedAt, now)}
      </p>
    </section>
  );
}

export function ValeBoard({ board }: { board: Board | null }) {
  if (!board) return null;
  return (
    <div>
      {board.session ? (
        <SessionBlock
          clientName={board.session.clientName}
          serviceName={board.session.serviceName}
          startedAt={board.session.startedAt}
        />
      ) : (
        <section aria-label="Sesión en curso">
          <h2>Sesión en curso</h2>
          <p>Sin sesión abierta.</p>
        </section>
      )}

      {board.card && (
        <section aria-label="Ficha de clienta">
          <h2>Ficha de {board.card.name}</h2>
          {board.card.notes.length === 0 ? (
            <p>Sin notas.</p>
          ) : (
            <ul>
              {board.card.notes.map((note) => (
                <li key={note.id}>{note.masked || note.text === null ? "nota privada 🔒" : note.text}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-label="Lista de compras">
        <h2>Lista de compras</h2>
        {board.list.length === 0 ? (
          <p>La lista está vacía.</p>
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
