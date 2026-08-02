import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExcalidrawBinding, yjsToExcalidraw } from "y-excalidraw";
import * as Y from "yjs";
import "@excalidraw/excalidraw/index.css";
import type { RoomConnection } from "./connection.ts";

interface RoomCanvasProps {
  connection: RoomConnection;
  /**
   * Hands the imperative API up once the canvas is bound to the document, and
   * `null` again when it is not. Published from inside the binding's effect
   * rather than as soon as Excalidraw hands the API over: until the binding
   * exists the canvas is drawable but not yet connected to anything, and
   * `ExcalidrawBinding`'s constructor resets the scene to the shared document's
   * contents — so a stroke made in that window is silently thrown away.
   */
  onApi: (api: ExcalidrawImperativeAPI | null) => void;
}

/**
 * The drawing surface, bound to the room's shared document.
 *
 * The binding is built in an effect keyed on the API rather than during render,
 * for two reasons: `setupUndoRedo` reaches straight for the toolbar's undo
 * control with no null guard, so it needs Excalidraw to have painted; and this
 * is the effect React re-runs under `StrictMode`, which is where a binding that
 * could not survive a remount would show itself.
 */
export function RoomCanvas({ connection, onApi }: RoomCanvasProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [binding, setBinding] = useState<ExcalidrawBinding | null>(null);
  const domRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dom = domRef.current;
    if (api === null || dom === null) return;

    // Tracked by class rather than instance: no binding exists yet at this
    // point, and yjs matches a tracked entry against `origin.constructor` as
    // well as against the origin itself. The binding also tracks itself from
    // its own constructor, so this is belt and braces — but it is the shape the
    // CC-2 gate ran, and undo is not the place to economise.
    const undoManager = new Y.UndoManager(connection.yElements, {
      trackedOrigins: new Set([ExcalidrawBinding]),
    });

    // Both `excalidrawDom` and `undoManager` or neither: the binding's runtime
    // guard only tests the manager, so passing it alone throws, and passing
    // neither silently leaves undo unhooked.
    const bound = new ExcalidrawBinding(
      connection.yElements,
      connection.yAssets,
      api,
      connection.provider.awareness,
      { excalidrawDom: dom, undoManager },
    );
    setBinding(bound);
    onApi(api);

    return () => {
      onApi(null);
      setBinding(null);
      bound.destroy();
      undoManager.destroy();
    };
  }, [api, connection, onApi]);

  // Without this a peer joining an established room paints an empty board until
  // the first remote change arrives.
  //
  // A function rather than a value, and that distinction is load-bearing.
  // Excalidraw reads `initialData` inside an async initialisation that runs
  // *after* it has handed the API over, so a snapshot taken at render time gets
  // applied on top of whatever the binding has already drawn. For a late joiner
  // that snapshot is the empty board it mounted with: the scene is wiped back
  // to nothing while the binding still believes it holds the room's elements,
  // and the next change it notices reads as the user having deleted every one
  // of them — which it then publishes to everybody else. Read lazily it can
  // only return what the document holds at the moment it is applied, which is
  // what the binding believes too.
  const readInitialData = useCallback(
    () => ({ elements: yjsToExcalidraw(connection.yElements) }),
    [connection],
  );

  // Spread rather than passed straight through: `exactOptionalPropertyTypes`
  // refuses an explicit `undefined` for an optional prop, and there is no
  // binding to take a handler from until the effect above has run.
  const pointerProps = binding === null ? {} : { onPointerUpdate: binding.onPointerUpdate };

  return (
    <div className="room__canvas" ref={domRef}>
      <Excalidraw
        initialData={readInitialData}
        excalidrawAPI={setApi}
        // Without this the binding publishes no cursor, and remote presence
        // looks broken rather than absent.
        {...pointerProps}
      />
    </div>
  );
}
