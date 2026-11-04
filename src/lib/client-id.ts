// Stable per-browser id, shared by the voice turns and the replay pill:
// generated once, then reused from localStorage.
export function getValeClientId(): string {
  if (typeof window === "undefined") return "unknown";
  try {
    const stored = window.localStorage.getItem("vale-client");
    if (stored !== null && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(stored)) {
      return stored;
    }
    const fresh =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
    window.localStorage.setItem("vale-client", fresh);
    return fresh;
  } catch {
    return "unknown";
  }
}
