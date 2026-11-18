import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { CATEGORIES, CATEGORY_LABEL, RFQ_STATUS } from "@/lib/rfq";
import { createRfq } from "./actions";

export default async function RfqsPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string }>;
}) {
  const { projectId } = await params;
  const { error } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: rfqs }] = await Promise.all([
    supabase.from("projects").select("id, name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("rfqs").select("id, rfq_no, title, category, status, response_deadline, rfq_recipients(status)").eq("project_id", projectId).order("rfq_no", { ascending: false }),
  ]);
  if (!project) notFound();
  const canEdit = me?.role === "owner" || me?.role === "engineer";

  return (
    <main>
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Requests for quotation</h1>
      <p className="muted">Each RFQ discloses only what you choose: the manifest, selected requirements and approved design files. The owner approves
        the exact packet and the suppliers before anything is released, and every step is in the audit log. Find suppliers in the <Link href="/suppliers">directory</Link>.</p>
      <Banner error={error} />
      <table data-testid="rfqs">
        <thead><tr><th>RFQ</th><th>Category</th><th>Suppliers</th><th>Due</th><th>Status</th></tr></thead>
        <tbody>
          {(rfqs ?? []).map((r) => {
            const rec = (r.rfq_recipients ?? []) as { status: string }[];
            return (
              <tr key={r.id}>
                <td><Link href={`/projects/${projectId}/rfqs/${r.id}`}>RFQ-{String(r.rfq_no).padStart(3, "0")}: {r.title}</Link></td>
                <td className="small">{CATEGORY_LABEL[r.category as keyof typeof CATEGORY_LABEL]}</td>
                <td className="small">{rec.length}{rec.some((x) => x.status === "quoted") ? ` (${rec.filter((x) => x.status === "quoted").length} quoted)` : ""}</td>
                <td className="small">{r.response_deadline ?? "—"}</td>
                <td><span className={`pill pill-rfq-${r.status}`}>{RFQ_STATUS[r.status]}</span></td>
              </tr>
            );
          })}
          {!rfqs?.length && <tr><td colSpan={5} className="muted">No RFQs yet.</td></tr>}
        </tbody>
      </table>
      {canEdit && (
        <form action={createRfq.bind(null, projectId)} className="card stack">
          <h2 style={{ marginTop: 0 }}>New RFQ</h2>
          <div className="grid2">
            <label>Title<input name="title" required placeholder="Timecode board, 5 assembled" /></label>
            <label>Category<select name="category" defaultValue="pcba">{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></label>
          </div>
          <div><SubmitButton pendingText="Creating…">Create RFQ</SubmitButton></div>
        </form>
      )}
    </main>
  );
}
