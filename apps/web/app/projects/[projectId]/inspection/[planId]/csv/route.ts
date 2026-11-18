import { NextResponse, type NextRequest } from "next/server";
import { inspectionCsv, type InspectionItem } from "@vx/planning";
import { createClient } from "@/lib/supabase/server";

/** The plan as CSV for a supplier (members only; RLS decides). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ projectId: string; planId: string }> }) {
  const { projectId, planId } = await params;
  const supabase = await createClient();
  const { data: p } = await supabase.from("inspection_plans").select("plan_no, version, status, items").eq("id", planId).eq("project_id", projectId).maybeSingle();
  if (!p) return new NextResponse("Not found", { status: 404 });
  const name = `IP-${String(p.plan_no).padStart(3, "0")}-v${p.version}${p.status === "approved" ? "" : `-${p.status}`}.csv`;
  return new NextResponse(inspectionCsv(p.items as InspectionItem[]), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" },
  });
}
