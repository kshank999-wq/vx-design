"use client";
import { useEffect, useRef, useState } from "react";

/* Dictation (speech to text) and read-aloud (text to speech) with the browser's own speech features: nothing extra
   to install. Dictation works in Chrome and Edge (Safari on recent versions); the button hides where it cannot work. */

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
  start(): void; stop(): void;
};
function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** A microphone button that types what you say into the field with id `target`. */
export function DictateButton({ target, label = "Dictate" }: { target: string; label?: string }) {
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  useEffect(() => { setSupported(!!recognitionClass()); return () => rec.current?.stop(); }, []);
  if (!supported) return null;

  const start = () => {
    const R = recognitionClass()!;
    const r = new R();
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    const field = document.getElementById(target) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!field) return;
    const before = field.value ? `${field.value.replace(/\s+$/, "")} ` : "";
    let finalText = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) finalText += res[0].transcript; else interim += res[0].transcript;
      }
      field.value = (before + finalText + interim).replace(/\s{2,}/g, " ");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    r.onerror = (e) => setProblem(e.error === "not-allowed" ? "Microphone access was blocked: allow it in the browser's address bar." : e.error === "no-speech" ? null : `Dictation stopped (${e.error}).`);
    r.onend = () => setOn(false);
    rec.current = r;
    setProblem(null);
    r.start();
    setOn(true);
    field.focus();
  };
  const stop = () => { rec.current?.stop(); setOn(false); };

  return (
    <span className="voice">
      <button type="button" className={`btn btn-secondary voice-btn${on ? " voice-on" : ""}`} onClick={on ? stop : start}
        aria-pressed={on} title={on ? "Stop dictating" : "Speak your answer"} data-testid="dictate">
        <span aria-hidden="true">{on ? "■" : "🎤"}</span> {on ? "Stop" : label}
      </button>
      {on && <span className="small voice-hint">Listening… speak, then press Stop.</span>}
      {problem && <span className="small warn-text">{problem}</span>}
    </span>
  );
}

/** Reads `text` aloud; press again to stop. */
export function ReadAloud({ text, label = "Read aloud" }: { text: string; label?: string }) {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    setSupported(typeof window !== "undefined" && "speechSynthesis" in window);
    return () => { if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel(); };
  }, []);
  if (!supported) return null;

  const speak = () => {
    const synth = window.speechSynthesis;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const lang = navigator.language || "en-US";
    // Prefer the more natural-sounding voices where the system has them.
    const voices = synth.getVoices().filter((v) => v.lang.startsWith(lang.slice(0, 2)));
    u.voice = voices.find((v) => /natural|neural/i.test(v.name)) ?? voices.find((v) => /google/i.test(v.name)) ?? voices.find((v) => v.default) ?? voices[0] ?? null;
    u.lang = u.voice?.lang ?? lang;
    u.rate = 1;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(u);
  };
  const stop = () => { window.speechSynthesis.cancel(); setSpeaking(false); };

  return (
    <button type="button" className={`btn btn-secondary voice-btn${speaking ? " voice-on" : ""}`} onClick={speaking ? stop : speak}
      aria-pressed={speaking} title={speaking ? "Stop reading" : "Read this aloud"} data-testid="read-aloud">
      <span aria-hidden="true">{speaking ? "■" : "🔊"}</span> {speaking ? "Stop" : label}
    </button>
  );
}
