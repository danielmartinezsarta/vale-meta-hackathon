import { describe, expect, it } from "vitest";
import { parseSseStream } from "./sse";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("SSE parser", () => {
  it("dispatches interim, final and done across awkward chunk splits", async () => {
    const seen: string[] = [];
    let done = false;
    const raw =
      'event: interim\ndata: {"transcript":"hel"}\n\n' +
      'event: interim\ndata: {"transcript":"hello"}\n\n' +
      'event: final\ndata: {"transcript":"hello","audioProcessedMs":800}\n\n' +
      "event: done\ndata: {}\n\n";
    const chunks = [raw.slice(0, 17), raw.slice(17, 55), raw.slice(55)];
    await parseSseStream(
      streamFromChunks(chunks),
      {
        onInterim: (text) => seen.push(`interim:${text}`),
        onFinal: (text, ms) => seen.push(`final:${text}:${ms}`),
        onDone: () => {
          done = true;
        },
      },
    );
    expect(seen).toEqual(["interim:hel", "interim:hello", "final:hello:800"]);
    expect(done).toBe(true);
  });

  it("dispatches ignored turns", async () => {
    let ignored = 0;
    let done = false;
    await parseSseStream(streamFromChunks(["event: ignored\ndata: {}\n\n"]), {
      onIgnored: () => {
        ignored += 1;
      },
      onDone: () => {
        done = true;
      },
    });
    expect(ignored).toBe(1);
    expect(done).toBe(false);
  });

  it("dispatches board snapshots", async () => {
    const seen: unknown[] = [];
    const raw =
      'event: board\ndata: {"board":{"session":null,"card":null,"list":["Esmalte rojo"]}}\n\n';
    await parseSseStream(streamFromChunks([raw]), {
      onBoard: (board) => seen.push(board),
    });
    expect(seen).toEqual([{ session: null, card: null, list: ["Esmalte rojo"] }]);
  });

  it("dispatches widget cards and clears", async () => {
    const seen: unknown[] = [];
    const raw =
      'event: widget\ndata: {"widget":{"kind":"meta","title":"Month goal","lines":["120.00 USD"]}}\n\n' +
      'event: widget\ndata: {"widget":null}\n\n';
    await parseSseStream(streamFromChunks([raw]), {
      onWidget: (widget) => seen.push(widget),
    });
    expect(seen).toEqual([
      { kind: "meta", title: "Month goal", lines: ["120.00 USD"] },
      null,
    ]);
  });

  it("ignores unknown events and malformed data", async () => {
    const seen: string[] = [];
    const raw =
      "event: audioProgress\ndata: {}\n\n" +
      "event: interim\ndata: not-json\n\n" +
      'event: error\ndata: {"message":"boom"}\n\n';
    const errors: string[] = [];
    await parseSseStream(streamFromChunks([raw]), {
      onInterim: (text) => seen.push(text),
      onErrorEvent: (message) => errors.push(message),
    });
    expect(seen).toEqual([]);
    expect(errors).toEqual(["boom"]);
  });
});
