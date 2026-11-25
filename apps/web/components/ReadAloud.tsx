"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Read the screen aloud, on every page: the main content block by block (headings, paragraphs, list items, table
 * rows), skipping menus, buttons and form fields, with the block being read highlighted and kept in view. Selected
 * text is read on its own. Uses the browser's own speech, so nothing is sent anywhere and it costs nothing.
 */
const SKIP = "script, style, noscript, nav, button, input, select, textarea, svg, .topbar, .chat-dock, .read-aloud, [aria-hidden='true'], [data-noread]";
const BLOCKS = "h1, h2, h3, h4, h5, h6, p, li, dt, dd, tr, summary, blockquote, figcaption, label, .badge, .banner, .card-title, td:only-child";
const RATES = [0.9, 1, 1.15, 1.3, 1.5];

function visible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (el.closest("details:not([open])") && !el.closest("summary")) return false;
  return el.offsetParent !== null || getComputedStyle(el).position === "fixed";
}

function blocks(): { el: Element | null; text: string }[] {
  const sel = window.getSelection()?.toString().trim();
  if (sel) return sel.split(/\n{1,}/).map((t) => t.trim()).filter(Boolean).map((text) => ({ el: null, text }));
  const root = document.querySelector("main") ?? document.body;
  const out: { el: Element; text: string }[] = [];
  for (const el of Array.from(root.querySelectorAll(BLOCKS))) {
    if (el.closest(SKIP) || !visible(el)) continue;
    // A block inside another block is read with its parent (a paragraph in a list item, a cell in a row).
    const parent = el.parentElement?.closest(BLOCKS);
    if (parent && root.contains(parent) && !parent.closest(SKIP)) continue;
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll(SKIP).forEach((n) => n.remove());
    const text = (clone.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 1) out.push({ el, text: el.tagName === "TR" ? text.replace(/ (?=\S)/, ": ") : text });
  }
  if (!out.length) {
    const text = (root as HTMLElement).innerText?.trim();
    return text ? text.split(/\n+/).filter((t) => t.trim().length > 1).map((t) => ({ el: null, text: t })) : [];
  }
  return out;
}

export function ReadAloud() {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<"idle" | "playing" | "paused">("idle");
  const [rate, setRate] = useState(1);
  const [pos, setPos] = useState({ at: 0, of: 0 });
  const queue = useRef<{ el: Element | null; text: string }[]>([]);
  const at = useRef(0);
  const run = useRef(0);

  useEffect(() => {
    setSupported(typeof window !== "undefined" && "speechSynthesis" in window);
    try { const r = Number(localStorage.getItem("vx-read-rate")); if (RATES.includes(r)) setRate(r); } catch { /* not kept */ }
    return () => { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); mark(null); };
  }, []);

  function mark(el: Element | null) {
    document.querySelectorAll(".reading-now").forEach((n) => n.classList.remove("reading-now"));
    if (el) { el.classList.add("reading-now"); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }

  function speak(i: number, r = rate) {
    const id = ++run.current;
    window.speechSynthesis.cancel();
    if (i < 0) i = 0;
    if (i >= queue.current.length) { stop(); return; }
    at.current = i;
    setPos({ at: i + 1, of: queue.current.length });
    const b = queue.current[i]!;
    mark(b.el);
    const u = new SpeechSynthesisUtterance(b.text);
    u.rate = r;
    u.lang = document.documentElement.lang || "en-US";
    u.onend = () => { if (run.current === id) speak(i + 1, r); };
    u.onerror = (e) => { if (run.current === id && e.error !== "interrupted" && e.error !== "canceled") speak(i + 1, r); };
    window.speechSynthesis.speak(u);
    setState("playing");
  }

  function start() {
    queue.current = blocks();
    if (!queue.current.length) return;
    speak(0);
  }
  function stop() {
    run.current++;
    window.speechSynthesis.cancel();
    mark(null);
    setState("idle");
    setPos({ at: 0, of: 0 });
  }
  function pauseResume() {
    if (state === "playing") { window.speechSynthesis.pause(); setState("paused"); }
    else { window.speechSynthesis.resume(); setState("playing"); }
  }
  function changeRate() {
    const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length]!;
    setRate(next);
    try { localStorage.setItem("vx-read-rate", String(next)); } catch { /* not kept */ }
    if (state !== "idle") speak(at.current, next);
  }

  if (!supported) return null;
  if (state === "idle") {
    return (
      <button type="button" className="icon-btn read-aloud-btn" onClick={start} title="Read this page aloud (select text first to read only that)" aria-label="Read this page aloud" data-testid="read-aloud">
        <svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" /></svg>
      </button>
    );
  }
  return (
    <div className="read-aloud" role="group" aria-label="Reading aloud" data-testid="read-aloud-bar">
      <span className="read-aloud-label">Reading {pos.at} of {pos.of}</span>
      <button type="button" className="btn btn-small" onClick={() => speak(at.current - 1)} title="Back one" aria-label="Back one">⏮</button>
      <button type="button" className="btn btn-small" onClick={pauseResume} aria-label={state === "playing" ? "Pause" : "Resume"}>{state === "playing" ? "⏸ Pause" : "▶ Resume"}</button>
      <button type="button" className="btn btn-small" onClick={() => speak(at.current + 1)} title="Skip ahead" aria-label="Skip ahead">⏭</button>
      <button type="button" className="btn btn-small" onClick={changeRate} title="Reading speed">{rate}×</button>
      <button type="button" className="btn btn-small" onClick={stop} aria-label="Stop reading">■ Stop</button>
    </div>
  );
}
