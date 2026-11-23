import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { acceptAllRecommendations, answerQuestion } from "./actions";
import { DictateButton, ReadAloud } from "@/components/VoiceTools";

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
  const [{ data: project }, { data: me }, { data: runs }, { data: rows }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("runs").select("id, status, name").eq("project_id", projectId).order("created_at", { ascending: false }).limit(1),
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
      <p className="lead">Press 🔊 to hear a question read out, and 🎤 to speak your answer instead of typing it. These are decisions only you can make: preferences, priorities, budget and markets. <strong>The design work does not wait for them.</strong> Until you answer, VX Design follows its recommendation; every step after your answer uses what you chose.</p>
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
                    <div className="row spread q-head"><h3>{q.question}</h3>
                      <ReadAloud text={`${q.question} ${q.why ? `Why it matters: ${q.why}` : ""} VX Design recommends: ${q.recommendation}.${(q.options ?? []).length ? ` Your choices are: ${q.options!.join("; ")}.` : ""}`} /></div>
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
                          <textarea id={`answer-${q.id}`} name="custom" rows={2} placeholder="Or type or dictate your own answer" aria-label={`Your answer to: ${q.question}`} className="q-input" />
                          <div className="stack tight">
                            <DictateButton target={`answer-${q.id}`} />
                            <SubmitButton name="answer" value="__custom" pendingText="Saving…">Save my answer</SubmitButton>
                          </div>
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
      ) : (
        <div className="card q-allset" data-testid="all-answered">
          <p><strong>✓ All questions are answered.</strong> New ones appear here as the design work raises them.</p>
          {runs?.[0] && ["stopped", "completed"].includes(runs[0].status) && (
            <p>Your design run is <strong>stopped</strong>. Answering does not restart it: open the run and press continue. <Link className="btn" href={`/projects/${projectId}/runs/${runs[0].id}#continue-run`}>Go to the run →</Link></p>
          )}
          {runs?.[0] && ["running", "pending"].includes(runs[0].status) && <p>The design run is working and will use your answers. <Link href={`/projects/${projectId}/runs/${runs[0].id}`}>Watch the run</Link></p>}
        </div>
      )}
      {done.length > 0 && (() => {
        // Newest first, one collapsible box per question: answered, when, and the answer in its own coloured box.
        const sorted = [...done].sort((x, y) => (y.answered_at ?? y.created_at).localeCompare(x.answered_at ?? x.created_at));
        const how = (q: Q) => q.status === "dismissed" ? { label: "Set aside as not relevant", cls: "q-how-dismissed" }
          : q.answer?.trim() === q.recommendation.trim() ? { label: "Used the recommendation", cls: "q-how-rec" }
          : (q.options ?? []).includes(q.answer ?? "") ? { label: "Chose an option", cls: "q-how-option" }
          : { label: "Your own answer", cls: "q-how-own" };
        const when = (q: Q) => new Date(q.answered_at ?? q.created_at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
        return (
          <section className="q-group" data-testid="answered-questions">
            <h2>Your answers ({done.length})</h2>
            <p className="small muted">Newest first. Open any question to see your answer and when you gave it.</p>
            <div className="q-answers">
              {sorted.map((q) => { const h = how(q); return (
                <details key={q.id} className="card q-answer" data-testid="answer">
                  <summary>
                    <span className="q-check" aria-label="Answered">✓ Answered</span>
                    <span className="q-answer-q">{q.question}</span>
                    <span className="q-time">{when(q)}</span>
                  </summary>
                  <div className="q-answer-body">
                    <div className="q-answer-box">
                      <span className="q-answer-label">Answer</span>
                      <p>{q.status === "dismissed" ? "Not relevant (set aside)" : q.answer}</p>
                      <p className="small q-answer-meta">Answered {new Date(q.answered_at ?? q.created_at).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })} · <span className={`q-how ${h.cls}`}>{h.label}</span></p>
                    </div>
                    {q.status !== "dismissed" && q.answer?.trim() !== q.recommendation.trim() && <p className="small"><strong>VX Design had recommended:</strong> {q.recommendation}</p>}
                    {q.why && <p className="small"><strong>Why it mattered:</strong> {q.why}</p>}
                    {q.tasks?.title && <p className="small muted">Asked by the step: {q.tasks.title}</p>}
                  </div>
                </details>
              ); })}
            </div>
          </section>
        );
      })()}
    </main>
  );
}
