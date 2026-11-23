"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { FilePicker } from "./FilePicker";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "rev";

/**
 * Uploads Flux export files straight to the project's storage folder (large ZIPs and STEP files never pass through
 * the web server), then registers each with its revision and sha256.
 */
export function FluxUpload({ projectId, auditId, revisions, hint }: { projectId: string; auditId: string; revisions: string[]; hint?: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<File[]>([]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const revision = String(form.get("revision") ?? "").trim();
    const date = String(form.get("revision_date") ?? "") || null;
    const files = picked;
    // Files from a folder keep their sub-folder in the name when two share a file name.
    const rel = (f: File) => ((f as File & { relativePath?: string }).relativePath || f.webkitRelativePath || f.name);
    const base = (f: File) => f.name;
    const dup = new Set(files.map(base).filter((n, i, a) => a.indexOf(n) !== i));
    const nameOf = (f: File) => (dup.has(f.name) ? rel(f).split("/").slice(1).join("/") || f.name : f.name);
    if (!revision || !files.length) { setError("Give the revision a name and choose at least one file."); return; }
    setBusy(true); setError(null); setStatus([]);
    const supabase = createClient();
    try {
      for (const f of files) {
        const name = nameOf(f);
        setStatus((s) => [...s, `${name}: hashing…`]);
        const sha = hex(await crypto.subtle.digest("SHA-256", await f.arrayBuffer()));
        const path = `${projectId}/flux/${auditId}/${slug(revision)}/${sha.slice(0, 12)}-${name.replace(/[^\w.-]+/g, "_").slice(-120)}`;
        setStatus((s) => [...s.slice(0, -1), `${name}: uploading ${(f.size / 1048576).toFixed(1)} MB…`]);
        const up = await supabase.storage.from("project-files").upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
        if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new Error(`${name}: ${up.error.message}`);
        const { error: e2 } = await supabase.rpc("add_flux_file", { p_audit_id: auditId, p_revision: revision, p_revision_date: date,
                                                                     p_name: name, p_path: path, p_sha256: sha, p_size: f.size });
        if (e2) throw new Error(`${name}: ${e2.message}`);
        setStatus((s) => [...s.slice(0, -1), `${name}: added`]);
      }
      (e.target as HTMLFormElement).reset();
      setPicked([]);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card stack" data-testid="flux-upload">
      <h3>Add files</h3>
      <p className="small muted">{hint ?? "The design files and exports."} Add notes, reports and screenshots too. ZIPs are unpacked.
        Upload each revision you have under its own name, oldest first or with dates. You can drop the whole folder.</p>
      <div className="grid2">
        <label>Revision<input name="revision" required list="flux-revisions" placeholder="Rev C" /></label>
        <label>Date of this revision (optional)<input name="revision_date" type="date" /></label>
      </div>
      <datalist id="flux-revisions">{revisions.map((r) => <option key={r} value={r} />)}</datalist>
      <FilePicker label="Files" files={picked} onChange={setPicked} disabled={busy} />
      <div className="row"><button className="btn btn-primary" type="submit" disabled={busy} aria-busy={busy}>{busy ? "Uploading…" : "Upload"}</button></div>
      {error && <p role="alert" className="banner banner-error">{error}</p>}
      {!!status.length && <ul className="small" data-testid="upload-status">{status.map((s, i) => <li key={i}>{s}</li>)}</ul>}
    </form>
  );
}
