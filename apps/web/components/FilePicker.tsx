"use client";
import { useRef, useState } from "react";

const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*|__MACOSX\/.*)$/i;

/** Every file under a dropped folder (recursively). */
async function walk(entry: FileSystemEntry, prefix = ""): Promise<File[]> {
  if (entry.isFile) {
    const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    return [new File([f], f.name, { type: f.type, lastModified: f.lastModified })].map((x) => Object.assign(x, { relativePath: `${prefix}${f.name}` }));
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const out: File[] = [];
  for (;;) {   // readEntries returns at most 100 entries at a time
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) out.push(...await walk(e, `${prefix}${entry.name}/`));
  }
  return out;
}

const pathOf = (f: File) => (f as File & { relativePath?: string }).relativePath || f.webkitRelativePath || f.name;

/**
 * Files, a whole folder, or anything dragged onto it (files and folders, with their subfolders). System clutter
 * (.DS_Store, Thumbs.db, __MACOSX) is left out. The parent holds the chosen files.
 */
export function FilePicker({ label, accept, files, onChange, disabled }: {
  label: string; accept?: string; files: File[]; onChange: (f: File[]) => void; disabled?: boolean;
}) {
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null), dirRef = useRef<HTMLInputElement>(null);
  const add = (more: File[]) => {
    const keep = more.filter((f) => f.size > 0 && !JUNK.test(pathOf(f)));
    const seen = new Set(files.map((f) => `${pathOf(f)}:${f.size}`));
    onChange([...files, ...keep.filter((f) => !seen.has(`${pathOf(f)}:${f.size}`))]);
  };
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    if (entries.length) add((await Promise.all(entries.map((en) => walk(en)))).flat());
    else add([...e.dataTransfer.files]);
  }
  const folders = new Set(files.map((f) => pathOf(f).split("/").slice(0, -1).join("/")).filter(Boolean));
  return (
    <div className={`file-picker${over ? " over" : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
         data-testid="file-picker">
      <div className="row">
        <input ref={fileRef} type="file" multiple accept={accept} aria-label={label} disabled={disabled} className="fp-input"
               onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ""; }} />
        <button type="button" className="btn" disabled={disabled} onClick={() => fileRef.current?.click()}>Choose files</button>
        <input ref={dirRef} type="file" multiple aria-label="Pick a folder" disabled={disabled} className="fp-input"
               {...{ webkitdirectory: "", directory: "" }} onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ""; }} />
        <button type="button" className="btn" disabled={disabled} onClick={() => dirRef.current?.click()}>Choose a folder</button>
        <span className="small muted">or drag files and folders here</span>
      </div>
      {files.length > 0 && (
        <div className="small fp-chosen" data-testid="files-chosen">
          <strong>{files.length} file(s)</strong>{folders.size ? ` from ${folders.size} folder(s)` : ""} · {(files.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1)} MB
          <button type="button" className="btn btn-link" onClick={() => onChange([])} disabled={disabled}>Clear</button>
          <details><summary>List</summary><ul className="plain">{files.map((f) => <li key={`${pathOf(f)}:${f.size}`}>{pathOf(f)}</li>)}</ul></details>
        </div>
      )}
    </div>
  );
}
