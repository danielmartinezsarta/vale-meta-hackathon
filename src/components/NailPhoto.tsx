"use client";

import { useState } from "react";
import type { NailRecord } from "@/lib/nails";

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the photo."));
    reader.readAsDataURL(file);
  });
}

export function NailPhoto() {
  const [photo, setPhoto] = useState<string | null>(null);
  const [record, setRecord] = useState<NailRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    if (!photo || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/nails", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: photo, client: "Invented demo client" }),
      });
      const body = (await res.json()) as {
        record?: NailRecord;
        error?: string;
      };
      if (!res.ok || !body.record) {
        setError(body.error ?? "Nail analysis failed.");
        return;
      }
      setRecord(body.record);
    } catch {
      setError("Nail analysis failed. Try again later.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Finished nails photo">
      <h2>Finished nails</h2>
      <p>
        Take a photo of the finished nails. Each nail is cut out and described
        by design and finish only.
      </p>
      <input
        type="file"
        accept="image/*"
        aria-label="Nails photo"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setRecord(null);
          setError(null);
          setPhoto(await toDataUrl(file));
        }}
      />
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo} alt="Finished nails preview" width={240} />
      ) : null}
      <div>
        <button type="button" disabled={!photo || busy} onClick={analyze}>
          {busy ? "Analyzing…" : "Analyze nails"}
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {record ? (
        <div>
          <p>
            Found {record.nailCount} nails. Saved on the open session.
          </p>
          <ul>
            {record.nails.map((nail, index) => (
              <li key={index}>{nail.description}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
