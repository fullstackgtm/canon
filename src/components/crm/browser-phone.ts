"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import type { TelnyxRTC } from "@telnyx/webrtc";
import { api } from "../../../convex/_generated/api";

/** Where the browser softphone is: signing in, waiting for the session's call, on it, or a local stack's stand-in. */
export type BrowserPhoneState = "off" | "connecting" | "ready" | "on_call" | "simulated" | "error";

type SdkCall = { state: string; answer: (opts?: { remoteElement?: HTMLMediaElement }) => void; muteAudio: () => void; unmuteAudio: () => void; hangup: () => void };

/**
 * The rep's browser as the dialing session's audio (docs/dialer.md, D2). The
 * session rings the rep's Telnyx credential; this tab is signed in to it with
 * a short-lived token (dialerActions.browserToken) and answers that one call,
 * which then carries every contact the rep dials. Closing or leaving the tab
 * hangs up the rep's leg, which ends the session.
 */
export function useBrowserPhone(active: boolean) {
  const browserToken = useAction(api.dialerActions.browserToken);
  const [state, setState] = useState<BrowserPhoneState>("off");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const clientRef = useRef<TelnyxRTC | null>(null);
  const callRef = useRef<SdkCall | null>(null);
  // Bumped on unmount: a prepare() still waiting on the microphone, token or SDK stops, and creates nothing.
  const generation = useRef(0);

  const disconnect = useCallback(() => {
    callRef.current?.hangup();
    callRef.current = null;
    clientRef.current?.disconnect();
    clientRef.current = null;
    setMuted(false);
  }, []);

  /** Ask for the microphone and sign in, before the session rings this tab. True when it's ready. */
  const prepare = useCallback(async (): Promise<boolean> => {
    const mine = ++generation.current;
    const stale = () => generation.current !== mine;
    setError(null);
    setState("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      if (stale()) return false;
    } catch {
      setState("error");
      setError("Canon needs your microphone for browser audio. Allow it for this site in your browser's site settings (the icon left of the address), then try again, or use your phone.");
      return false;
    }
    try {
      const { token, simulated } = await browserToken({});
      if (stale()) return false;
      if (simulated || !token) {
        setState("simulated");
        return true;
      }
      disconnect();
      const { TelnyxRTC } = await import("@telnyx/webrtc");
      if (stale()) return false;
      const client = new TelnyxRTC({ login_token: token });
      clientRef.current = client;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Telnyx didn't answer in time.")), 15_000);
        client.on("telnyx.ready", () => { clearTimeout(timer); resolve(); });
        client.on("telnyx.error", () => { clearTimeout(timer); reject(new Error("Telnyx refused the sign-in.")); });
        client.on("telnyx.notification", (notification: { type?: string; call?: SdkCall }) => {
          const call = notification.call;
          if (notification.type !== "callUpdate" || !call) return;
          // The only call this credential gets is the session's, placed by Canon: answer it.
          if (call.state === "ringing") call.answer(audioRef.current ? { remoteElement: audioRef.current } : undefined);
          if (call.state === "active") { callRef.current = call; setState("on_call"); }
          if (call.state === "hangup" || call.state === "destroy") { callRef.current = null; setMuted(false); setState("ready"); }
        });
        client.connect();
      });
      if (stale()) {
        client.disconnect();
        return false;
      }
      setState("ready");
      return true;
    } catch (cause) {
      disconnect();
      setState("error");
      setError(cause instanceof Error ? cause.message : "Browser audio didn't start. Use your phone instead.");
      return false;
    }
  }, [browserToken, disconnect]);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    if (muted) call.unmuteAudio();
    else call.muteAudio();
    setMuted(!muted);
  }, [muted]);

  // The session ended (live, then not): sign out. Not before it starts: prepare() runs first.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) {
      disconnect();
      setState("off");
    }
    wasActive.current = active;
  }, [active, disconnect]);
  // Leaving the page signs out too, which hangs up the rep's leg, and cancels a prepare() still in flight.
  useEffect(() => () => {
    generation.current++;
    disconnect();
  }, [disconnect]);

  return { state, error, muted, audioRef, prepare, toggleMute };
}
