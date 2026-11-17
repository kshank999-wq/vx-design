-- M-SRC: shared parts catalog, distributor offers and the manufacturer 3D model library.
--
-- Catalog rows describe public parts, not customer designs: any signed-in user may read them, only
-- workers (service role) write them. Which parts a project uses lives in that project's artifacts
-- (the sourced BOM), under the project's RLS.
--
-- Offers are observations, never "the current price": every row carries when it was observed, which
-- provider returned it and whether it was live data or a fixture.

create type public.part_lifecycle as enum ('active', 'nrnd', 'last_time_buy', 'obsolete', 'unknown');
create type public.offer_data_status as enum ('live', 'fixture');

create table public.parts (
  id              uuid primary key default gen_random_uuid(),
  mpn             text not null,
  normalized_mpn  text not null,                     -- upper case, no spaces, unified dashes
  manufacturer    text not null,
  normalized_mfr  text not null,                     -- canonical manufacturer key (aliases folded)
  description     text,
  lifecycle       public.part_lifecycle not null default 'unknown',
  lifecycle_raw   text,                              -- provider's own wording
  datasheet_url   text,
  package         text,
  specs           jsonb not null default '{}'::jsonb,
  sources         text[] not null default '{}',      -- providers that have returned this part
  first_seen_at   timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (normalized_mpn, normalized_mfr)
);
create index parts_normalized_mpn_idx on public.parts (normalized_mpn);

create table public.offers (
  id           uuid primary key default gen_random_uuid(),
  part_id      uuid not null references public.parts(id) on delete cascade,
  provider     text not null,                        -- nexar | digikey | mouser | fixture
  seller       text not null,                        -- distributor named in the offer (e.g. LCSC via Nexar)
  sku          text,
  stock        integer,
  moq          integer,
  multiple     integer,
  packaging    text,
  currency     text,
  prices       jsonb not null default '[]'::jsonb,   -- [{quantity, unit_price}]
  url          text,
  data_status  public.offer_data_status not null,
  observed_at  timestamptz not null default now()
);
create index offers_part_observed_idx on public.offers (part_id, observed_at desc);

-- Manufacturer 3D models, filled per project as parts are sourced (owner decision 17 Nov 2026).
create table public.part_models (
  id            uuid primary key default gen_random_uuid(),
  part_id       uuid not null references public.parts(id) on delete cascade,
  format        text not null default 'step',
  source        text not null,                       -- manufacturer site, SnapEDA, Ultra Librarian, ...
  source_url    text,
  license       text,
  storage_path  text,                                -- in the project-files bucket under catalog/
  sha256        text,
  mechanical    jsonb not null default '{}'::jsonb,  -- body height, keep-outs, mating side, drawing refs
  verified      boolean not null default false,      -- checked against the footprint (overlay, height)
  verified_note text,
  created_at    timestamptz not null default now(),
  unique (part_id, sha256)
);

alter table public.parts enable row level security;
alter table public.offers enable row level security;
alter table public.part_models enable row level security;
create policy "authenticated read parts" on public.parts for select to authenticated using (true);
create policy "authenticated read offers" on public.offers for select to authenticated using (true);
create policy "authenticated read part models" on public.part_models for select to authenticated using (true);
grant select on public.parts, public.offers, public.part_models to authenticated;
grant all on public.parts, public.offers, public.part_models to service_role;

create trigger parts_updated_at before update on public.parts
  for each row execute function public.set_updated_at();

-- Upsert a part and its offers in one call (workers only). Returns the part id.
create function public.record_part(p_part jsonb, p_offers jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  insert into public.parts (mpn, normalized_mpn, manufacturer, normalized_mfr, description, lifecycle, lifecycle_raw,
                            datasheet_url, package, specs, sources)
  values (p_part ->> 'mpn', p_part ->> 'normalized_mpn', p_part ->> 'manufacturer', p_part ->> 'normalized_mfr',
          p_part ->> 'description', coalesce((p_part ->> 'lifecycle')::public.part_lifecycle, 'unknown'),
          p_part ->> 'lifecycle_raw', p_part ->> 'datasheet_url', p_part ->> 'package',
          coalesce(p_part -> 'specs', '{}'::jsonb), array[p_part ->> 'provider'])
  on conflict (normalized_mpn, normalized_mfr) do update set
    description   = coalesce(excluded.description, public.parts.description),
    lifecycle     = case when excluded.lifecycle = 'unknown' then public.parts.lifecycle else excluded.lifecycle end,
    lifecycle_raw = coalesce(excluded.lifecycle_raw, public.parts.lifecycle_raw),
    datasheet_url = coalesce(excluded.datasheet_url, public.parts.datasheet_url),
    package       = coalesce(excluded.package, public.parts.package),
    specs         = public.parts.specs || excluded.specs,
    sources       = (select array_agg(distinct s) from unnest(public.parts.sources || excluded.sources) s)
  returning id into v_id;

  insert into public.offers (part_id, provider, seller, sku, stock, moq, multiple, packaging, currency, prices, url,
                             data_status, observed_at)
  select v_id, o ->> 'provider', o ->> 'seller', o ->> 'sku', (o ->> 'stock')::integer, (o ->> 'moq')::integer,
         (o ->> 'multiple')::integer, o ->> 'packaging', o ->> 'currency', coalesce(o -> 'prices', '[]'::jsonb), o ->> 'url',
         (o ->> 'data_status')::public.offer_data_status, coalesce((o ->> 'observed_at')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_offers, '[]'::jsonb)) o;
  return v_id;
end;
$$;
revoke all on function public.record_part(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.record_part(jsonb, jsonb) to service_role;
