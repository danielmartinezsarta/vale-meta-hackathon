// Echo of Vale's own reply coming back through the mic. Shared by the
// server bridge (gate:eco, no Spark call) and the browser client (voice
// barge-in cuts only speech that does NOT resemble what she says).

export const ECHO_MIN_TOKENS = 5;
export const ECHO_OVERLAP = 0.8;

export const echoNorm = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü ]/gi, " ")
    .split(" ")
    .filter((word) => word !== "")
    .join(" ");

/**
 * Her own reply through the mic: same words, no Spark call. Exact match at
 * any length, or a long transcript mostly inside the reply. Short talk
 * ("yes", "confirm it") never counts: it stays a real turn.
 */
export const isEchoOfReply = (
  transcript: string,
  reply: string | null,
): boolean => {
  if (!reply) return false;
  if (echoNorm(transcript) === echoNorm(reply)) return true;
  const heard = echoNorm(transcript).split(" ");
  if (heard.length < ECHO_MIN_TOKENS) return false;
  const said = new Set(echoNorm(reply).split(" "));
  if (said.size === 0) return false;
  const hit = heard.filter((word) => said.has(word)).length;
  return hit / heard.length >= ECHO_OVERLAP;
};

/**
 * Client-side resemblance for partial (interim) transcripts: the server rule
 * above, plus short fragments fully contained in the reply ("Vale, booking"
 * while she says "Vale, booking Ana for noon"). A short fragment with any
 * word outside the reply ("Vale, book it") is a real interrupt, not echo.
 */
export const resemblesReply = (
  heardText: string,
  reply: string | null,
): boolean => {
  if (!reply) return false;
  if (isEchoOfReply(heardText, reply)) return true;
  const heard = echoNorm(heardText).split(" ").filter((word) => word !== "");
  if (heard.length === 0 || heard.length >= ECHO_MIN_TOKENS) return false;
  const said = new Set(
    echoNorm(reply).split(" ").filter((word) => word !== ""),
  );
  return heard.every((word) => said.has(word));
};
