-- Client accounts (owner decision 17 Nov 2026). Added on its own: a new enum value cannot be used in the
-- transaction that adds it.
alter type public.project_role add value if not exists 'client';
