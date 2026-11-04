// Client-safe: photo slot URLs for the photos sheet. The reference photo
// resolves server-side from the real appointment row behind the session.
import type { PhotosData } from "@/lib/widget";

/** Served URL when the file exists, null on 404 or network failure. */
export async function probePhoto(
  fetchImpl: typeof fetch,
  file: string,
): Promise<string | null> {
  const url = `/api/photos?file=${encodeURIComponent(file)}`;
  try {
    const res = await fetchImpl(url);
    return res.ok ? url : null;
  } catch {
    return null;
  }
}

/** Appointment reference photo for the session, or null when it has none. */
export async function referencePhotoUrl(
  fetchImpl: typeof fetch,
  sessionId: number,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`/api/photos/reference?sessionId=${sessionId}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { photoUrl?: unknown };
    return typeof body.photoUrl === "string" && body.photoUrl !== "" ? body.photoUrl : null;
  } catch {
    return null;
  }
}

/** Real slot data for the photos sheet; missing files stay null. */
export async function loadPhotosData(
  sessionId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PhotosData> {
  const [before, reference, expected, final] = await Promise.all([
    probePhoto(fetchImpl, `pre_${sessionId}.jpg`),
    referencePhotoUrl(fetchImpl, sessionId),
    probePhoto(fetchImpl, `preview_${sessionId}.png`),
    probePhoto(fetchImpl, `post_${sessionId}.jpg`),
  ]);
  return { before, reference, expected, final };
}
