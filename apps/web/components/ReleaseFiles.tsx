import { DEFAULT_RELEASE_KINDS } from "@/lib/production";

export interface CommittedFile { id: string; version: number; latest: boolean; artifact: string; kind: string; committed_at: string | null }

/** Checkbox list of committed files for a draft release: one version per file, the latest by default. */
export function ReleaseFiles({ files, chosen }: { files: CommittedFile[]; chosen?: string[] }) {
  const picked = new Set(chosen ?? files.filter((f) => f.latest && DEFAULT_RELEASE_KINDS.has(f.kind)).map((f) => f.id));
  if (!files.length) return <p className="small muted">No approved (committed) files yet. Files are committed when a run&apos;s task is approved.</p>;
  return (
    <fieldset className="small" data-testid="release-files">
      <legend>Files in the release (one version of each)</legend>
      {files.map((f) => (
        <label key={f.id} className="inline" style={{ display: "block" }}>
          <input type="checkbox" name="files" value={f.id} defaultChecked={picked.has(f.id)} aria-label={`${f.artifact} v${f.version}`} />
          {" "}{f.artifact} v{f.version} <span className="pill">{f.kind.replace("_", " ")}</span>{!f.latest && <span className="muted"> (older version)</span>}
        </label>
      ))}
    </fieldset>
  );
}
