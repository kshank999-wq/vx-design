import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { PrintButton } from "@/components/PrintButton";
import { SubmitButton } from "@/components/SubmitButton";
import { refreshFileTasks } from "@/components/FileTasks";
import { requireUser } from "@/lib/auth";
import { setFileTask } from "./actions";

const KIND: Record<string, string> = { datasheet: "Datasheet", "3d_model": "3D model (STEP file)", drawing: "Drawing", other: "File" };
const SEARCH: Record<string, string> = { datasheet: "datasheet pdf", "3d_model": "STEP 3D model download", drawing: "mechanical drawing pdf", other: "" };

/**
 * To do: files the design work needs that manufacturers publish (datasheets, 3D STEP models, drawings). Each item is its
 * own card with what to get, why, where, and who it is assigned to; the page prints as a dated checklist headed with the
 * project and the plan in use, to hand out to people.
 */
export default async function TodoPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: plan }] = await Promise.all([
    supabase.from("projects").select("name, description").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("plans").select("version").eq("project_id", projectId).eq("status", "approved").maybeSingle(),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";
  if (canEdit) await refreshFileTasks(supabase, projectId);
  const { data: rows } = await supabase.from("owner_file_tasks").select("id, kind, mpn, manufacturer, title, why, where_to_look, status, created_at, closed_at, tasks(title)")
    .eq("project_id", projectId).order("created_at");
  const open = (rows ?? []).filter((r) => r.status === "open");
  const closed = (rows ?? []).filter((r) => r.status !== "open");
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return (
    <main className="todo-page">
      <p className="crumbs no-print"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <div className="todo-head">
        <div>
          <h1>To do: files to get</h1>
          <p className="todo-meta" data-testid="todo-meta"><strong>{project.name}</strong>{plan ? <> · plan v{plan.version}</> : null} · {today} · {open.length} open{closed.length ? `, ${closed.length} done` : ""}</p>
        </div>
        <PrintButton />
      </div>
      <Banner error={error} notice={notice} />
      <p className="lead no-print">Files the design work needs that manufacturers publish on their websites. Download each one, then upload it on
        {" "}<Link href={`/projects/${projectId}/inputs`}>Inputs</Link> and add it to the part: the item ticks itself off. Print the list to hand items out.</p>

      {open.length === 0 && <p className="card">Nothing to do right now. New items appear here when the design work needs a file.</p>}
      <ol className="todo-list" data-testid="todo-list">
        {open.map((r, i) => {
          const q = encodeURIComponent([r.mpn, r.manufacturer, SEARCH[r.kind] ?? ""].filter(Boolean).join(" "));
          const step = (r.tasks as unknown as { title: string } | null)?.title;
          return (
            <li key={r.id} id={`item-${r.id}`} className="todo-item">
              <div className="todo-check" aria-hidden="true" />
              <div className="todo-body">
                <div className="todo-title"><span className="todo-n">{i + 1}.</span> <strong>{r.title}</strong> <span className="pill">{KIND[r.kind] ?? r.kind}</span></div>
                <dl className="todo-facts">
                  {r.mpn && <><dt>Part</dt><dd><span className="mono">{r.mpn}</span>{r.manufacturer ? ` · ${r.manufacturer}` : ""}</dd></>}
                  {r.why && <><dt>Why</dt><dd>{r.why}</dd></>}
                  {r.where_to_look && <><dt>Where</dt><dd>{r.where_to_look}</dd></>}
                  {step && <><dt>Asked by</dt><dd>the step "{step}"</dd></>}
                  <dt>Added</dt><dd>{new Date(r.created_at).toLocaleDateString()}</dd>
                </dl>
                <div className="todo-assign">Assigned to: <span className="todo-line" /> Done on: <span className="todo-line short" /></div>
                <div className="row tight wrap no-print">
                  {r.mpn && <a className="btn btn-small" href={`https://www.google.com/search?q=${q}`} target="_blank" rel="noreferrer">Search the web for it ↗</a>}
                  <Link className="btn btn-small" href={`/projects/${projectId}/inputs`}>Upload it on Inputs</Link>
                  {canEdit && <form action={setFileTask.bind(null, projectId, r.id, "done")}><SubmitButton variant="secondary">✓ Done</SubmitButton></form>}
                  {canEdit && <form action={setFileTask.bind(null, projectId, r.id, "not_needed")}><SubmitButton variant="secondary">Not needed</SubmitButton></form>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {closed.length > 0 && (
        <details className="no-print todo-closed">
          <summary>Done or not needed ({closed.length})</summary>
          <ul className="list">{closed.map((r) => (
            <li key={r.id}>{r.status === "done" ? "✓" : "–"} {r.title} <span className="muted small">· {r.status === "done" ? "done" : "not needed"}{r.closed_at ? ` ${new Date(r.closed_at).toLocaleDateString()}` : ""}</span>
              {canEdit && <form action={setFileTask.bind(null, projectId, r.id, "open")} style={{ display: "inline", marginLeft: 8 }}><SubmitButton variant="secondary">Open again</SubmitButton></form>}</li>))}</ul>
        </details>
      )}
    </main>
  );
}
