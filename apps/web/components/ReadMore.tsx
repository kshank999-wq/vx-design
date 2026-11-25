"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Long text cut to a few lines, with "Read more" to open it in place and "Show less" to close it again. The button only
 * appears when the text really is cut off.
 */
export function ReadMore({ text, lines = 3, className, label }: { text: string; lines?: number; className?: string; label?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setCut(el.scrollHeight > el.clientHeight + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, lines]);
  return (
    <span className={`read-more ${className ?? ""}`}>
      <span ref={ref} className="read-more-text" style={open ? undefined : { WebkitLineClamp: lines }} data-open={open ? "1" : undefined}>
        {label}{label ? " " : ""}{text}
      </span>
      {(cut || open) && (
        <button type="button" className="btn-link read-more-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </span>
  );
}
