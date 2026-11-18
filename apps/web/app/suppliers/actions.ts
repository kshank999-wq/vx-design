"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, requireUser } from "@/lib/auth";
import { CATEGORIES, lines } from "@/lib/rfq";

const str = (form: FormData, k: string) => String(form.get(k) ?? "").trim();
const done = (path: string, notice: string) => {
  revalidatePath(path);
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
};

function fields(form: FormData) {
  const certs = lines(str(form, "certifications")).map((c) => {
    const [name, ...evidence] = c.split(":");
    return { name: name!.trim(), evidence: evidence.join(":").trim() || null };
  });
  return {
    display_name: str(form, "display_name"),
    legal_name: str(form, "legal_name") || null,
    country: str(form, "country").toUpperCase() || null,
    website: str(form, "website") || null,
    categories: form.getAll("categories").map(String).filter((c) => CATEGORIES.includes(c as never)),
    processes: lines(str(form, "processes")),
    certifications: certs,
    nda_method: str(form, "nda_method") || "unknown",
    file_formats: lines(str(form, "file_formats")),
    lead_time_note: str(form, "lead_time_note") || null,
    notes: str(form, "notes") || null,
  };
}

export async function addManufacturer(form: FormData) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from("manufacturers").insert(fields(form)).select("id").single();
  if (error) fail("/suppliers", error);
  done(`/suppliers/${data.id}`, "Added as a candidate. Confirm its legal identity and processes, then verify it.");
}

export async function updateManufacturer(id: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("manufacturers").update(fields(form)).eq("id", id);
  if (error) fail(`/suppliers/${id}`, error);
  done(`/suppliers/${id}`, "Saved. (Changing the legal name, country or processes of a verified supplier sends it back to candidate.)");
}

export async function verifyManufacturer(id: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("verify_manufacturer", { p_id: id, p_note: str(form, "note") });
  if (error) fail(`/suppliers/${id}`, error);
  done(`/suppliers/${id}`, "Verified.");
}

export async function setManufacturerStatus(id: string, status: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_manufacturer_status", { p_id: id, p_status: status, p_note: str(form, "note") || null });
  if (error) fail(`/suppliers/${id}`, error);
  done(`/suppliers/${id}`, status === "approved" ? "Added to the approved vendor list." : `Status set to ${status}.`);
}

export async function addContact(id: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("manufacturer_contacts").insert({
    manufacturer_id: id, name: str(form, "name"), role: str(form, "role") || null,
    email: str(form, "email").toLowerCase() || null, phone: str(form, "phone") || null,
  });
  if (error) fail(`/suppliers/${id}`, error);
  done(`/suppliers/${id}`, "Contact added. Its email is marked \"verify contact\" until someone records how it was confirmed.");
}

export async function verifyContact(id: string, contactId: string, form: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("verify_contact", { p_id: contactId, p_source: str(form, "source") });
  if (error) fail(`/suppliers/${id}`, error);
  done(`/suppliers/${id}`, "Email confirmed.");
}

export async function removeContact(id: string, contactId: string) {
  const { supabase } = await requireUser();
  const { error } = await supabase.from("manufacturer_contacts").delete().eq("id", contactId);
  if (error) fail(`/suppliers/${id}`, error.code === "23503" ? "This contact is on an RFQ and cannot be removed." : error);
  done(`/suppliers/${id}`, "Contact removed.");
}
