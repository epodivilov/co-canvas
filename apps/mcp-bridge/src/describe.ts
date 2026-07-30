/**
 * The room as the text an agent reads before it edits anything.
 *
 * Topology first — nodes with their labels, arrows as `"X" -> "Y"`, containers,
 * a coarse grid — then exact geometry as an appendix. That shape is not a
 * design choice made here: gate CC-9 measured it against a raw element dump and
 * against the same topology without coordinates, and it scored 100% where the
 * coordinate-free variant scored 76%, at a third of the dump's payload. Every
 * failure the gate recorded was placement — a node dropped on an existing one,
 * an arrow ending in empty space — which is why the appendix is a requirement
 * and not a nicety.
 *
 * A pure function over the plain objects the room document holds. It opens no
 * socket, reads no clock and imports nothing from Excalidraw at runtime: the
 * only thing wanted from that package is types, and `verbatimModuleSyntax`
 * erases a type-only import at build time. If this file ever needs a value
 * import, the read path has grown the DOM stub layer the write path needs, and
 * that is a design change rather than a detail.
 */
import type {
  ExcalidrawFrameLikeElement,
  ExcalidrawLinearElement,
} from "@excalidraw/excalidraw/element/types";
import type { SceneElement } from "./elements.ts";

/** The box every described element fits inside, in scene units. */
export interface SceneExtent {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * What the tool reports alongside the description — and nothing that is in it.
 *
 * The description is the payload the gate measured; carrying any of it here as
 * well would send it twice and undo the format's whole cost advantage.
 */
export interface SceneSummary {
  readonly elements: number;
  readonly nodes: number;
  readonly arrows: number;
  /** `null` for a board holding nothing, which has no bounds to state. */
  readonly extent: SceneExtent | null;
}

export interface SceneDescription {
  readonly text: string;
  readonly summary: SceneSummary;
}

/**
 * The types Excalidraw itself treats as frames.
 *
 * A `Record` rather than a `Set` so the compiler checks both directions: a
 * frame kind upstream adds, or one it drops, is an error here rather than an
 * element quietly described as a node — with its children still naming it as
 * their frame and nothing naming them back.
 */
const FRAME_TYPES: Record<ExcalidrawFrameLikeElement["type"], true> = {
  frame: true,
  magicframe: true,
};

/** The types described end to end rather than as a box. Checked the same way. */
const LINEAR_TYPES: Record<ExcalidrawLinearElement["type"], true> = { arrow: true, line: true };

/** Cell size floors, so a board of tiny elements still has a usable grid. */
const MIN_CELL_WIDTH = 120;
const MIN_CELL_HEIGHT = 80;
/** How much wider and taller than the mean node a cell is. Gate CC-9's numbers. */
const CELL_WIDTH_FACTOR = 1.3;
const CELL_HEIGHT_FACTOR = 1.6;

const EMPTY_BOARD = "SCENE: the board is empty.";
const NO_LABEL = "(no label)";
const NO_NAME = "(no name)";
const UNBOUND = "(unbound)";

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** One element, reduced to what the description says about it. */
interface Described {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Radians, as Excalidraw stores it. */
  readonly angle: number;
  readonly label: string | null;
  readonly name: string | null;
  readonly groupIds: readonly string[];
  readonly frameId: string | null;
  /** Absolute scene points of a linear element, rotation applied. */
  readonly points: readonly Point[] | null;
  readonly startBinding: string | null;
  readonly endBinding: string | null;
  /** True bounds: the rotated outline, not the stored box. */
  readonly bounds: Bounds;
}

/** The grid the cells on every node and frame line are named in. */
interface Grid {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly columns: number;
  readonly rows: number;
  readonly origin: Point;
}

/** Renders a room. `elements` is the document's element array, in z-order. */
export function describeScene(elements: readonly SceneElement[]): SceneDescription {
  // CC-16 removes entries rather than flagging them, and so does the browser
  // binding, so nothing here should carry the flag — but describing a tombstone
  // costs one predicate to avoid.
  const alive = elements.filter((element) => element.isDeleted !== true);
  const labels = readLabels(alive);
  const described = alive
    .filter((element) => !labels.bound.has(element.id))
    .map((element) => describeElement(element, labels.text));

  const nodes = described
    .filter((element) => element.type !== "arrow" && !isFrame(element.type))
    .sort(byReadingOrder);
  const arrows = described.filter((element) => element.type === "arrow");
  const frames = described.filter((element) => isFrame(element.type));

  const summary: SceneSummary = {
    elements: alive.length,
    nodes: nodes.length,
    arrows: arrows.length,
    extent: extentOf(described),
  };
  if (summary.extent === null) return { text: EMPTY_BOARD, summary };

  const grid = buildGrid(summary.extent, nodes);
  const byId = new Map(described.map((element) => [element.id, element]));
  const groups = [...new Set(nodes.flatMap((node) => node.groupIds))];

  // Two spaces in front of every entry, and none in front of a heading: the
  // indent is what tells a reader — and the scenarios — where a section ends,
  // so a label that leaked a newline cannot pass as one more entry.
  const entry = (line: string): string => `  ${line}`;
  const blocks: string[][] = [
    [sceneLine(summary, summary.extent), gridLine(grid)],
    ["NODES", ...nodes.map((node) => entry(nodeLine(node, grid, byId)))],
    ...(frames.length + groups.length === 0
      ? []
      : [["CONTAINERS", ...containerLines(frames, groups, nodes, grid).map(entry)]]),
    ["ARROWS", ...arrows.map((arrow) => entry(arrowLine(arrow, byId)))],
    [
      "GEOMETRY (x, y, width, height)",
      ...nodes.map((node) => entry(geometryLine(node))),
      ...frames.map((frame) => entry(`${geometryLine(frame)}  (frame)`)),
      ...arrows.map((arrow) => entry(geometryLine(arrow))),
    ],
  ];

  return { text: blocks.map((block) => block.join("\n")).join("\n\n"), summary };
}

// ---------------------------------------------------------------------------
// reading the elements
// ---------------------------------------------------------------------------

/**
 * The label each container carries, and the ids of the texts that supply them.
 *
 * Keyed on the text's `containerId` rather than on the container's
 * `boundElements`, because that is the field Excalidraw keeps authoritative and
 * the one a stale `boundElements` cannot contradict. A container that is not in
 * the room is no container at all: its text is a loose note, and R5 says it is
 * described as one rather than swallowed as the label of nothing.
 */
function readLabels(alive: readonly SceneElement[]): {
  text: ReadonlyMap<string, string>;
  bound: ReadonlySet<string>;
} {
  const present = new Set(alive.map((element) => element.id));
  const text = new Map<string, string>();
  const bound = new Set<string>();

  for (const element of alive) {
    if (element.type !== "text") continue;
    const containerId = element.containerId;
    // `containerId` may name an arrow as readily as a shape — Excalidraw's own
    // `ExcalidrawTextContainer` includes arrows, and CC-16 draws labelled ones.
    if (typeof containerId !== "string" || !present.has(containerId)) continue;
    bound.add(element.id);
    text.set(containerId, ownText(element));
  }

  return { text, bound };
}

/**
 * The text of a text element as the person typed it.
 *
 * Excalidraw stores the wrapped string in `text` and the typed one in
 * `originalText`; reading `text` would put the newlines it wrapped at into a
 * format that is one line per element.
 */
function ownText(element: SceneElement): string {
  const typed = element.originalText;
  if (typeof typed === "string" && typed !== "") return typed;
  return typeof element.text === "string" ? element.text : "";
}

function describeElement(element: SceneElement, labels: ReadonlyMap<string, string>): Described {
  const x = num(element.x);
  const y = num(element.y);
  const width = num(element.width);
  const height = num(element.height);
  const angle = num(element.angle);
  const points = isLinear(element.type)
    ? absolutePoints(element, x, y, width, height, angle)
    : null;
  const label = labels.get(element.id) ?? (element.type === "text" ? ownText(element) : null);

  return {
    id: element.id,
    type: element.type,
    x,
    y,
    width,
    height,
    angle,
    label: label === "" ? null : label,
    name: typeof element.name === "string" && element.name !== "" ? element.name : null,
    groupIds: Array.isArray(element.groupIds)
      ? element.groupIds.filter((id): id is string => typeof id === "string")
      : [],
    frameId: typeof element.frameId === "string" ? element.frameId : null,
    points,
    startBinding: bindingTarget(element.startBinding),
    endBinding: bindingTarget(element.endBinding),
    bounds: points === null ? boxBounds(x, y, width, height, angle) : boundsOfPoints(points),
  };
}

/**
 * A linear element's points in absolute scene coordinates.
 *
 * `points` are relative to the element's own `x`/`y`, and Excalidraw turns them
 * about the element's centre when it draws. Reporting the raw pairs would put
 * every arrow near the origin — and the gate's numbers say misplaced arrows are
 * precisely how an agent fails.
 */
function absolutePoints(
  element: SceneElement,
  x: number,
  y: number,
  width: number,
  height: number,
  angle: number,
): Point[] {
  const stored = Array.isArray(element.points) ? element.points : [];
  const centre = { x: x + width / 2, y: y + height / 2 };
  const points = stored.flatMap((point) => {
    if (!Array.isArray(point)) return [];
    return [rotate({ x: x + num(point[0]), y: y + num(point[1]) }, centre, angle)];
  });
  // An element with no points still has to land somewhere the extent covers.
  return points.length > 0 ? points : [{ x, y }];
}

function bindingTarget(binding: unknown): string | null {
  if (binding === null || typeof binding !== "object") return null;
  const id = (binding as { elementId?: unknown }).elementId;
  return typeof id === "string" ? id : null;
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

function rotate(point: Point, centre: Point, angle: number): Point {
  if (angle === 0) return point;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return { x: centre.x + dx * cos - dy * sin, y: centre.y + dx * sin + dy * cos };
}

/**
 * The box an element actually occupies.
 *
 * Excalidraw stores the box before `angle` is applied, rotation being about the
 * centre, so a turned element reaches past its stored corners. The appendix
 * still reports the stored box — that is what an agent writes back — but the
 * extent has to enclose what is really there.
 */
function boxBounds(x: number, y: number, width: number, height: number, angle: number): Bounds {
  const corners: Point[] = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
  if (angle === 0) return boundsOfPoints(corners);
  const centre = { x: x + width / 2, y: y + height / 2 };
  return boundsOfPoints(corners.map((corner) => rotate(corner, centre, angle)));
}

function boundsOfPoints(points: readonly Point[]): Bounds {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** The box enclosing everything described, or `null` when nothing is. */
function extentOf(described: readonly Described[]): SceneExtent | null {
  if (described.length === 0) return null;
  const boxes = described.map((element) => element.bounds);
  return {
    minX: round(Math.min(...boxes.map((box) => box.minX))),
    minY: round(Math.min(...boxes.map((box) => box.minY))),
    maxX: round(Math.max(...boxes.map((box) => box.maxX))),
    maxY: round(Math.max(...boxes.map((box) => box.maxY))),
  };
}

// ---------------------------------------------------------------------------
// the grid
// ---------------------------------------------------------------------------

/**
 * A grid sized from the scene itself.
 *
 * Cells come from the mean node, so a board of small boxes and a board of large
 * ones both read as a handful of columns rather than as one cell or a hundred.
 */
function buildGrid(extent: SceneExtent, nodes: readonly Described[]): Grid {
  const cellWidth = Math.max(
    MIN_CELL_WIDTH,
    round(mean(nodes.map((node) => Math.abs(node.width))) * CELL_WIDTH_FACTOR),
  );
  const cellHeight = Math.max(
    MIN_CELL_HEIGHT,
    round(mean(nodes.map((node) => Math.abs(node.height))) * CELL_HEIGHT_FACTOR),
  );
  return {
    cellWidth,
    cellHeight,
    columns: Math.max(1, Math.ceil((extent.maxX - extent.minX) / cellWidth)),
    rows: Math.max(1, Math.ceil((extent.maxY - extent.minY) / cellHeight)),
    origin: { x: extent.minX, y: extent.minY },
  };
}

/** The single cell an element's centre falls in. */
function cellOf(element: Described, grid: Grid): string {
  const centreX = (element.bounds.minX + element.bounds.maxX) / 2;
  const centreY = (element.bounds.minY + element.bounds.maxY) / 2;
  return `${columnName(columnAt(centreX, grid))}${rowAt(centreY, grid) + 1}`;
}

/** The full range of cells an element's box spans, e.g. `B1..C4`. */
function cellRange(element: Described, grid: Grid): string {
  const from = `${columnName(columnAt(element.bounds.minX, grid))}${rowAt(element.bounds.minY, grid) + 1}`;
  const to = `${columnName(columnAt(element.bounds.maxX, grid))}${rowAt(element.bounds.maxY, grid) + 1}`;
  return `${from}..${to}`;
}

function columnAt(x: number, grid: Grid): number {
  return clamp(Math.floor((x - grid.origin.x) / grid.cellWidth), 0, grid.columns - 1);
}

function rowAt(y: number, grid: Grid): number {
  return clamp(Math.floor((y - grid.origin.y) / grid.cellHeight), 0, grid.rows - 1);
}

/**
 * Bijective base-26: `A`, `Z`, `AA`, `AB`, …
 *
 * `String.fromCharCode(65 + column)` runs off the alphabet at the twenty-sixth
 * column and starts naming cells `}1` and `i1` — lowercase letters that collide
 * with nothing and mean nothing to whoever reads them.
 */
function columnName(index: number): string {
  let remaining = index + 1;
  let name = "";
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
}

// ---------------------------------------------------------------------------
// the lines
// ---------------------------------------------------------------------------

function sceneLine(summary: SceneSummary, extent: SceneExtent): string {
  return (
    `SCENE: ${summary.nodes} nodes, ${summary.arrows} arrows,` +
    ` extent ${extent.minX},${extent.minY} .. ${extent.maxX},${extent.maxY}`
  );
}

function gridLine(grid: Grid): string {
  return (
    `GRID: coarse cells ~${grid.cellWidth}x${grid.cellHeight}px,` +
    ` columns A..${columnName(grid.columns - 1)} left→right,` +
    ` rows 1..${grid.rows} top→bottom`
  );
}

function nodeLine(node: Described, grid: Grid, byId: ReadonlyMap<string, Described>): string {
  const extras: string[] = [];
  const degrees = wholeDegrees(node.angle);
  // A turned element's stored box is not its outline, and the appendix reports
  // the stored box; without this the description states an outline the board
  // does not have. A linear element says it with its points instead.
  if (degrees !== 0 && node.points === null) extras.push(`rot=${degrees}`);
  if (node.groupIds.length > 0) extras.push(`group=${node.groupIds.join(",")}`);
  if (node.frameId !== null) extras.push(`frame=${frameReference(node.frameId, byId)}`);

  return [
    node.id,
    node.label === null ? NO_LABEL : quote(node.label),
    node.type,
    `cell ${cellOf(node, grid)}`,
    ...extras,
  ].join("  ");
}

function containerLines(
  frames: readonly Described[],
  groups: readonly string[],
  nodes: readonly Described[],
  grid: Grid,
): string[] {
  const lines = frames.map((frame) => {
    const held = nodes.filter((node) => node.frameId === frame.id);
    const name = frame.name === null ? NO_NAME : quote(frame.name);
    return `frame ${frame.id} ${name} cells ${cellRange(frame, grid)}: contains ${members(held)}`;
  });

  for (const group of groups) {
    lines.push(`group ${group}: ${members(nodes.filter((node) => node.groupIds.includes(group)))}`);
  }
  return lines;
}

function arrowLine(arrow: Described, byId: ReadonlyMap<string, Described>): string {
  const parts = [arrow.id, `${end(arrow.startBinding, byId)} -> ${end(arrow.endBinding, byId)}`];
  if (arrow.label !== null) parts.push(quote(arrow.label));
  const waypoints = Math.max(0, (arrow.points?.length ?? 0) - 2);
  if (waypoints > 0) parts.push(`(${waypoints} waypoint(s))`);
  return parts.join("  ");
}

function geometryLine(element: Described): string {
  if (element.points === null) {
    const box = [element.x, element.y, element.width, element.height].map(round).join(", ");
    return `${element.id}  ${box}`;
  }
  const start = element.points.at(0) ?? { x: element.x, y: element.y };
  const finish = element.points.at(-1) ?? start;
  const via = element.points.slice(1, -1).map(coordinates).join(" ");
  return (
    `${element.id}  from ${coordinates(start)} to ${coordinates(finish)}` +
    (via === "" ? "" : `  via ${via}`)
  );
}

function coordinates(point: Point): string {
  return `(${round(point.x)},${round(point.y)})`;
}

/**
 * What an arrow's end is bound to.
 *
 * The label when the element has one, its id when it does not — two unlabelled
 * shapes must not read as the same anonymous end — and an explicit marker when
 * the end hangs in empty space or names something no longer in the room.
 */
function end(id: string | null, byId: ReadonlyMap<string, Described>): string {
  if (id === null) return UNBOUND;
  const target = byId.get(id);
  if (target === undefined) return UNBOUND;
  return target.label === null ? target.id : quote(target.label);
}

/** A frame named the way a node line refers to it. */
function frameReference(id: string, byId: ReadonlyMap<string, Described>): string {
  const frame = byId.get(id);
  // A `frameId` naming nothing is a document that has lost a frame; the id says
  // so, where a quoted name would claim a frame that is not there.
  if (frame === undefined) return id;
  return frame.name === null ? NO_NAME : quote(frame.name);
}

/**
 * The elements a container holds, named the way a person would name them.
 *
 * Unquoted, as the format has it — and folded all the same, because a label a
 * person typed across three lines would otherwise split this line into three.
 */
function members(nodes: readonly Described[]): string {
  if (nodes.length === 0) return "(empty)";
  return nodes.map((node) => (node.label === null ? node.id : oneLine(node.label))).join(", ");
}

// ---------------------------------------------------------------------------
// strings and numbers
// ---------------------------------------------------------------------------

/**
 * A label as one line of a line-oriented format.
 *
 * A wrapped label carries the newlines Excalidraw wrapped it at, a typed one
 * carries whatever the person pressed, and either is free to contain the double
 * quote this format delimits with. `JSON.stringify` escapes the quote and any
 * control character that survived; folding the newlines to spaces first keeps
 * the label readable rather than turning it into `\n`-littered source.
 */
function quote(label: string): string {
  return JSON.stringify(oneLine(label));
}

/** Every line break in a string folded to a single space. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/** Rotation in whole degrees, normalised into one turn. */
function wholeDegrees(angle: number): number {
  return ((Math.round((angle * 180) / Math.PI) % 360) + 360) % 360;
}

/** Rounds to whole scene units, and never to `-0`. */
function round(value: number): number {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * A stored field as a finite number.
 *
 * The document is JSON that a browser and a bridge both write into; a missing
 * width, or a string where a number belongs, must not become the `NaN` R7
 * forbids anywhere in a description.
 */
function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFrame(type: string): boolean {
  return Object.hasOwn(FRAME_TYPES, type);
}

function isLinear(type: string): boolean {
  return Object.hasOwn(LINEAR_TYPES, type);
}

/** Top to bottom, then left to right; the id breaks a tie so the order is total. */
function byReadingOrder(a: Described, b: Described): number {
  if (a.bounds.minY !== b.bounds.minY) return a.bounds.minY - b.bounds.minY;
  if (a.bounds.minX !== b.bounds.minX) return a.bounds.minX - b.bounds.minX;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
