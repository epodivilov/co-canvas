/**
 * @vitest-environment jsdom
 */
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { RoomConnection } from "./connection";
import { RoomCanvas } from "./RoomCanvas";

/**
 * Excalidraw hands its imperative API over while it mounts and only then runs
 * its own asynchronous initialisation, which reads `initialData` and replaces
 * the whole scene with it. That ordering is the reason `RoomCanvas` passes a
 * function: anything captured earlier is applied on top of a scene the binding
 * has already filled, and the binding reads the difference as the user having
 * deleted the room.
 *
 * These cases drive that ordering directly, because the browser suite only
 * catches it two runs in sixteen — a rate that is no guard at all for a bug
 * that empties the board for everybody in the room.
 */

interface StubExcalidrawProps {
  initialData?: unknown;
  excalidrawAPI?: (api: unknown) => void;
}

const harness = vi.hoisted(() => ({
  /** The API the stub hands to `RoomCanvas`. Set before every render. */
  api: null as unknown,
  /** Whatever `RoomCanvas` last passed as `initialData`. */
  initialData: undefined as unknown,
}));

vi.mock("@excalidraw/excalidraw", async () => {
  const { createElement: create, useEffect } = await import("react");
  return {
    Excalidraw: (props: StubExcalidrawProps) => {
      harness.initialData = props.initialData;
      const handOver = props.excalidrawAPI;
      // The real component does this from its constructor; an effect is close
      // enough, because what these cases control is when `initialData` lands.
      useEffect(() => {
        handOver?.(harness.api);
      }, [handOver]);
      // `setupUndoRedo` reaches for both controls by accessible name with no
      // null guard, so the stub has to carry them or the binding throws.
      return create(
        "div",
        { className: "excalidraw" },
        create("button", { type: "button", "aria-label": "Undo" }),
        create("button", { type: "button", "aria-label": "Redo" }),
      );
    },
  };
});

interface FakeCanvas {
  api: ExcalidrawImperativeAPI;
  /** The scene as it stands. */
  elements(): readonly Record<string, unknown>[];
  /**
   * Replays Excalidraw's own initialisation: resolve `initialData`, replace the
   * scene with it and notify. `restore(null)` yields an empty scene, so an
   * absent `initialData` is modelled as an empty one.
   */
  applyInitialData(): Promise<void>;
}

type SceneListener = (
  elements: readonly Record<string, unknown>[],
  appState: unknown,
  files: unknown,
) => void;

function createFakeCanvas(): FakeCanvas {
  let elements: readonly Record<string, unknown>[] = [];
  const files: Record<string, unknown> = {};
  const listeners = new Set<SceneListener>();
  const appState = { selectedElementIds: {} };

  const api = {
    onChange(listener: SceneListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSceneElements: () => elements,
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => appState,
    getFiles: () => files,
    addFiles(added: { id: string }[]) {
      for (const file of added) files[file.id] = file;
    },
    updateScene(payload: { elements?: readonly Record<string, unknown>[] }) {
      // Excalidraw also takes collaborator-only updates, which change no scene.
      if (payload.elements === undefined) return;
      elements = [...payload.elements];
      for (const listener of [...listeners]) listener(elements, appState, files);
    },
  };

  return {
    api: api as unknown as ExcalidrawImperativeAPI,
    elements: () => elements,
    async applyInitialData() {
      const value = harness.initialData;
      const resolved = await (typeof value === "function"
        ? (value as () => unknown)()
        : (value as unknown));
      const next = (resolved as { elements?: readonly Record<string, unknown>[] } | null)?.elements;
      api.updateScene({ elements: next ?? [] });
    },
  };
}

function stubConnection(doc: Y.Doc, awareness: Awareness): RoomConnection {
  return {
    slug: "unit-room",
    doc,
    yElements: doc.getArray<Y.Map<unknown>>("elements"),
    yAssets: doc.getMap<unknown>("assets"),
    // `RoomCanvas` reads nothing else off the provider.
    provider: { awareness } as unknown as RoomConnection["provider"],
    status: () => "connected",
    subscribe: () => () => {},
    socketsOpened: () => 0,
    connect: () => {},
    disconnect: () => {},
    destroy: () => {},
  };
}

/** Writes elements into the document the way the hub's sync does. */
function receiveFromHub(connection: RoomConnection, count: number): string[] {
  const ids: string[] = [];
  connection.doc.transact(() => {
    for (let index = 0; index < count; index += 1) {
      const id = `remote-${index}`;
      ids.push(id);
      const entry = new Y.Map<unknown>();
      entry.set("pos", `a${index}`);
      entry.set("el", {
        id,
        type: "rectangle",
        x: index * 100,
        y: 0,
        width: 80,
        height: 60,
        version: 1,
        versionNonce: index + 1,
        isDeleted: false,
      });
      connection.yElements.push([entry]);
    }
  });
  return ids;
}

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe("RoomCanvas initialData", () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  let connection: RoomConnection;
  let canvas: FakeCanvas;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // How React decides `act` is allowed. Not part of any published type.
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    connection = stubConnection(doc, awareness);
    canvas = createFakeCanvas();
    harness.api = canvas.api;
    harness.initialData = undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    awareness.destroy();
    doc.destroy();
  });

  const mount = async () => {
    await act(async () => {
      root.render(createElement(RoomCanvas, { connection, onApi: () => {} }));
    });
  };

  it("keeps the room when the document arrives before excalidraw finishes loading", async () => {
    await mount();
    expect(canvas.elements()).toHaveLength(0);

    // The room reaches a peer that has already mounted its canvas: the binding
    // pulls it into the scene and starts treating it as what the user has.
    await act(async () => {
      receiveFromHub(connection, 3);
    });
    expect(canvas.elements()).toHaveLength(3);

    // Excalidraw now completes the initialisation it began at mount. Read
    // eagerly, `initialData` is the empty board this peer started with, and
    // applying it makes the binding publish three deletions to the whole room.
    await act(async () => {
      await canvas.applyInitialData();
    });

    expect(connection.yElements.length).toBe(3);
    expect(canvas.elements()).toHaveLength(3);
  });

  it("shows a room that had already arrived before the canvas mounted", async () => {
    const ids = receiveFromHub(connection, 3);
    await mount();

    await act(async () => {
      await canvas.applyInitialData();
    });

    expect(canvas.elements().map((element) => element.id)).toEqual(ids);
    expect(connection.yElements.length).toBe(3);
  });
});
