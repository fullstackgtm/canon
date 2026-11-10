"use client";

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

export function PiRunLive({ runId, running }: { runId: Id<"researchRuns">; running: boolean }) {
  const watch = useAction(api.piRuntime.watch);
  const [connection, setConnection] = useState("Connecting to live run");
  const [completed, setCompleted] = useState<number | null>(null);
  useEffect(() => {
    if (!running) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let renewal: ReturnType<typeof setTimeout> | undefined;
    let backoff = 500;
    const reconnect = () => {
      if (disposed) return;
      clearTimeout(renewal);
      setConnection("Reconnecting to live run");
      retry = setTimeout(() => { void connect(); }, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
    const connect = async () => {
      try {
        const ticket = await watch({ runId });
        if (disposed) return;
        socket = new WebSocket(ticket.url);
        socket.onopen = () => { backoff = 500; setConnection("Watching live"); };
        socket.onmessage = (event) => {
          try {
            const value = JSON.parse(event.data) as { progress?: { completed?: unknown } };
            const count = value.progress?.completed;
            if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) setCompleted(count);
          } catch { socket?.close(); }
        };
        socket.onclose = reconnect;
        socket.onerror = () => socket?.close();
        renewal = setTimeout(() => socket?.close(), Math.max(1, ticket.expiresAt - Date.now() - 5000));
      } catch { reconnect(); }
    };
    void connect();
    return () => { disposed = true; clearTimeout(retry); clearTimeout(renewal); socket?.close(); };
  }, [runId, running, watch]);

  return <p role="status" aria-live="polite" className="mt-2 text-xs text-muted-foreground" data-pi-live={running ? "running" : "finished"}>
    {running ? connection : "Durable run finished"}{running && completed !== null ? ` · ${completed} records committed` : ""}
  </p>;
}
