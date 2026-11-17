import Link from "next/link";
import { notFound } from "next/navigation";
import { Banner } from "@/components/Banner";
import { LicenseFlag } from "@/components/Knowledge";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { LICENSES, type License } from "@/lib/knowledge";
import { changeLicense, verifySource, withdrawSource } from "../../actions";

export default async function SourcePage({ params, searchParams }: {
  params: Promise<{ sourceId: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { sourceId } = await params;
  const { error, notice } = await searchParams;
  const { supabase, userId } = await requireUser();
  const { data: s } = await supabase.from("sources").select("*, projects(name)").eq("id", sourceId).maybeSingle();
  if (!s) notFound();
  const [{ data: chunks }, { data: editor }, { data: me }] = await Promise.all([
    supabase.from("source_chunks").select("ordinal, locator, text").eq("source_id", sourceId).order("ordinal").limit(60),
    supabase.from("knowledge_editors").select("user_id").eq("user_id", userId).maybeSingle(),
    s.project_id ? supabase.from("project_members").select("role").eq("project_id", s.project_id).eq("user_id", userId).maybeSingle()
                 : Promise.resolve({ data: null }),
  ]);
  const role = me?.role as string | undefined;
  const canWrite = s.project_id ? role === "owner" || role === "engineer" : !!editor;
  const canVerify = s.project_id ? role === "owner" || role === "reviewer" : !!editor;
  const fileUrl = s.storage_path
    ? (await supabase.storage.from(s.project_id ? "project-files" : "knowledge-files").createSignedUrl(s.storage_path, 3600)).data?.signedUrl
    : null;
  const lic = LICENSES[s.license as License];

  return (
    <main>
      <p className="crumbs"><Link href="/knowledge">Knowledge base</Link> /{s.project_id && <> <Link href={`/projects/${s.project_id}`}>{(s.projects as { name: string } | null)?.name}</Link> /</>}</p>
      <div className="row spread">
        <h1>{s.identifier ? `${s.identifier} — ` : ""}{s.title}</h1>
        <span className={`pill big pill-${s.status === "verified" ? "complete" : "awaiting_approval"}`} data-testid="source-status">{s.status}</span>
      </div>
      <Banner error={error} notice={notice} />
      {s.project_id && <p className="banner banner-warn">Private to this project. It is searched only within the project and never enters the shared library.</p>}
      <dl className="facts small card">
        <dt>Publisher</dt><dd>{s.publisher}</dd>
        <dt>Kind</dt><dd>{s.kind.replace("_", " ")}</dd>
        <dt>Edition</dt><dd>{s.edition ?? <span className="warn-text">not stated</span>}</dd>
        <dt>Official source</dt><dd>{s.official_url ? <a href={s.official_url} target="_blank" rel="noreferrer">{s.official_url}</a> : "none given"}</dd>
        <dt>Licence</dt><dd><LicenseFlag license={s.license} /> {lic.help}{s.license_note && <div className="muted">Terms: {s.license_note}</div>}</dd>
        <dt>Held here</dt><dd data-testid="held">{s.indexed_chunks} excerpt(s){fileUrl ? <> · <a href={fileUrl}>stored copy</a></> : " · no file kept"}</dd>
        <dt>Verified</dt><dd>{s.last_verified_at ? `${new Date(s.last_verified_at).toLocaleString()}: ${s.verification_note}` : <span className="warn-text">not yet</span>}</dd>
        {s.summary && <><dt>Summary</dt><dd>{s.summary}</dd></>}
      </dl>

      {(canVerify || canWrite) && s.status !== "withdrawn" && (
        <div className="grid2">
          {canVerify && (
            <form action={verifySource.bind(null, s.id)} className="card stack">
              <h3>Verify</h3>
              <p className="small muted">Confirm this is the official document and the edition is current.</p>
              <label>Edition<input name="edition" defaultValue={s.edition ?? ""} /></label>
              <label>How it was checked<input name="note" required placeholder="Compared with the publisher's page on …" /></label>
              <div><SubmitButton pendingText="Saving…">Mark verified</SubmitButton></div>
            </form>
          )}
          {canWrite && (
            <form action={changeLicense.bind(null, s.id)} className="card stack">
              <h3>Licence</h3>
              <p className="small muted">Moving to a licence that allows less deletes the excerpts or stored copy it no longer allows.</p>
              <select name="license" defaultValue={s.license} aria-label="New licence">
                {Object.entries(LICENSES).filter(([k]) => s.project_id || k !== "licensed_copy").map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
              </select>
              <label>Why<input name="note" required placeholder="What the terms say, or who confirmed it" /></label>
              <div><SubmitButton variant="secondary" pendingText="Saving…">Change licence</SubmitButton></div>
            </form>
          )}
        </div>
      )}

      <section>
        <h2>Excerpts</h2>
        {lic.excerpts ? (
          <ol className="excerpts" data-testid="excerpts">
            {(chunks ?? []).map((c) => <li key={c.ordinal}><div className="mono small">{c.locator}</div><div className="small pre">{c.text}</div></li>)}
            {!chunks?.length && <li className="muted">No excerpts indexed.</li>}
          </ol>
        ) : <p className="muted">This licence allows no text to be held. Use the official source.</p>}
        {s.indexed_chunks > (chunks?.length ?? 0) && <p className="small muted">Showing the first {chunks?.length} of {s.indexed_chunks}.</p>}
      </section>

      {canWrite && s.status !== "withdrawn" && (
        <form action={withdrawSource.bind(null, s.id)} className="row">
          <input name="note" placeholder="Why it is withdrawn" aria-label="Why it is withdrawn" />
          <SubmitButton variant="danger" pendingText="Withdrawing…">Withdraw</SubmitButton>
        </form>
      )}
    </main>
  );
}
