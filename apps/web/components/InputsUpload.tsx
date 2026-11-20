"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { addReference, addSpecification, type UploadOutcome } from "@/app/projects/[projectId]/inputs/actions";

/**
 * Several files at once for the project inputs. Each file goes from the browser to the project's staging folder (large
 * files never pass through the web server), then a server action checks and stores it: specifications as documents,
 * everything else as numbered references.
 */
export function InputsUpload({ projectId, mode, kinds }: { projectId: string; mode: "specification" | "reference"; kinds?: [string, string][] }) {
  const router = useRouter();
  const [lines, setLines] = useState<{ text: string; ok: boolean | null }[]>([]);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const files = data.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) return;
    const kind = String(data.get("kind") ?? "mockup"), note = String(data.get("note") ?? ""), title = String(data.get("title") ?? "");
    setBusy(true);
    setLines(files.map((f) => ({ text: `${f.name}: waiting…`, ok: null })));
    const supabase = createClient();
    const set = (i: number, text: string, ok: boolean | null) => setLines((l) => l.map((x, j) => (j === i ? { text, ok } : x)));
    for (const [i, f] of files.entries()) {
      set(i, `${f.name}: uploading ${(f.size / 1048576).toFixed(1)} MB…`, null);
      const path = `${projectId}/uploads/${crypto.randomUUID()}/${f.name.replace(/[^\w.-]+/g, "_").slice(-120) || "file"}`;
      const { error } = await supabase.storage.from("project-files").upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
      if (error) { set(i, `${f.name}: could not upload (${error.message})`, false); continue; }
      set(i, `${f.name}: checking…`, null);
      const ref = `project-files:${path}`;
      let r: UploadOutcome;
      try {
        r = mode === "specification" ? await addSpecification(projectId, ref, f.name, f.type)
          : await addReference(projectId, ref, f.name, f.type, kind, files.length === 1 ? title : "", note);
      } catch (err) {
        r = { ok: false, message: `${f.name}: ${(err as Error).message}` };
      }
      set(i, r.message, r.ok);
    }
    setBusy(false);
    form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="stack" data-testid={`upload-${mode}`}>
      {mode === "reference" && (
        <div className="grid2">
          <label>Kind<select name="kind" defaultValue="mockup" aria-label="Reference kind">{(kinds ?? []).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Title (one file only; else the file name)<input name="title" aria-label="Reference title" /></label>
          <label className="span2">What it shows (sizes, what to keep, what to change)<textarea name="note" rows={2} aria-label="Reference note" /></label>
        </div>
      )}
      <div className="row">
        <input name="files" type="file" multiple required aria-label={mode === "specification" ? "Specification files" : "Reference files"}
               accept={mode === "specification" ? ".docx,.pdf,.md,.txt" : ".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.zip,.step,.stp,.txt,.md,.csv"} />
        <button className="btn btn-primary" type="submit" disabled={busy} aria-busy={busy}>{busy ? "Uploading…" : mode === "specification" ? "Upload specifications" : "Add references"}</button>
      </div>
      {!!lines.length && <ul className="small" data-testid={`upload-${mode}-status`}>{lines.map((l, i) => <li key={i} className={l.ok === false ? "error-text" : l.ok ? "" : "muted"}>{l.text}</li>)}</ul>}
    </form>
  );
}
