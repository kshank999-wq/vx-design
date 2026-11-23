-- The look of the product, in words, for every design step: written once per design freeze by a model that looks at
-- the frozen image (a generated concept or the team's own mock-up). Workers include it, with the freeze's envelope,
-- CMF and the uploaded mock-up references, in the context of every task, so engineering keeps to the look.
create table public.design_looks (
  freeze_id    uuid primary key references public.design_freezes (id) on delete cascade,
  project_id   uuid not null references public.projects (id) on delete cascade,
  description  text not null,
  model        text,
  created_at   timestamptz not null default now()
);
alter table public.design_looks enable row level security;
create policy "members read looks" on public.design_looks for select to authenticated using (public.is_project_member(project_id));
revoke all on public.design_looks from anon, authenticated;
grant select on public.design_looks to authenticated;
grant all on public.design_looks to service_role;
