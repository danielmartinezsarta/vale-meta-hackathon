import { vi } from "vitest";

/**
 * Shared /voice stub: one transport means every session needs an open
 * conversation socket, so tests stub it open instead of hiding WebSocket.
 * The socket opens on the next microtask (after the component assigns its
 * handlers), which also works under fake timers once time advances.
 */
export class FakeVoiceSocket {
  static instances: FakeVoiceSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  binaryType = "";
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];
  constructor(url: string) {
    this.url = url;
    FakeVoiceSocket.instances.push(this);
    void Promise.resolve().then(() => {
      this.onopen?.();
    });
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  serverMessage(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  sentStrings(): string[] {
    return this.sent.filter((item) => typeof item === "string") as string[];
  }
  sentBinaryCount(): number {
    return this.sent.filter((item) => item instanceof ArrayBuffer).length;
  }
}

export function stubVoiceSocket(): void {
  FakeVoiceSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeVoiceSocket as unknown as typeof WebSocket);
}
