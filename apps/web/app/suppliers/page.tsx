import Link from "next/link";
import { Banner } from "@/components/Banner";
import { SubmitButton } from "@/components/SubmitButton";
import { requireUser } from "@/lib/auth";
import { ManufacturerFields } from "@/components/Suppliers";
import { CATEGORIES, CATEGORY_LABEL, MFR_STATUS } from "@/lib/rfq";
import { addManufacturer } from "./actions";

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<{ category?: string; error?: string; notice?: string }> }) {
  const { category, error, notice } = await searchParams;
  const { supabase } = await requireUser();
  const { data: allowed } = await supabase.rpc("is_directory_user");
  let q = supabase.from("manufacturers").select("id, display_name, country, categories, status, website, manufacturer_contacts(email_status)").order("display_name");
  if (category && CATEGORIES.includes(category as never)) q = q.contains("categories", [category]);
  const { data: mfrs, error: e } = await q;

  return (
    <main>
      <h1>Suppliers</h1>
      <p className="muted">The shared manufacturer directory. Candidates are research targets, not endorsements: a supplier is
        <strong> verified</strong> once its legal identity, country and processes are confirmed, and joins the approved vendor list when a
        library editor approves it. Contacts are used only after their email is confirmed: never guessed.</p>
      <Banner error={error ?? e?.message} notice={notice} />
      {!allowed ? <p className="muted">The directory is for project owners and engineers.</p> : (
        <>
          <form className="row" method="get">
            <select name="category" defaultValue={category ?? ""} aria-label="Category">
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
            <button className="btn btn-secondary" type="submit">Filter</button>
          </form>
          <table data-testid="suppliers">
            <thead><tr><th>Supplier</th><th>Country</th><th>Categories</th><th>Contacts</th><th>Status</th></tr></thead>
            <tbody>
              {(mfrs ?? []).map((m) => {
                const contacts = (m.manufacturer_contacts ?? []) as { email_status: string }[];
                const ok = contacts.filter((c) => c.email_status === "verified").length;
                return (
                  <tr key={m.id} data-name={m.display_name}>
                    <td><Link href={`/suppliers/${m.id}`}>{m.display_name}</Link></td>
                    <td>{m.country ?? "—"}</td>
                    <td className="small">{(m.categories as string[]).map((c) => CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL]).join(", ")}</td>
                    <td className="small">{contacts.length ? `${ok} confirmed${contacts.length > ok ? `, ${contacts.length - ok} to verify` : ""}` : <span className="warn-text">none</span>}</td>
                    <td><span className={`pill pill-mfr-${m.status}`}>{MFR_STATUS[m.status]}</span></td>
                  </tr>
                );
              })}
              {!mfrs?.length && <tr><td colSpan={5} className="muted">No suppliers in this category yet.</td></tr>}
            </tbody>
          </table>
          <details className="card">
            <summary>Add a supplier</summary>
            <form action={addManufacturer} className="stack">
              <ManufacturerFields />
              <div><SubmitButton pendingText="Adding…">Add supplier</SubmitButton></div>
            </form>
          </details>
        </>
      )}
    </main>
  );
}
