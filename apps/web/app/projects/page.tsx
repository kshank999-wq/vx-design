import Link from "next/link";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { createProject } from "./actions";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const { supabase } = await requireUser();
  // Invitations sent to this email before the account existed become memberships on first visit.
  await supabase.rpc("accept_invitations");
  const invites = ((await supabase.rpc("supplier_rfqs").select("recipient_id")).data ?? []) as unknown[];
  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, description, created_at, plans(status, version)")
    .order("created_at", { ascending: false });

  return (
    <main>
      <h1>Projects</h1>
      <Banner error={error} />
      {!!invites.length && (
        <p className="banner banner-notice" data-testid="supplier-invites">You have {invites.length} request(s) for quotation.{" "}
          <Link href="/supplier">Open the supplier portal</Link></p>
      )}
      <ul className="list">
        {(projects ?? []).map((p) => {
          const approved = p.plans?.find((pl: { status: string }) => pl.status === "approved") as { version: number } | undefined;
          return (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`}><strong>{p.name}</strong></Link>
              {p.description && <span className="muted"> — {p.description}</span>}
              <span className="pill">{approved ? `baseline v${approved.version}` : "no approved plan"}</span>
            </li>
          );
        })}
        {!projects?.length && <li className="muted">No projects yet.</li>}
      </ul>
      <form action={createProject} className="card stack">
        <h2>New project</h2>
        <label>Name<input name="name" required placeholder="Smart Slate" /></label>
        <label>Description<input name="description" placeholder="Optional" /></label>
        <label className="inline"><input type="checkbox" name="stage_gates" defaultChecked /> Stage gates: work waits for each stage (S0–S8) to be signed off</label>
        <div><SubmitButton pendingText="Creating…">Create project</SubmitButton></div>
      </form>
    </main>
  );
}
