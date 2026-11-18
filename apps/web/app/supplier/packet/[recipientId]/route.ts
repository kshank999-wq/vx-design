import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Opens the packet (recorded in the buyer's audit log) and redirects to a short-lived download link. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ recipientId: string }> }) {
  const { recipientId } = await params;
  const back = (msg: string) => NextResponse.redirect(new URL(`/supplier?error=${encodeURIComponent(msg)}`, req.url), 303);
  const supabase = await createClient();
  const { data: path, error } = await supabase.rpc("supplier_open_rfq", { p_recipient_id: recipientId });
  if (error) return back(error.message);
  const ref = req.nextUrl.searchParams.get("ref")?.replace(/[^A-Za-z0-9-]/g, "") || "rfq-packet";
  const { data, error: e2 } = await supabase.storage.from("project-files").createSignedUrl(path as string, 120, { download: `${ref}.zip` });
  if (e2 || !data) return back(e2?.message ?? "Could not create the download link.");
  return NextResponse.redirect(data.signedUrl, 303);
}
