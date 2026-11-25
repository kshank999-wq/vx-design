"use client";
import { useRef, useState } from "react";
import { useStable } from "@/components/BoardViewer";

/** A drawing you can zoom (buttons or ctrl+scroll) and move around by dragging. */
export function ZoomImage({ src: given, alt, light }: { src: string; alt: string; light?: boolean }) {
  const src = useStable(given);
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const set = (z: number) => setZoom(Math.min(8, Math.max(0.5, Math.round(z * 100) / 100)));
  return (
    <div className="zoom-image">
      <div className="row tight zoom-tools">
        <button type="button" className="btn btn-small" onClick={() => set(zoom / 1.25)} aria-label="Zoom out">−</button>
        <span className="small muted">{Math.round(zoom * 100)}%</span>
        <button type="button" className="btn btn-small" onClick={() => set(zoom * 1.25)} aria-label="Zoom in">+</button>
        <button type="button" className="btn btn-small" onClick={() => set(1)}>Fit</button>
        <a className="btn btn-small" href={src} target="_blank" rel="noreferrer">Open full size</a>
      </div>
      <div ref={box} className={`zoom-box${light ? " zoom-light" : ""}`}
        onWheel={(e) => { if (e.ctrlKey) { e.preventDefault(); set(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)); } }}
        onPointerDown={(e) => { const b = box.current!; drag.current = { x: e.clientX, y: e.clientY, l: b.scrollLeft, t: b.scrollTop }; b.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { const d = drag.current, b = box.current; if (d && b) { b.scrollLeft = d.l - (e.clientX - d.x); b.scrollTop = d.t - (e.clientY - d.y); } }}
        onPointerUp={() => { drag.current = null; }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} style={{ width: `${zoom * 100}%` }} draggable={false} />
      </div>
    </div>
  );
}
