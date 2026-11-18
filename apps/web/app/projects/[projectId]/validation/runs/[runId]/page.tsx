import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { EvidenceUpload } from "@/components/EvidenceUpload";
import { ScanBadge } from "@/components/ScanBadge";
import { requireUser } from "@/lib/auth";
import { limitText } from "@/lib/validation";

export default async function RunPage({ params, searchParams }: {
  params: Promise<{ projectId: string; runId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId, runId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: r }, { data: ms }, { data: ev }, { data: me }, { data: faults }, { data: later }] = await Promise.all([
    supabase.from("test_runs").select("*, units(serial, revision), test_procedures(id, code, version, title, status, measurements)").eq("id", runId).eq("project_id", projectId).maybeSingle(),
    supabase.from("test_measurements").select("*").eq("run_id", runId).order("key"),
    supabase.from("test_evidence").select("*").eq("run_id", runId).order("added_at"),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("faults").select("id, fault_no, title, status").eq("run_id", runId),
    supabase.from("test_runs").select("id, run_no").eq("supersedes_id", runId).maybeSingle(),
  ]);
  if (!r) notFound();
  const unit = r.units as unknown as { serial: string; revision: string };
  const proc = r.test_procedures as unknown as { id: string; code: string; version: number; title: string; status: string; measurements: { key: string }[] };
  const order = new Map(proc.measurements.map((d, i) => [d.key, i]));
  const measured = [...(ms ?? [])].sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9));
  const cond = r.conditions as { temperature_c?: number | null; supply_v?: number | null; firmware?: string | null; location?: string | null;
                                 equipment?: { name: string; id: string | null; calibrated_until: string | null }[] };
  const role = me?.role ?? "viewer";
  const paths = (ev ?? []).map((e) => e.storage_path);
  const [{ data: urls }, { data: scans }] = paths.length
    ? await Promise.all([supabase.storage.from("project-files").createSignedUrls(paths, 600),
                         supabase.from("file_scans").select("path, status, signature").eq("bucket", "project-files").in("path", paths)])
    : [{ data: [] }, { data: [] }];
  const url = new Map((urls ?? []).map((u) => [u.path, u.signedUrl]));
  const scan = new Map((scans ?? []).map((s) => [s.path, s]));
  const performedBy = r.performed_by === userId ? "you" : "a project member";

  return (
    <main>
      <p className="crumbs"><Link href={`/projects/${projectId}/validation`}>Build and validation</Link> /</p>
      <h1>Run {r.run_no}: {proc.code} v{proc.version} on {unit.serial} <span className={`pill big pill-verdict-${r.verdict}`} data-testid="run-verdict">{r.verdict}</span></h1>
      <Banner error={error} notice={notice} />
      {later && <p className="banner banner-warn">Superseded by <Link href={`/projects/${projectId}/validation/runs/${later.id}`}>run {later.run_no}</Link>.</p>}
      {r.supersedes_id && <p className="small">Corrects an earlier run: {r.notes}</p>}
      <dl className="facts">
        <dt>Procedure</dt><dd><Link href={`/projects/${projectId}/validation/procedures/${proc.id}`}>{proc.code} v{proc.version}</Link> {proc.title}</dd>
        <dt>Unit</dt><dd>{unit.serial} (revision {unit.revision})</dd>
        <dt>Performed</dt><dd>{new Date(r.performed_at).toLocaleString()} by {performedBy}; recorded {new Date(r.recorded_at).toLocaleString()}</dd>
        <dt>Conditions</dt><dd>{[cond.temperature_c != null ? `${cond.temperature_c} °C` : null, cond.supply_v != null ? `supply ${cond.supply_v} V` : null,
          cond.firmware ? `firmware ${cond.firmware}` : null, cond.location].filter(Boolean).join(" · ") || "not recorded"}</dd>
        <dt>Equipment</dt><dd>{cond.equipment?.length ? cond.equipment.map((q) => `${q.name}${q.id ? ` (${q.id})` : ""}${q.calibrated_until ? `, calibrated until ${q.calibrated_until}` : ", calibration not recorded"}`).join("; ") : "not recorded"}</dd>
        {r.notes && !r.supersedes_id && <><dt>Notes</dt><dd>{r.notes}</dd></>}
      </dl>
      <h2>Measurements</h2>
      <table className="small" data-testid="measurements">
        <thead><tr><th>Measurement</th><th>Value</th><th>Limit (approved)</th><th>Requirement</th><th>Result</th></tr></thead>
        <tbody>{measured.map((m) => (
          <tr key={m.key} data-key={m.key}><td>{m.label}</td><td>{m.value_num ?? m.value_text ?? "—"}{m.unit && (m.value_num != null) ? ` ${m.unit}` : ""}</td>
            <td>{limitText(m)}</td><td>{m.requirement_ref ?? "—"}</td><td><span className={`pill pill-verdict-${m.verdict}`}>{m.verdict}</span></td></tr>
        ))}</tbody>
      </table>
      {!!faults?.length && <p className="small">Fault opened: {faults.map((f) => `F-${String(f.fault_no).padStart(3, "0")} (${f.status})`).join(", ")}</p>}
      <h2>Evidence</h2>
      <ul className="list small" data-testid="evidence">{(ev ?? []).map((e) => (
        <li key={e.id}>{url.get(e.storage_path) && scan.get(e.storage_path)?.status !== "infected" ? <a href={url.get(e.storage_path)!}>{e.name}</a> : e.name}
          {" "}<span className="pill">{e.kind}</span> <ScanBadge status={scan.get(e.storage_path)?.status} signature={scan.get(e.storage_path)?.signature} />
          <span className="muted"> sha256 {e.sha256.slice(0, 12)} · {Math.max(1, Math.round(e.size_bytes / 1024))} KB</span></li>
      ))}{!ev?.length && <li className="muted">No evidence attached.</li>}</ul>
      {(role === "owner" || role === "engineer") && <EvidenceUpload projectId={projectId} runId={r.id} />}
      {(role === "owner" || role === "engineer" || role === "reviewer") && !later && proc.status === "approved" && (
        <p className="small"><Link href={`/projects/${projectId}/validation/record?procedure=${proc.id}&unit=${r.unit_id}&supersedes=${r.id}`}>Record a correction or retest of this run</Link></p>
      )}
    </main>
  );
}
