import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { ReadMore } from "@/components/ReadMore";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { approvePlanNow } from "../plans/[planId]/actions";

/**
 * The plan, in one place: the latest plan (a new version waiting for approval, or the one in use) with a big green
 * "Approve this plan", every step highlighted in the colour of the plan version that last changed it, a right-hand list of
 * every change in date order (click one to jump to it), and the archive of earlier versions with what each one changed.
 */
const COLORS = ["transparent", "#ffe3ee", "#f6ecd4", "#e2f5dc", "#dfeeff", "#ece5ff", "#ffe9d9", "#dbf5ef", "#fff6c4", "#f2e4f7", "#e6f0d6", "#fde2e2"];
const colorOf = (v: number) => (v <= 1 ? "transparent" : COLORS[((v - 2) % (COLORS.length - 1)) + 1]!);

type Task = { id: string; plan_id: string; key: string; title: string; description: string | null; status: string; stage: string | null; position: number };
type Change = { version: number; at: string; kind: "new" | "changed" | "taken out"; key: string; title: string };

export default async function PlanOverviewPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: plans }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("plans").select("id, version, status, created_at, approved_at, summary, generator").eq("project_id", projectId).order("version"),
  ]);
  if (!project) notFound();
  const all = plans ?? [];
  const inUse = [...all].reverse().find((p) => p.status === "approved") ?? null;
  // The latest plan: a newer version waiting for a decision (not one made before the plan in use was approved), else the one in use.
  const pending = [...all].reverse().find((p) => ["draft", "awaiting_approval"].includes(p.status) && (!inUse
    || (p.version > inUse.version && !(inUse.approved_at && new Date(inUse.approved_at) > new Date(p.created_at)))));
  const shown = pending ?? inUse ?? all.at(-1) ?? null;
  if (!shown) return <main><h1>Plan</h1><Banner error={error} notice={notice} /><p>No plan yet. Add your specifications on <Link href={`/projects/${projectId}/inputs`}>Inputs</Link> and make the plan there.</p></main>;

  const { data: tasks } = await supabase.from("tasks").select("id, plan_id, key, title, description, status, stage, position")
    .in("plan_id", all.map((p) => p.id)).order("position");
  const byPlan = new Map<string, Task[]>();
  for (const t of (tasks ?? []) as Task[]) byPlan.set(t.plan_id, [...(byPlan.get(t.plan_id) ?? []), t]);

  // What each version changed against the version before it, oldest first.
  const changes: Change[] = [];
  const lastChanged = new Map<string, number>();
  for (let i = 0; i < all.length; i++) {
    const p = all[i]!, prev = all[i - 1];
    const now = byPlan.get(p.id) ?? [];
    if (!prev) { for (const t of now) lastChanged.set(t.key, p.version); continue; }
    const before = new Map((byPlan.get(prev.id) ?? []).map((t) => [t.key, t]));
    for (const t of now) {
      const o = before.get(t.key);
      if (!o) { changes.push({ version: p.version, at: p.created_at, kind: "new", key: t.key, title: t.title }); lastChanged.set(t.key, p.version); }
      else if (o.title !== t.title || (o.description ?? "") !== (t.description ?? "")) {
        changes.push({ version: p.version, at: p.created_at, kind: "changed", key: t.key, title: t.title }); lastChanged.set(t.key, p.version);
      }
    }
    const keys = new Set(now.map((t) => t.key));
    for (const o of before.values()) if (!keys.has(o.key)) changes.push({ version: p.version, at: p.created_at, kind: "taken out", key: o.key, title: o.title });
  }
  const steps = byPlan.get(shown.id) ?? [];
  const canApprove = me?.role === "owner" && !!pending && shown.id === pending.id;
  const label = (s: string) => ({ draft: "Waiting for your approval", awaiting_approval: "Waiting for approval", approved: "In use", superseded: "Replaced" } as Record<string, string>)[s] ?? s;
  const done = steps.filter((t) => t.status === "complete").length;
  const shownChanges = changes.filter((c) => c.version <= shown.version);

  return (
    <main className="plan-overview">
      <div className="plan-main">
        <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
        <div className="row spread wrap">
          <h1>Plan v{shown.version} <span className={`pill pill-${shown.status} big`}>{label(shown.status)}</span></h1>
          {canApprove && (
            <form action={approvePlanNow.bind(null, projectId, shown.id, true)} data-testid="approve-plan-top">
              <SubmitButton variant="go" pendingText="Approving and starting…">✓ Approve this plan</SubmitButton>
            </form>
          )}
        </div>
        <Banner error={error} notice={notice} />
        {pending && inUse && shown.id === pending.id && (
          <p className="banner banner-warn">The work runs on <strong>v{inUse.version}</strong> now. This <strong>v{shown.version}</strong> is the proposed new version:
            approving it updates the plan, redoes only the steps the change affects, and starts the work again.{" "}
            <Link href={`/projects/${projectId}/plans/${shown.id}#approve-now`}>See exactly what changes and what is redone</Link>.</p>
        )}
        {shown.summary && <ReadMore text={shown.summary} lines={3} />}
        <p className="small muted">{steps.length} steps · {done} done · highlighted steps changed in the version shown by their colour (see the list on the right).</p>

        <ol className="plan-steps" data-testid="plan-steps">
          {steps.map((t) => {
            const v = lastChanged.get(t.key) ?? 1;
            return (
              <li key={t.id} id={`step-${t.key}`} className="plan-step" style={{ background: colorOf(v) }}>
                <div className="row spread wrap"><strong>{t.title}</strong>
                  <span className="small muted">{t.status === "complete" ? "✓ done" : t.status === "failed" ? "could not finish" : t.status === "blocked" ? "waiting" : "to do"}{v > 1 ? ` · changed in v${v}` : ""}</span></div>
                {t.description && <div className="small"><ReadMore text={t.description} lines={2} /></div>}
              </li>
            );
          })}
        </ol>

        <h2 id="archive">Earlier versions</h2>
        <ul className="list plan-archive" data-testid="plan-archive">
          {[...all].reverse().filter((p) => p.id !== shown.id).map((p) => {
            const c = changes.filter((x) => x.version === p.version);
            return (
              <li key={p.id} style={{ borderLeft: `6px solid ${colorOf(p.version) === "transparent" ? "var(--line)" : colorOf(p.version)}` }}>
                <Link href={`/projects/${projectId}/plans/${p.id}`}><strong>v{p.version}</strong></Link> <span className="muted small">· {(p.generator as { archived_at?: string } | null)?.archived_at ? "archived draft (never approved)" : label(p.status)} · {new Date(p.created_at).toLocaleDateString()}</span>
                <div className="small muted">{p.version === 1 ? "The first plan." : c.length ? `${c.filter((x) => x.kind === "changed").length} changed, ${c.filter((x) => x.kind === "new").length} new, ${c.filter((x) => x.kind === "taken out").length} taken out` : "No step changes."}</div>
              </li>
            );
          })}
        </ul>
      </div>

      <aside className="plan-changes" aria-label="Changes by version" data-testid="plan-changes">
        <h2>Changes</h2>
        <p className="small muted">Newest first. Click one to find it.</p>
        {[...shownChanges].reverse().map((c, i) => (
          <a key={i} href={c.kind === "taken out" ? "#archive" : `#step-${c.key}`} className="change-box" style={{ background: colorOf(c.version) }}>
            <span className="small"><strong>v{c.version}</strong> · {new Date(c.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {c.kind}</span>
            <span className={c.kind === "taken out" ? "struck" : undefined}>{c.title}</span>
          </a>
        ))}
        {!shownChanges.length && <p className="small muted">No changes since the first plan.</p>}
      </aside>
    </main>
  );
}
