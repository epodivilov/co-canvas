import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ConnectionStatus, RoomConnection } from "./connection.ts";

/** A scene element reduced to the parts a test can compare. */
export interface InspectedElement {
  id: string;
  type: string;
  x: number;
  y: number;
  strokeColor: string;
  backgroundColor: string;
  /** Set on image elements; the key their binary is stored under. */
  fileId: string | null;
  isDeleted: boolean;
  /** Set on a bound text element; the container it belongs to. */
  containerId: string | null;
  /** Ids of the labels and arrows bound to this element. */
  boundElementIds: string[];
  /** Element an arrow's first point is bound to. */
  startBindingId: string | null;
  /** Element an arrow's last point is bound to. */
  endBindingId: string | null;
  /** Frame this element belongs to. */
  frameId: string | null;
}

/** One entry of the room's `Y.Array`, with the key that decides z-order. */
export interface InspectedEntry {
  id: string;
  pos: string;
  type: string;
}

/**
 * The room, as the acceptance suite sees it.
 *
 * Excalidraw draws to a `<canvas>`, so a scene has no DOM for Playwright to
 * read: without this there is nothing to assert on beyond a screenshot. It is
 * production-shaped code whose only consumer is a test — installed on `window`
 * behind `import.meta.env.DEV`, so a production build does not carry it.
 */
export interface InspectionHandle {
  /**
   * Whether the room has a canvas bound to its document.
   *
   * A canvas accepts input from the moment Excalidraw paints it, but the
   * binding is built one commit later and resets the scene to the shared
   * document as it starts — so anything drawn before this reads true is thrown
   * away, and a test that begins earlier is racing that reset.
   */
  ready(): boolean;
  /** Scene elements in the order Excalidraw holds them, deleted ones included. */
  elements(): InspectedElement[];
  /** Ids Excalidraw currently considers selected. */
  selectedIds(): string[];
  /** The shared array behind the scene, ordered as it is stored. */
  entries(): InspectedEntry[];
  /** Whether the binary behind an image element has arrived. */
  hasFile(fileId: string): boolean;
  /** The connection state the indicator is showing. */
  state(): ConnectionStatus;
  /** WebSockets this page has opened for the room since it mounted. */
  socketsOpened(): number;
  /** Drives the offline scenarios. */
  connect(): void;
  disconnect(): void;
}

declare global {
  interface Window {
    /** Present only in a development build. See {@link InspectionHandle}. */
    __coCanvas?: InspectionHandle;
  }
}

/** Name the handle is installed under. */
const HANDLE_KEY = "__coCanvas";

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readId(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The element a `startBinding` or `endBinding` names, if there is one. */
function readBinding(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  return readId((value as { elementId?: unknown }).elementId);
}

function readBoundElementIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const id = readId((entry as { id?: unknown } | null)?.id);
    return id === null ? [] : [id];
  });
}

function normalise(element: Record<string, unknown>): InspectedElement {
  return {
    id: readString(element.id),
    type: readString(element.type),
    x: Math.round(Number(element.x)),
    y: Math.round(Number(element.y)),
    strokeColor: readString(element.strokeColor),
    backgroundColor: readString(element.backgroundColor),
    fileId: typeof element.fileId === "string" ? element.fileId : null,
    isDeleted: element.isDeleted === true,
    containerId: readId(element.containerId),
    boundElementIds: readBoundElementIds(element.boundElements),
    startBindingId: readBinding(element.startBinding),
    endBindingId: readBinding(element.endBinding),
    frameId: readId(element.frameId),
  };
}

/**
 * Installs the handle and returns its remover.
 *
 * The canvas comes and goes — a refused room never renders one — so the API is
 * read through a getter rather than captured, and the handle stays useful while
 * there is nothing to draw on. The getter yields an API only while a binding is
 * attached to it, which is what makes {@link InspectionHandle.ready} honest.
 */
export function installInspectionHandle(
  connection: RoomConnection,
  readApi: () => ExcalidrawImperativeAPI | null,
): () => void {
  const handle: InspectionHandle = {
    ready: () => readApi() !== null,
    elements() {
      const api = readApi();
      if (api === null) return [];
      return api
        .getSceneElementsIncludingDeleted()
        .map((element) => normalise(element as unknown as Record<string, unknown>));
    },
    selectedIds() {
      const api = readApi();
      if (api === null) return [];
      return Object.entries(api.getAppState().selectedElementIds)
        .filter(([, selected]) => selected)
        .map(([id]) => id);
    },
    entries() {
      return connection.yElements.toArray().map((entry) => {
        const element = entry.get("el");
        const shape = (element ?? {}) as Record<string, unknown>;
        return {
          id: readString(shape.id),
          pos: readString(entry.get("pos")),
          type: readString(shape.type),
        };
      });
    },
    hasFile(fileId) {
      const api = readApi();
      if (api === null) return false;
      return Object.hasOwn(api.getFiles(), fileId);
    },
    state: () => connection.status(),
    socketsOpened: () => connection.socketsOpened(),
    connect: () => connection.connect(),
    disconnect: () => connection.disconnect(),
  };

  window[HANDLE_KEY] = handle;
  return () => {
    if (window[HANDLE_KEY] === handle) delete window[HANDLE_KEY];
  };
}
