"use client";

// Tiny fetch layer for the management screens over /api/manage.
export interface ManageResult<T = unknown> {
  ok: boolean;
  message: string;
  data?: T;
}

export async function manageGet<T>(entity: string, query = ""): Promise<T> {
  const res = await fetch(`/api/manage/${entity}${query}`);
  if (!res.ok) throw new Error(`Could not load ${entity}.`);
  return (await res.json()) as T;
}

export async function managePost<T>(entity: string, body: unknown): Promise<ManageResult<T>> {
  const res = await fetch(`/api/manage/${entity}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as ManageResult<T>;
  if (!res.ok) throw new Error(data.message || `Could not save ${entity}.`);
  return data;
}

export async function manageDelete<T>(entity: string, query: string): Promise<ManageResult<T>> {
  const res = await fetch(`/api/manage/${entity}${query}`, { method: "DELETE" });
  const data = (await res.json()) as ManageResult<T>;
  if (!res.ok) throw new Error(data.message || `Could not delete ${entity}.`);
  return data;
}
