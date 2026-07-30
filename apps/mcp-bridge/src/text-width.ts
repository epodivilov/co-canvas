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
 * A font's advance widths describe the glyphs; a browser draws something else.
 * It rounds each advance to whole device pixels, it applies the pair kerning in
 * the font's `GPOS` table, and for a precomposed letter whose advance Excalifont
 * sets no wider than the bare base letter — `ľ` is given exactly the width of
 * `l` — it draws the mark anyway and charges for it. None of that is
 * recoverable from `hmtx` alone.
 *
 * Sized from measurement rather than from a guess. Every one of the 561
 * codepoints the shipped table covers was repeated to 400 characters and
 * measured against Chromium at 12, 16, 20, 28 and 36 px, with each subset
 * registered under its own `unicode-range` so the right face answers for each
 * glyph. The largest excess over the summed advances was 0.1913 em per
 * character — `ľ` at 12 px — followed by `j` at 0.1217 em, whose pairs kern
 * apart. Three codepoints exceed 0.12 em; one exceeds 0.14.
 *
 * The allowance is what keeps a stored label from being narrower than what a
 * browser draws. It is not free: a typical Latin label ends up 35–40 % wider
 * than the same string measured in a browser, so containers grow and labels
 * wrap sooner than they strictly need to. Over-measuring is the safe direction
 * — the alternative is text spilling out of its box — but a table derived from
 * a browser rather than from `hmtx` would buy most of that width back.
 */
export const WIDTH_SAFETY_EM = 0.2;

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
