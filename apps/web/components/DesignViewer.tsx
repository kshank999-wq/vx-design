import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { BoardViewer } from "@/components/BoardViewer";
import { ZoomImage } from "@/components/ZoomImage";

/**
 * The workspace's design viewer, in tabs like a CAD tool: Files, Schematic, Layout, 3D view and Concepts. Each circuit
 * board has its own schematic, layout and 3D model (newest accepted version of each); 3D also offers the casing with the
 * screen and boards put together, and the casing laid open. Files are read straight from what the steps produced, so it
 * shows reused work from earlier plan versions too.
 */
export type ViewerTab = "files" | "schematic" | "layout" | "3d" | "concepts";
const TABS: [ViewerTab, string][] = [["files", "Files"], ["schematic", "Schematic"], ["layout", "Layout"], ["3d", "3D view"], ["concepts", "Concepts"]];

interface Out { id: string; name: string; suffix: string; key: string; status: string; validated: boolean; created_at: string; storage_path: string;
  board: string; title: string; summary: string | null }

export async function DesignViewer({ supabase, projectId, tab, board, base }: {
  supabase: SupabaseClient; projectId: string; tab: ViewerTab; board?: string; base: string;
}) {
  const { data: rows } = await supabase.from("artifact_versions")
    .select("id, status, validated_at, storage_path, created_at, summary, artifacts(name), tasks:produced_by_task_id(key, title, board)")
    .eq("project_id", projectId).neq("status", "superseded").order("created_at", { ascending: false }).limit(1500);
  // Newest version of each file, including work in progress (a step's latest attempt, before it is checked), so the
  // design can be watched as it takes shape; each view says which it is.
  const seen = new Set<string>();
  const outs: Out[] = [];
  for (const r of rows ?? []) {
    const name = (r.artifacts as unknown as { name: string } | null)?.name;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const t = r.tasks as unknown as { key: string; title: string; board: string | null } | null;
    const key = name.split("/")[0]!;
    outs.push({ id: r.id, name, suffix: name.split("/").pop() ?? "", key, status: r.status, validated: !!r.validated_at, created_at: r.created_at,
      storage_path: r.storage_path, board: t?.board ?? key, title: t?.title ?? key, summary: r.summary });
  }
  const of = (suffix: string) => outs.filter((o) => o.suffix === suffix);
  const sign = async (o?: Out) => o ? (await supabase.storage.from("project-files").createSignedUrl(o.storage_path, 3600)).data?.signedUrl ?? null : null;
  const casing = of("enclosure-assembled-3d")[0] ?? null;
  const casingOpen = of("enclosure-3d")[0] ?? null;

  // What each tab can show, per board.
  const boardsWith = (suffix: string) => [...new Map(of(suffix).map((o) => [o.board, o])).values()];
  const options = tab === "schematic" ? boardsWith("schematic-svg")
    : tab === "layout" ? boardsWith("render-top")
    : tab === "3d" ? boardsWith("board-glb") : [];
  const casingChoices = tab === "3d" ? [...(casing ? [["casing", "Casing, put together"]] : []), ...(casingOpen ? [["casing-open", "Casing, laid open"]] : [])] as [string, string][] : [];
  const pick = board ?? (tab === "3d" && casingChoices.length ? casingChoices[0]![0] : options[0]?.board);
  const href = (t: ViewerTab, b?: string) => `${base}?tab=${t}${b ? `&board=${encodeURIComponent(b)}` : ""}`;
  const boardName = (o: Out) => `${o.board === o.key ? o.title : `${o.board} board`}`;
  const stateOf = (o?: Out | null) => !o ? "" : o.status === "committed" ? "accepted" : o.validated ? "checked, waiting for approval" : "work in progress, not checked yet";
  const stamp = (o?: Out | null) => o ? <span className={`pill pill-${o.status === "committed" ? "complete" : o.validated ? "awaiting_approval" : "running"}`} data-testid="viewer-state">
    {stateOf(o)} · {new Date(o.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span> : null;

  let body: React.ReactNode = null;
  if (tab === "files") {
    const groups = new Map<string, Out[]>();
    for (const o of outs) groups.set(o.title, [...(groups.get(o.title) ?? []), o]);
    body = outs.length ? (
      <div className="viewer-files" data-testid="viewer-files">
        {[...groups].map(([title, list]) => (
          <details key={title}>
            <summary><strong>{title}</strong> <span className="muted small">{list.length} file{list.length > 1 ? "s" : ""}</span></summary>
            <ul className="list">{list.map((o) => (
              <li key={o.id}><Link href={`/projects/${projectId}/artifacts/${o.id}`} target="_blank">{o.suffix}</Link>
                <span className="muted small"> · {stateOf(o)} · {new Date(o.created_at).toLocaleDateString()}</span>
                {o.summary && <div className="small muted">{o.summary}</div>}</li>))}</ul>
          </details>
        ))}
      </div>
    ) : <p className="muted">No files yet: they appear here as steps finish.</p>;
  } else if (tab === "concepts") {
    body = <iframe className="ws-frame" src={`/projects/${projectId}/concepts?embed=1`} title="Concepts" data-testid="concepts-viewer" />;
  } else if (pick === "casing" || pick === "casing-open") {
    const o = pick === "casing" ? casing : casingOpen;
    const url = await sign(o ?? undefined);
    body = url ? <>
      <p className="small muted">{stamp(o)} {pick === "casing"
        ? "The casing put together: the lid is see-through so you can see how the screen (dark), the boards (green) and the parts sit inside. Drag to turn it, scroll to zoom."
        : "The casing laid open: the back shell with the boards and screen in it, and the front bezel beside it. Drag to turn it, scroll to zoom."}
        {o?.summary ? ` ${o.summary}.` : ""} <Link href={`/projects/${projectId}/artifacts/${of("fit-report")[0]?.id ?? o!.id}`} target="_blank">Fit report</Link></p>
      <BoardViewer src={url} />
    </> : null;
  } else {
    const o = options.find((x) => x.board === pick) ?? options[0];
    if (!o) {
      body = <p className="muted">{tab === "schematic" ? "No schematic drawings yet." : tab === "layout" ? "No board layouts yet." : "No 3D models yet."} They appear here as the steps finish.</p>;
    } else if (tab === "schematic") {
      const url = await sign(o);
      body = url && <><p className="small muted">{stamp(o)} {boardName(o)}: the circuit drawing. Use + and − to zoom, drag to move around.</p><ZoomImage src={url} alt={`Schematic of ${boardName(o)}`} light /></>;
    } else if (tab === "layout") {
      const bottom = of("render-bottom").find((x) => x.board === o.board);
      const [top, bot] = await Promise.all([sign(o), sign(bottom)]);
      body = <>
        <p className="small muted">{stamp(o)} {boardName(o)}: the routed board from the top{bot ? " and the bottom" : ""}. Use + and − to zoom.</p>
        {top && <ZoomImage src={top} alt={`Top of ${boardName(o)}`} />}
        {bot && <><h4>Bottom</h4><ZoomImage src={bot} alt={`Bottom of ${boardName(o)}`} /></>}
      </>;
    } else {
      const [glb, poster] = await Promise.all([sign(o), sign(of("render-3d").find((x) => x.board === o.board))]);
      body = glb && <><p className="small muted">{stamp(o)} {boardName(o)} with its parts. Drag to turn it, scroll to zoom.</p><BoardViewer src={glb} poster={poster ?? undefined} /></>;
    }
  }

  const chips = [...casingChoices, ...options.map((o) => [o.board, boardName(o)] as [string, string])];
  return (
    <div className="design-viewer" data-testid="design-viewer">
      <nav className="viewer-tabs" aria-label="Design views">
        {TABS.map(([t, label]) => <Link key={t} href={href(t)} className="viewer-tab" aria-current={t === tab ? "page" : undefined}>{label}</Link>)}
      </nav>
      {chips.length > 1 && (
        <div className="viewer-boards" aria-label="Choose what to show">
          {chips.map(([b, label]) => <Link key={b} href={href(tab, b)} className="chip" aria-current={b === pick ? "true" : undefined}>{label}</Link>)}
        </div>
      )}
      <div className="viewer-body">{body}</div>
    </div>
  );
}
