import type { RoomSlug } from "@co-canvas/protocol";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { type ConnectionStatus, createRoomConnection, type RoomConnection } from "./connection";
import { installInspectionHandle } from "./inspect";
import { RoomCanvas } from "./RoomCanvas";

/**
 * One board, live.
 *
 * Owns the link to the hub so the indicator and the inspection handle keep
 * working when there is no canvas at all — which is exactly the case for a room
 * the hub refuses.
 */
export function RoomView({ slug }: { slug: RoomSlug }) {
  const [connection, setConnection] = useState<RoomConnection | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  useEffect(() => {
    const opened = createRoomConnection(slug);
    setConnection(opened);
    setStatus(opened.status());
    const unsubscribe = opened.subscribe(setStatus);

    return () => {
      unsubscribe();
      opened.destroy();
      setConnection(null);
    };
  }, [slug]);

  useEffect(() => {
    // Guarded by the build mode, not by a flag: a production bundle drops the
    // branch and never carries the handle.
    if (!import.meta.env.DEV || connection === null) return;
    return installInspectionHandle(connection, () => apiRef.current);
  }, [connection]);

  const handleApi = useCallback((api: ExcalidrawImperativeAPI | null) => {
    apiRef.current = api;
  }, []);

  if (connection === null) return null;

  return (
    <main className="room">
      {status === "refused" ? (
        <RefusedRoom slug={slug} />
      ) : (
        <RoomCanvas connection={connection} onApi={handleApi} />
      )}
      <ConnectionIndicator status={status} />
    </main>
  );
}

/**
 * The end of the line for a room the hub will not serve. No canvas: there is no
 * document behind it and nothing an edit here could ever reach.
 */
function RefusedRoom({ slug }: { slug: RoomSlug }) {
  return (
    <div className="room__error" role="alert">
      <h1>This room cannot be opened</h1>
      <p>
        The hub refused <code>{slug}</code> as a room name.
      </p>
      <p className="room__error-hint">
        Room names are lowercase letters, digits and hyphens, up to 64 characters, and start with a
        letter or a digit.
      </p>
    </div>
  );
}
