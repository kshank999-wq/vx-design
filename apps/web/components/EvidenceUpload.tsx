"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Scope captures, photos, logs: uploaded straight to the run's evidence folder, then registered with their sha256. */
export function EvidenceUpload({ projectId, runId }: { projectId: string; runId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const kind = String(form.get("kind") ?? "other");
    const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) { setError("Choose at least one file."); return; }
    setBusy(true); setError(null);
    const supabase = createClient();
    try {
      for (const f of files) {
        if (f.size > 50 * 1048576) throw new Error(`${f.name} is larger than 50 MB`);
        const sha = hex(await crypto.subtle.digest("SHA-256", await f.arrayBuffer()));
        const path = `${projectId}/evidence/${runId}/${sha.slice(0, 12)}-${f.name.replace(/[^\w.-]+/g, "_").slice(-100)}`;
        const up = await supabase.storage.from("project-files").upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false });
        if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new Error(`${f.name}: ${up.error.message}`);
        const { error: e2 } = await supabase.rpc("add_test_evidence", { p_run_id: runId, p_name: f.name, p_kind: kind, p_path: path, p_sha256: sha, p_size: f.size });
        if (e2) throw new Error(`${f.name}: ${e2.message}`);
      }
      (e.target as HTMLFormElement).reset();
      router.refresh();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={onSubmit} className="card row" data-testid="evidence-upload">
      <label className="inline">Kind<select name="kind" defaultValue="scope" aria-label="Evidence kind">
        {["scope", "photo", "log", "data", "report", "other"].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
      <input type="file" name="files" multiple aria-label="Evidence files" />
      <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Uploading…" : "Attach evidence"}</button>
      {error && <p role="alert" className="banner banner-error">{error}</p>}
    </form>
  );
}
