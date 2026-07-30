/**
 * Regenerates `src/excalifont-advances.ts` from the font files Excalidraw ships.
 *
 * Run it after bumping `@excalidraw/excalidraw`:
 *
 *     node scripts/derive-excalifont-advances.mjs
 *
 * Excalidraw measures text through a browser canvas, which the bridge does not
 * have, so the bridge measures it from the font's own horizontal metrics
 * instead. The metrics live in seven WOFF2 subsets under
 * `dist/prod/fonts/Excalifont`; this reads each one's `cmap` and `hmtx` tables
 * and writes out one codepoint-to-advance table covering all of them.
 *
 * WOFF2 is a Brotli-compressed wrapper around the sfnt tables, and Node can do
 * Brotli, so no font library is involved. Only `cmap`, `head`, `hhea`, `hmtx`
 * and `maxp` are read, and none of those is ever transformed in a way that
 * moves the advance widths off the front of `hmtx`.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

/** Table tags a WOFF2 directory entry can name by index instead of by tag. */
const KNOWN_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
];

function readUIntBase128(buffer, offset) {
  let value = 0;
  let cursor = offset;
  for (let i = 0; i < 5; i++) {
    const byte = buffer[cursor];
    cursor += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value >>> 0, cursor];
  }
  throw new Error("malformed UIntBase128");
}

/** The sfnt tables of a WOFF2 file, keyed by tag. */
function readWoff2Tables(path) {
  const file = readFileSync(path);
  if (file.toString("latin1", 0, 4) !== "wOF2") throw new Error(`${path} is not WOFF2`);

  const tableCount = file.readUInt16BE(12);
  let cursor = 48;
  const directory = [];
  for (let i = 0; i < tableCount; i++) {
    const flags = file[cursor];
    cursor += 1;
    const knownIndex = flags & 0x3f;
    let tag;
    if (knownIndex === 63) {
      tag = file.toString("latin1", cursor, cursor + 4);
      cursor += 4;
    } else {
      tag = KNOWN_TAGS[knownIndex];
    }
    const transformVersion = (flags >> 6) & 0x03;
    let originalLength;
    [originalLength, cursor] = readUIntBase128(file, cursor);
    // `glyf` and `loca` are transformed unless the version says otherwise;
    // every other table is untransformed unless the version says otherwise.
    const transformed =
      tag === "glyf" || tag === "loca" ? transformVersion !== 3 : transformVersion !== 0;
    let storedLength = originalLength;
    if (transformed) [storedLength, cursor] = readUIntBase128(file, cursor);
    directory.push({ tag, transformed, storedLength });
  }

  const stream = brotliDecompressSync(file.subarray(cursor));
  const tables = new Map();
  let offset = 0;
  for (const entry of directory) {
    tables.set(entry.tag, {
      transformed: entry.transformed,
      data: stream.subarray(offset, offset + entry.storedLength),
    });
    offset += entry.storedLength;
  }
  return tables;
}

/** Advance width per glyph id, in font units. */
function readAdvances(tables) {
  const glyphCount = tables.get("maxp").data.readUInt16BE(4);
  const metricCount = tables.get("hhea").data.readUInt16BE(34);
  const hmtx = tables.get("hmtx");
  const advances = new Array(glyphCount);
  // A transformed `hmtx` drops the side-bearing arrays but keeps the advance
  // widths, still first and still one uint16 each; an untransformed one
  // interleaves them with the left side bearings.
  const stride = hmtx.transformed ? 2 : 4;
  const start = hmtx.transformed ? 1 : 0;
  for (let glyph = 0; glyph < metricCount; glyph++) {
    advances[glyph] = hmtx.data.readUInt16BE(start + glyph * stride);
  }
  // Monospaced tails repeat the last advance.
  for (let glyph = metricCount; glyph < glyphCount; glyph++) {
    advances[glyph] = advances[metricCount - 1];
  }
  return advances;
}

/** Codepoint to glyph id, from the widest cmap subtable the font offers. */
function readCmap(tables) {
  const cmap = tables.get("cmap").data;
  const subtableCount = cmap.readUInt16BE(2);
  let best = null;
  for (let i = 0; i < subtableCount; i++) {
    const record = 4 + i * 8;
    const platformId = cmap.readUInt16BE(record);
    const offset = cmap.readUInt32BE(record + 4);
    const format = cmap.readUInt16BE(offset);
    const score = (format === 12 ? 100 : format === 4 ? 50 : 0) + (platformId === 3 ? 10 : 0);
    if (best === null || score > best.score) best = { score, offset, format };
  }
  if (best === null) throw new Error("font has no cmap subtable");

  const mapping = new Map();
  if (best.format === 4) {
    const base = best.offset;
    const segmentCount = cmap.readUInt16BE(base + 6) / 2;
    const endCodes = base + 14;
    const startCodes = endCodes + segmentCount * 2 + 2;
    const deltas = startCodes + segmentCount * 2;
    const rangeOffsets = deltas + segmentCount * 2;
    for (let segment = 0; segment < segmentCount; segment++) {
      const end = cmap.readUInt16BE(endCodes + segment * 2);
      const start = cmap.readUInt16BE(startCodes + segment * 2);
      const delta = cmap.readInt16BE(deltas + segment * 2);
      const rangeOffset = cmap.readUInt16BE(rangeOffsets + segment * 2);
      if (start === 0xffff) continue;
      for (let code = start; code <= end; code++) {
        let glyph;
        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xffff;
        } else {
          const at = rangeOffsets + segment * 2 + rangeOffset + (code - start) * 2;
          if (at + 1 >= cmap.length) continue;
          glyph = cmap.readUInt16BE(at);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) mapping.set(code, glyph);
      }
    }
  } else if (best.format === 12) {
    const base = best.offset;
    const groupCount = cmap.readUInt32BE(base + 12);
    for (let group = 0; group < groupCount; group++) {
      const at = base + 16 + group * 12;
      const startCode = cmap.readUInt32BE(at);
      const endCode = cmap.readUInt32BE(at + 4);
      const startGlyph = cmap.readUInt32BE(at + 8);
      for (let code = startCode; code <= endCode; code++) {
        mapping.set(code, startGlyph + (code - startCode));
      }
    }
  } else {
    throw new Error(`unsupported cmap format ${best.format}`);
  }
  return mapping;
}

// Reached through the filesystem rather than through `require.resolve`: the
// package's `exports` map does not expose `package.json`, let alone `dist/*`.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "node_modules", "@excalidraw", "excalidraw");
const fontDir = join(packageRoot, "dist", "prod", "fonts", "Excalifont");
const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;

const advanceByCodepoint = new Map();
let unitsPerEm = 0;
for (const file of readdirSync(fontDir).sort()) {
  if (!file.endsWith(".woff2")) continue;
  const tables = readWoff2Tables(join(fontDir, file));
  const perFile = tables.get("head").data.readUInt16BE(18);
  if (unitsPerEm !== 0 && unitsPerEm !== perFile) {
    throw new Error("Excalifont subsets disagree about unitsPerEm");
  }
  unitsPerEm = perFile;
  const advances = readAdvances(tables);
  for (const [codepoint, glyph] of readCmap(tables)) {
    const advance = advances[glyph];
    const known = advanceByCodepoint.get(codepoint);
    if (known !== undefined && known !== advance) {
      throw new Error(`subsets disagree about U+${codepoint.toString(16)}`);
    }
    advanceByCodepoint.set(codepoint, advance);
  }
}

const codepoints = [...advanceByCodepoint.keys()].sort((a, b) => a - b);
const pairs = codepoints.map((code) => `${code}:${advanceByCodepoint.get(code)}`);
const chunks = [];
for (let i = 0; i < pairs.length; i += 12) chunks.push(pairs.slice(i, i + 12).join(","));

const source = `// Generated by scripts/derive-excalifont-advances.mjs from
// @excalidraw/excalidraw@${version}. Do not edit by hand.

/** Design units per em of Excalifont; every advance below is in these units. */
export const EXCALIFONT_UNITS_PER_EM = ${unitsPerEm};

/**
 * Widest advance in the table, used for codepoints Excalifont has no glyph for.
 *
 * Over-measuring an unknown character is the safe direction: the label gets a
 * container that is too roomy rather than one the text spills out of.
 */
export const EXCALIFONT_FALLBACK_ADVANCE = ${Math.max(...advanceByCodepoint.values())};

/**
 * Advance width per codepoint, as \`codepoint:advance\` pairs.
 *
 * A string rather than an object literal because it is ${codepoints.length} entries of
 * generated data, and nothing reads it except {@link excalifontAdvances}.
 */
const ENCODED_ADVANCES = [
${chunks.map((chunk) => `  "${chunk}",`).join("\n")}
].join(",");

let table: Map<number, number> | null = null;

/** The advance table, parsed on first use. */
export function excalifontAdvances(): Map<number, number> {
  if (table !== null) return table;
  const parsed = new Map<number, number>();
  for (const pair of ENCODED_ADVANCES.split(",")) {
    const colon = pair.indexOf(":");
    parsed.set(Number(pair.slice(0, colon)), Number(pair.slice(colon + 1)));
  }
  table = parsed;
  return parsed;
}
`;

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "excalifont-advances.ts");
writeFileSync(target, source);
process.stdout.write(`wrote ${codepoints.length} advances to ${target}\n`);
