-- Plain-language summaries and "questions for you".
--
-- When a task finishes, the worker writes a short summary in everyday language (executions.plain_summary: what was
-- done and what it means for the product) and may raise questions only the owner can answer, each with a
-- recommendation. Runs never wait on a question: work goes on with the recommendation until it is answered, and the
-- answers go into the context of every later task. Clients see summaries and questions too; answering is for owners,
-- engineers, reviewers and clients.
alter table public.executions add column plain_summary text;
-- The latest one also on the task, which clients can read (executions are staff-only).
alter table public.tasks add column plain_summary text;

create table public.project_questions (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  task_id        uuid references public.tasks (id) on delete set null,
  execution_id   uuid references public.executions (id) on delete set null,
  question       text not null check (length(trim(question)) between 3 and 600),
  why            text,
  recommendation text not null check (length(trim(recommendation)) between 1 and 600),
  options        text[] not null default '{}',
  status         text not null default 'open' check (status in ('open', 'answered', 'dismissed')),
  answer         text,
  answered_by    uuid references auth.users (id) on delete set null,
  answered_at    timestamptz,
  created_at     timestamptz not null default now(),
  check (status = 'open' or answered_at is not null)
);
create index project_questions_project_idx on public.project_questions (project_id, status, created_at);
alter table public.project_questions enable row level security;
create policy "members read questions" on public.project_questions for select to authenticated using (public.is_project_member(project_id));
revoke all on public.project_questions from anon, authenticated;
grant select on public.project_questions to authenticated;
grant all on public.project_questions to service_role;

-- Answer (or dismiss) a question. p_answer null with p_dismiss false takes the recommendation.
create function public.answer_question(p_question uuid, p_answer text, p_dismiss boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare q public.project_questions;
begin
  select * into q from public.project_questions where id = p_question for update;
  if q.id is null or not public.has_project_role(q.project_id, '{owner,engineer,reviewer,client}') then
    raise exception 'question not found or not permitted' using errcode = '42501';
  end if;
  if length(coalesce(p_answer, '')) > 2000 then raise exception 'answer too long'; end if;
  update public.project_questions set
    status = case when p_dismiss then 'dismissed' else 'answered' end,
    answer = case when p_dismiss then null else coalesce(nullif(trim(coalesce(p_answer, '')), ''), q.recommendation) end,
    answered_by = auth.uid(), answered_at = now()
   where id = q.id;
  insert into public.audit_events (project_id, actor_id, actor_type, event_type, entity_type, entity_id, payload)
  values (q.project_id, auth.uid(), 'user', case when p_dismiss then 'question.dismissed' else 'question.answered' end, 'question', q.id,
          jsonb_build_object('answer', p_answer));
end;
$$;
revoke all on function public.answer_question(uuid, text, boolean) from public, anon;
grant execute on function public.answer_question(uuid, text, boolean) to authenticated;
