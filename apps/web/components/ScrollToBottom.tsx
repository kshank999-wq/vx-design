"use client";
import { useEffect, useRef } from "react";

/**
 * Put at the end of a chat list: on load, and whenever a message is added, the list scrolls to its newest message (you
 * can still scroll up to read earlier ones). It leaves the page alone if you had scrolled the list up yourself.
 */
export function ScrollToBottom({ count }: { count: number }) {
  const ref = useRef<HTMLLIElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const list = ref.current?.parentElement;
    if (!list) return;
    const nearEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
    if (first.current || nearEnd) list.scrollTop = list.scrollHeight;
    first.current = false;
  }, [count]);
  return <li ref={ref} aria-hidden="true" className="chat-end" />;
}
