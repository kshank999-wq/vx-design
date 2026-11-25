-- Plan changes the design agent proposed in the chat that the owner turned down ("Not needed"). Drafted proposals are
-- known from plans.generator->>'chat_message_id'; out-of-date ones from the approved plan's date. One row per message,
-- so a decision made on any screen shows on every screen.
create table if not exists public.plan_proposal_decisions (
  message_id bigint primary key references public.project_messages(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  decision text not null check (decision in ('declined')),
  decided_by uuid references auth.users(id) default auth.uid(),
  decided_at timestamptz not null default now()
);
alter table public.plan_proposal_decisions enable row level security;
revoke all on public.plan_proposal_decisions from anon;
grant select, insert, delete on public.plan_proposal_decisions to authenticated;

create policy plan_proposal_decisions_read on public.plan_proposal_decisions for select to authenticated
  using (public.is_project_member(project_id));
create policy plan_proposal_decisions_write on public.plan_proposal_decisions for insert to authenticated
  with check (public.has_project_role(project_id, '{owner,engineer}')
              and exists (select 1 from public.project_messages m where m.id = message_id and m.project_id = plan_proposal_decisions.project_id));
create policy plan_proposal_decisions_undo on public.plan_proposal_decisions for delete to authenticated
  using (public.has_project_role(project_id, '{owner,engineer}'));
