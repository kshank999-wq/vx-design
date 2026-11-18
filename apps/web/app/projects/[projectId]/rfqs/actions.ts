"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { RfqManifest } from "@vx/contracts";
import { fail, requireUser } from "@/lib/auth";
import { lines } from "@/lib/rfq";

const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();
const num = (form: FormData, k: string) => (str(form, k) === "" ? undefined : Number(str(form, k)));
const page = (projectId: string, rfqId: string) => `/projects/${projectId}/rfqs/${rfqId}`;
function done(path: string, notice: string): never {
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}

export async function createRfq(projectId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("create_rfq", { p_project_id: projectId, p_title: str(form, "title"), p_category: str(form, "category") });
  if (error) fail(`/projects/${projectId}/rfqs`, error);
  done(page(projectId, data as string), "RFQ drafted. Fill in the manifest, choose what to disclose, and add suppliers.");
}

export async function saveManifest(projectId: string, rfqId: string, form: FormData) {
  const path = page(projectId, rfqId);
  const { supabase } = await requireUser();
  const parsed = RfqManifest.safeParse({
    project_code: str(form, "project_code"),
    buyer: { company: str(form, "buyer_company"), contact_name: str(form, "buyer_contact") || undefined,
             contact_email: str(form, "buyer_email") || undefined },
    classification: str(form, "classification"),
    quantities: { prototype: num(form, "qty_prototype") ?? 0, production: num(form, "qty_production"), forecast_annual: num(form, "qty_forecast") },
    materials: lines(str(form, "materials")),
    finish: str(form, "finish") || undefined,
    ctq_dimensions: str(form, "ctq").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [feature = "", nominal = "", tolerance = ""] = l.split("|").map((x) => x.trim());
      return { feature, nominal, tolerance };
    }),
    drawing_revision: str(form, "drawing_revision") || undefined,
    standards: lines(str(form, "standards")),
    compliance: str(form, "compliance") || undefined,
    tests_inspection: str(form, "tests_inspection") || undefined,
    tooling_ownership: str(form, "tooling_ownership"),
    shipping_terms: str(form, "shipping_terms"),
    quote_breakdown: lines(str(form, "quote_breakdown")),
    requirement_refs: form.getAll("requirement_refs").map(String),
    notes: str(form, "notes") || undefined,
  });
  if (!parsed.success) fail(path, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const { error } = await supabase.rpc("update_rfq", {
    p_rfq_id: rfqId, p_title: str(form, "title"), p_manifest: parsed.data, p_sharing_scope: str(form, "sharing_scope"),
    p_response_deadline: str(form, "response_deadline") || null,
  });
  if (error) fail(path, error);
  done(path, "Manifest saved.");
}

export async function setAttachments(projectId: string, rfqId: string, form: FormData) {
  const path = page(projectId, rfqId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_rfq_attachments", { p_rfq_id: rfqId, p_version_ids: form.getAll("version_ids").map(String) });
  if (error) fail(path, error);
  done(path, "Files to disclose saved.");
}

export async function addRecipient(projectId: string, rfqId: string, form: FormData) {
  const path = page(projectId, rfqId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("add_rfq_recipient", { p_rfq_id: rfqId, p_contact_id: str(form, "contact_id") });
  if (error) fail(path, error);
  done(path, "Supplier added.");
}

export async function removeRecipient(projectId: string, rfqId: string, recipientId: string) {
  const path = page(projectId, rfqId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("remove_rfq_recipient", { p_recipient_id: recipientId });
  if (error) fail(path, error);
  done(path, "Supplier removed.");
}

export async function setNda(projectId: string, rfqId: string, recipientId: string, form: FormData) {
  const path = page(projectId, rfqId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_rfq_nda", { p_recipient_id: recipientId, p_status: str(form, "nda_status"), p_note: str(form, "nda_note") || null });
  if (error) fail(path, error);
  done(path, "NDA status recorded.");
}

export async function buildPacket(projectId: string, rfqId: string) {
  const path = page(projectId, rfqId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("request_rfq_packet", { p_rfq_id: rfqId });
  if (error) fail(path, error);
  done(path, "Packet requested: a worker builds it; this page updates when it is ready.");
}

export async function approveDisclosure(projectId: string, rfqId: string, form: FormData) {
  const path = page(projectId, rfqId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("approve_rfq_disclosure", { p_rfq_id: rfqId, p_note: str(form, "note") || null });
  if (error) fail(path, error);
  done(path, "Disclosure approved: this packet, to these suppliers. Any change will need a new approval.");
}

export async function sendRfq(projectId: string, rfqId: string, form: FormData) {
  const path = page(projectId, rfqId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("send_rfq", { p_rfq_id: rfqId, p_window_days: Number(str(form, "window_days") || 21) });
  if (error) fail(path, error);
  done(path, "Released: each supplier's access window is open. Send them the emails below.");
}

export async function revokeAccess(projectId: string, rfqId: string, recipientId: string) {
  const path = page(projectId, rfqId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("revoke_rfq_access", { p_recipient_id: recipientId });
  if (error) fail(path, error);
  done(path, "Access revoked.");
}

export async function closeRfq(projectId: string, rfqId: string, quoteId: string | null, form: FormData) {
  const path = page(projectId, rfqId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("close_rfq", { p_rfq_id: rfqId, p_quote_id: quoteId, p_note: str(form, "note") || null });
  if (error) fail(path, error);
  done(path, quoteId ? "Supplier chosen and recorded as a decision. Place the order with them directly." : "RFQ closed.");
}

export async function cancelRfq(projectId: string, rfqId: string) {
  const path = page(projectId, rfqId);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("cancel_rfq", { p_rfq_id: rfqId });
  if (error) fail(path, error);
  done(path, "RFQ canceled.");
}
