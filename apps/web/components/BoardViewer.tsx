"use client";
/** Interactive 3D view of the board GLB (KiCad export) with <model-viewer>: drag to orbit, scroll to zoom. */
import { createElement, useEffect, useState } from "react";

export function BoardViewer({ src, poster }: { src: string; poster?: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    import("@google/model-viewer").then(() => live && setReady(true)).catch(() => undefined);
    return () => { live = false; };
  }, []);
  if (!ready) return poster ? <img className="render" src={poster} alt="Board render" /> : <p className="muted small">Loading 3D view…</p>;
  return createElement("model-viewer", {
    src, poster, "camera-controls": true, "touch-action": "pan-y", "shadow-intensity": "0.6", exposure: "1.1",
    "camera-orbit": "30deg 55deg auto", alt: "3D view of the routed board", className: "board3d", "data-testid": "board-3d",
  });
}
