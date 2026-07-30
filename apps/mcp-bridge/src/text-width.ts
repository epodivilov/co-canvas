/**
 * How wide a line of text is, without a browser to ask.
 *
 * Everything else about text — wrapping, height, how far a container has to
 * grow — comes from Excalidraw once this is registered through its
 * `setCustomTextMetricsProvider` seam. Width is the one thing the headless
 * route cannot borrow, because upstream measures glyphs through a canvas.
 */
import {
  EXCALIFONT_FALLBACK_ADVANCE,
  EXCALIFONT_UNITS_PER_EM,
  excalifontAdvances,
} from "./excalifont-advances.ts";

/**
 * Extra width allowed per character, in em.
 *
 * A font's advance widths describe the glyphs; a browser draws something
 * slightly different. It rounds each advance to whole device pixels and applies
 * the pair kerning in the font's `GPOS` table, and neither is recoverable from
 * the plain metrics. Measured against Chromium's `measureText` over every
 * printable-ASCII glyph of Excalifont at 16, 20, 28 and 36 px, in runs of 1, 2,
 * 5, 10 and 20, the browser never exceeded the summed advances by more than
 * 0.117 em per character — worst case `j`, whose pairs kern apart.
 *
 * The allowance is what keeps a stored label from ever being narrower than what
 * a browser draws, at the price of containers roughly a tenth wider than a
 * person typing the same label would get.
 */
export const WIDTH_SAFETY_EM = 0.12;

/**
 * The width of one line, in pixels.
 *
 * The signature is Excalidraw's `TextMetricsProvider.getLineWidth`: it is
 * handed a CSS font shorthand and reads the size off the front of it, exactly
 * as upstream's own `measureText` does with `parseFloat`.
 *
 * Only Excalifont's metrics are known, and only Excalifont can be asked for
 * through the bridge's skeleton schema. A font string naming anything else is
 * still measured against this table rather than refused: over-measuring is the
 * safe direction, and refusing would break a scene a person had restyled.
 */
export function measureLineWidth(text: string, fontString: string): number {
  const fontSize = Number.parseFloat(fontString);
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    throw new Error(`cannot measure text against font string ${JSON.stringify(fontString)}`);
  }

  const advances = excalifontAdvances();
  let units = 0;
  let characters = 0;
  // Iterated by codepoint rather than by UTF-16 unit, so an astral character
  // counts once and is looked up by the value the font's cmap uses.
  for (const character of text) {
    units += advances.get(character.codePointAt(0) ?? 0) ?? EXCALIFONT_FALLBACK_ADVANCE;
    characters += 1;
  }

  return (units * fontSize) / EXCALIFONT_UNITS_PER_EM + characters * WIDTH_SAFETY_EM * fontSize;
}
