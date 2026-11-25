import { ProjectNav, type NavGroup } from "@/components/ProjectNav";
import { LiveRunStrip } from "@/components/LiveRunStrip";
import { requireUser } from "@/lib/auth";
import { ChatDock } from "@/components/ChatDock";
import { sendMessage } from "./workspace/actions";

/** Every project page gets the project menu (staff only: clients work in the workspace). */
export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { supabase, userId } = await requireUser();
  const [{ data: project }, { data: me }, { data: msgs }] = await Promise.all([
    supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
    supabase.from("project_members").select("role").eq("project_id", projectId).eq("user_id", userId).maybeSingle(),
    supabase.from("project_messages").select("id, author_kind, body").eq("project_id", projectId).order("id", { ascending: false }).limit(8),
  ]);
  if (!project || !me || me.role === "client") return <>{children}</>;
  const b = `/projects/${projectId}`;
  const staff = me.role !== "viewer";
  const groups: NavGroup[] = [
    { label: "Define", items: [{ href: `${b}/setup`, label: "Guided setup" }, { href: `${b}/risks`, label: "Intake and risks" }, { href: `${b}/wizard`, label: "Requirement wizard" },
      { href: `${b}/concepts`, label: "Concepts" }, { href: `${b}/trades`, label: "Trade studies" }, { href: `${b}/build-vs-buy`, label: "Build vs buy" }, { href: `${b}/stages`, label: "Stages" }] },
    { label: "Design", items: [{ href: `${b}/mechanical`, label: "Mechanical checks" }, { href: `${b}/models`, label: "3D model library" },
      ...(staff ? [{ href: `${b}/flux`, label: "Import existing designs" }, { href: `${b}/optimize`, label: "Optimize" }] : [])] },
    { label: "Make", items: [...(staff ? [{ href: `${b}/manufacturing`, label: "Manufacturing routes" }, { href: `${b}/assembly`, label: "Assembly instructions" },
      { href: `${b}/dfm`, label: "Manufacturing fit" }, { href: `${b}/rfqs`, label: "RFQs" }] : []),
      { href: `${b}/releases`, label: "Releases" }, { href: `${b}/production`, label: "Production" }, { href: `${b}/inspection`, label: "Inspection plans" }] },
    { label: "Prove", items: [{ href: `${b}/validation`, label: "Validation" }, { href: `${b}/compliance`, label: "Compliance" }, { href: `${b}/lifecycle`, label: "Lifecycle" }] },
  ];
  return <><ProjectNav base={b} name={project.name} groups={groups} /><LiveRunStrip projectId={projectId} />{children}
    <ChatDock projectId={projectId} messages={msgs ?? []} action={sendMessage.bind(null, projectId, null)} /></>;
}
