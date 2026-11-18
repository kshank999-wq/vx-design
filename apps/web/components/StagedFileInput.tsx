"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * A file field whose file goes straight from the browser to a private staging folder in storage, so large files never
 * pass through the web server (hosted server functions cap request bodies at a few MB). The form then posts only the
 * staged path; the server action reads the file from storage, checks it exactly as before and removes the staged copy
 * (lib/staged.ts). Without JavaScript, or if staging fails, the file is posted with the form as usual.
 */
export function StagedFileInput({ name, bucket, prefix, accept, required, label, ariaLabel }: {
  name: string; bucket: "project-files" | "knowledge-files"; prefix: string; accept?: string; required?: boolean;
  label?: string; ariaLabel?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<{ ref: string; name: string; type: string } | null>(null);
  const [state, setState] = useState<"idle" | "uploading" | "error">("idle");
  const [message, setMessage] = useState("");
  const busy = useRef(false);
  const pending = useRef<HTMLElement | null | undefined>(undefined);

  // A submit while the file is still on its way waits for it, then goes ahead by itself.
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const hold = (e: SubmitEvent) => {
      if (!busy.current) return;
      e.preventDefault(); e.stopImmediatePropagation();
      pending.current = e.submitter;
      setMessage("Finishing the upload, then submitting…");
    };
    form.addEventListener("submit", hold, true);
    return () => form.removeEventListener("submit", hold, true);
  }, []);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    setStaged(null);
    if (!f) { setState("idle"); return; }
    busy.current = true; setState("uploading"); setMessage(`Uploading ${(f.size / 1048576).toFixed(1)} MB…`);
    const path = `${prefix}/${crypto.randomUUID()}/${f.name.replace(/[^\w.-]+/g, "_").slice(-120) || "file"}`;
    const { error } = await createClient().storage.from(bucket).upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
    busy.current = false;
    if (error) {
      setState("error"); setMessage(`Could not stage the file (${error.message}); it will be sent with the form instead.`);
      if (pending.current !== undefined) { const s = pending.current; pending.current = undefined; setTimeout(() => input.current?.form?.requestSubmit(s instanceof HTMLButtonElement ? s : undefined), 0); }
      return;
    }
    setStaged({ ref: `${bucket}:${path}`, name: f.name, type: f.type });
    setState("idle"); setMessage("Ready.");
    if (pending.current !== undefined) {
      const submitter = pending.current;
      pending.current = undefined;
      // Let React render the hidden fields (and drop the file field's name) before the form is sent.
      setTimeout(() => input.current?.form?.requestSubmit(submitter instanceof HTMLButtonElement ? submitter : undefined), 0);
    }
  }

  const field = (
    <input ref={input} type="file" name={staged ? undefined : name} accept={accept} required={required} aria-label={ariaLabel}
           onChange={onChange} data-staged={staged ? "yes" : state} />
  );
  return (
    <>
      {label ? <label>{label}{field}</label> : field}
      {staged && <>
        <input type="hidden" name={`${name}__staged`} value={staged.ref} />
        <input type="hidden" name={`${name}__name`} value={staged.name} />
        <input type="hidden" name={`${name}__type`} value={staged.type} />
      </>}
      {message && <span className={`small ${state === "error" ? "error" : "muted"}`} role="status">{message}</span>}
    </>
  );
}
