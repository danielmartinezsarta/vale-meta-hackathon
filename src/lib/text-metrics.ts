/**
 * Left side bearing of a text run: how far the ink starts left of the
 * cursor. Used to align the slogan under the word. Zero when unmeasurable.
 */
export function leftBearing(text: string, font: string): number {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return 0;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = font;
    return ctx.measureText(text).actualBoundingBoxLeft ?? 0;
  } catch {
    return 0;
  }
}
