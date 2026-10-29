import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ValeBoard } from "./ValeBoard";
import { PRIVATE_NOTE_LABEL } from "@/lib/db";
import type { Board } from "@/lib/board";

const board: Board = {
  session: { clientName: "Ana Beltran", serviceName: "Retiro de gel", startedAt: new Date().toISOString() },
  card: {
    name: "Ana Beltran",
    notes: [
      { id: 1, kind: "general", text: "prefiere viernes", masked: false },
      { id: 2, kind: "health", text: null, masked: true },
    ],
  },
  list: ["Esmalte rojo"],
};

describe("ValeBoard", () => {
  afterEach(() => cleanup());
  it("renders nothing without a board", () => {
    const { container } = render(<ValeBoard board={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the session, the card and the list", () => {
    render(<ValeBoard board={board} />);
    expect(screen.getByRole("heading", { name: "Sesión en curso" })).toBeDefined();
    expect(screen.getAllByText(/Ana Beltran/)).toHaveLength(2);
    expect(screen.getByText(/Retiro de gel/)).toBeDefined();
    expect(screen.getByRole("heading", { name: "Ficha de Ana Beltran" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Lista de compras" })).toBeDefined();
    expect(screen.getByText("Esmalte rojo")).toBeDefined();
  });

  it("masks private notes with the shared label and no text", () => {
    render(<ValeBoard board={board} />);
    expect(screen.getByText(PRIVATE_NOTE_LABEL)).toBeDefined();
    expect(screen.getByText("prefiere viernes")).toBeDefined();
  });

  it("shows the empty states", () => {
    render(<ValeBoard board={{ session: null, card: null, list: [] }} />);
    expect(screen.getByText("Sin sesión abierta.")).toBeDefined();
    expect(screen.getByText("La lista está vacía.")).toBeDefined();
  });
});
