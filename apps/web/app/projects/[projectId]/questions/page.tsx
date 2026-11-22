import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { acceptAllRecommendations, answerQuestion } from "./actions";

interface Q {
  id: string; question: string; why: string | null; recommendation: string; options: string[] | null; status: string;
  answer: string | null; answered_at: string | null; created_at: string; tasks: { title: string } | null;
}

export default async function QuestionsPage({ params, searchParams }: {
  params: Promise<{ projectId: string }>; searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { projectId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: rows }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("project_questions").select("id, question, why, recommendation, options, status, answer, answered_at, created_at, tasks(title)")
      .eq("project_id", projectId).order("created_at"),
  ]);
  if (!project) notFound();
  const canAnswer = ["owner", "engineer", "reviewer", "client"].includes(me?.role ?? "");
  const qs = (rows ?? []) as unknown as Q[];
  const open = qs.filter((q) => q.status === "open");
  const done = qs.filter((q) => q.status !== "open").reverse();
  // Grouped by the step that raised them, in the order they came up.
  const groups = new Map<string, Q[]>();
  for (const q of open) { const k = q.tasks?.title ?? "General"; groups.set(k, [...(groups.get(k) ?? []), q]); }

  return (
    <main className="questions-page">
      <p className="crumbs"><Link href="/projects">Projects</Link> / <Link href={`/projects/${projectId}`}>{project.name}</Link> /</p>
      <h1>Questions for you</h1>
      <Banner error={error} notice={notice} />
      <p className="lead">These are decisions only you can make: preferences, priorities, budget and markets. <strong>The design work does not wait for them.</strong> Until you answer, VX Design follows its recommendation; every step after your answer uses what you chose.</p>
      {open.length > 0 ? (
        <>
          <div className="card row spread q-summary">
            <span><strong>{open.length} open question{open.length > 1 ? "s" : ""}</strong> from {groups.size} step{groups.size > 1 ? "s" : ""}{done.length ? ` · ${done.length} already answered` : ""}</span>
            {canAnswer && <form action={acceptAllRecommendations.bind(null, projectId)}><SubmitButton variant="secondary" pendingText="Saving…">Accept all recommendations</SubmitButton></form>}
          </div>
          {[...groups].map(([step, list]) => (
            <section key={step} className="q-group">
              <h2><span className="muted small">Raised by</span> {step}</h2>
              {list.map((q, i) => (
                <article key={q.id} className="card q-card" data-testid="question">
                  <div className="q-num">{i + 1}</div>
                  <div className="q-body">
                    <h3>{q.question}</h3>
                    {q.why && <p className="q-why"><strong>Why it matters:</strong> {q.why}</p>}
                    <div className="q-rec" data-testid="recommendation"><span className="q-rec-badge">★ Recommended</span><p>{q.recommendation}</p>
                      <p className="small muted">VX Design follows this until you answer.</p></div>
                    {canAnswer ? (
                      <form className="stack" action={answerQuestion.bind(null, projectId, q.id)}>
                        {(q.options ?? []).length > 0 && (
                          <div className="q-options">{q.options!.map((o) => (
                            <button key={o} type="submit" name="answer" value={o} className={`btn ${o === q.options![0] ? "q-opt-rec" : "btn-secondary"}`}>{o === q.options![0] ? `★ ${o}` : o}</button>
                          ))}</div>
                        )}
                        <div className="row tight wrap">
                          <input name="custom" placeholder="Or write your own answer" aria-label={`Your answer to: ${q.question}`} className="q-input" />
                          <SubmitButton name="answer" value="__custom" pendingText="Saving…">Save my answer</SubmitButton>
                        </div>
                        <div className="row tight wrap small">
                          <SubmitButton variant="secondary" name="answer" value="__recommended" pendingText="Saving…">Use the recommendation</SubmitButton>
                          <SubmitButton variant="secondary" name="answer" value="__dismiss" pendingText="Saving…">Not relevant</SubmitButton>
                        </div>
                      </form>
                    ) : <p className="small muted">The project owner answers this.</p>}
                  </div>
                </article>
              ))}
            </section>
          ))}
        </>
      ) : <div className="card"><p><strong>No open questions.</strong> New ones appear here as the design work raises them.</p></div>}
      {done.length > 0 && (
        <section className="q-group" data-testid="answered-questions">
          <h2>Your answers ({done.length})</h2>
          <div className="card"><ul className="q-done">{done.map((q) => (
            <li key={q.id}><span>{q.question}</span> <strong>{q.status === "dismissed" ? "Not relevant" : q.answer}</strong>
              {q.tasks?.title && <span className="muted small"> · {q.tasks.title}</span>}</li>
          ))}</ul></div>
        </section>
      )}
    </main>
  );
}
