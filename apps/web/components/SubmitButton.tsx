"use client";
import { useFormStatus } from "react-dom";

export function SubmitButton({ children, pendingText, variant = "primary", ...rest }:
  { children: React.ReactNode; pendingText?: string; variant?: "primary" | "secondary" | "danger" | "go" } &
  React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn btn-${variant}`} disabled={pending || rest.disabled} aria-busy={pending} {...rest}>
      {pending ? pendingText ?? "Working…" : children}
    </button>
  );
}
