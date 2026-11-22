-- INTERIM until the Spec 2 baseline lands; deleted at the first pin bump after it
--
-- The schema objects the field app's contract (spec §3) uses, for the local stack.
-- Portal migrations alone can't build a fresh database: they assume production's
-- pre-history schema (nodes, species, detections) and PostGIS (spec §4.2). Until
-- magora-portal ships supabase/migrations/20260625_baseline_prehistory.sql, the
-- session script applies this file instead.
--
-- Source: magora-portal at the commit in portal-pin.txt
-- (768bd2f9a7e94c7afd8ee298e2be2f253fab7492). Each block names the migration it
-- was copied from, and is the object's state after the LAST migration at the pin
-- that touched it. Two kinds of block:
--   * "copied from <migration>": verbatim from the pinned migration, or its final
--     state where later migrations changed it.
--   * "PRE-HISTORY": tables no migration creates (nodes, species, detections). Their
--     columns are the ones portal code at the pin selects, filters on or inserts
--     (named per block); the types are this file's choice, as no portal file
--     declares them. The read policies are public reads, which is what the portal's
--     anon-key reads of these tables need.
--
-- Deliberately left out (not used by spec §3): node_follows (20260627, superseded
-- by journal_follows), listener_follows, pulses, node reports, node status
-- events, aci_logs, the avatar and banner buckets, public_listen_sessions and
-- set_session_insight (20260707), the range gate's builder RPC
-- replace_range_cell and its ebird_code corrections (20260720, 20260722), and
-- every other service-role-only writer RPC except the queue RPCs.
--
-- Included although §3 does not call them directly, because accepted writes
-- must match the portal's: the range-validity gate (20260720, with is_plausible
-- as 20260722 left it) — its BEFORE triggers set range_status on every
-- detections insert and on every mobile_detections insert or species/lat/lon
-- update — and listen_sessions (20260707), the target of
-- mobile_detections.session_id's foreign key.
--
-- PostGIS is created in schema public, as in production (portal
-- 20260725_scope_service_role_policies.sql names public.spatial_ref_sys). The
-- gate's functions pin search_path = public and call ST_X / ST_Y, so PostGIS
-- in any other schema would break every detections insert.

-- ════════════════════════════════════════════════════════════════════════════
-- Extensions
-- ════════════════════════════════════════════════════════════════════════════
create extension if not exists postgis with schema public;
-- copied from 20260628_listen_phase1_mobile_detections
create extension if not exists pgmq;

-- ════════════════════════════════════════════════════════════════════════════
-- nodes — PRE-HISTORY. Columns from: supabase/functions/provision-node/index.ts
-- (insert), src/pages/NodePage.jsx and src/pages/MapPage.jsx (reads),
-- 20260626 (species_whitelist), 20260705 (owner_id FK), 20260717 (last_seen_at),
-- 20260719 (elevation_unit), 20260724 (banner_path).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.nodes (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  hardware_type     text,
  location          geography(Point, 4326),
  elevation_m       double precision,
  habitat_type      text,
  is_active         boolean not null default true,
  species_whitelist jsonb,
  owner_id          uuid,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz,
  banner_path       text
);

-- copied from 20260705_nodes_owner_auth_users
alter table public.nodes drop constraint if exists nodes_owner_id_fkey;
alter table public.nodes
  add constraint nodes_owner_id_fkey
  foreign key (owner_id) references auth.users(id) on delete set null;

-- copied from 20260719_nodes_elevation_unit
alter table public.nodes
  add column if not exists elevation_unit text not null default 'ft'
    check (elevation_unit in ('ft', 'm'));

alter table public.nodes enable row level security;
create policy "public read nodes" on public.nodes
  for select to anon, authenticated using (true);

-- ════════════════════════════════════════════════════════════════════════════
-- species — PRE-HISTORY. Columns from: the species embed in NodePage.jsx and
-- MapPage.jsx (guild, migratory_status, indicator_status, sensitivity_flag),
-- 20260720 (lookup by scientific_name, then common_name), 20260714 (ebird_code,
-- family, order_name) and 20260715 (trophic_niche, primary_lifestyle).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.species (
  id                uuid primary key default gen_random_uuid(),
  common_name       text not null,
  scientific_name   text,
  guild             text,
  migratory_status  text,
  indicator_status  text,
  sensitivity_flag  text,
  ebird_code        text,
  family            text,
  order_name        text,
  trophic_niche     text,
  primary_lifestyle text
);

alter table public.species enable row level security;
create policy "public read species" on public.species
  for select to anon, authenticated using (true);

-- ════════════════════════════════════════════════════════════════════════════
-- detections — PRE-HISTORY (node detections). Columns from: docs/staging/
-- node-contract.md row 3 (the node's insert), NodePage.jsx and MapPage.jsx
-- (species_id embed, confidence, range_status, detected_at filters),
-- 20260708 (insight, insight_requested_at), 20260720 (species_id, range_status,
-- range_checked_at) and 20260727 (node_id not null, on delete restrict).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.detections (
  id                   uuid primary key default gen_random_uuid(),
  node_id              uuid not null,
  species_id           uuid references public.species(id),
  species_name         text,
  raw_label            text,
  confidence           double precision,
  detected_at          timestamptz not null default now(),
  location             geography(Point, 4326),
  is_dawn_chorus       boolean,
  minutes_from_sunrise integer,
  dawn_chorus_window   text,
  phenological_week    integer,
  season               text
);

-- copied from 20260727_ingest_node_id_constraints
alter table public.detections
  add constraint detections_node_id_fkey
  foreign key (node_id) references public.nodes(id) on delete restrict;

-- copied from 20260708_node_insight_batch
alter table public.detections add column if not exists insight text;
alter table public.detections add column if not exists insight_requested_at timestamptz;

-- copied from 20260720_range_validity_gate (section 4)
alter table public.detections
  add column if not exists range_status text not null default 'unchecked'
    check (range_status in ('unchecked', 'plausible', 'quarantined')),
  add column if not exists range_checked_at timestamptz;

create index if not exists detections_node_time_idx on public.detections (node_id, detected_at desc);

alter table public.detections enable row level security;
create policy "public read detections" on public.detections
  for select to anon, authenticated using (true);

-- ════════════════════════════════════════════════════════════════════════════
-- listeners — copied from 20260703_listener_profiles (+ follows_public, 20260710)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.listeners (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text not null unique check (
    handle = lower(handle)
    and handle ~ '^[a-z0-9_]{3,24}$'
    and handle not in (
      'admin','api','journal','me','support','help','www','mail',
      'node','species','dashboard','register','about','donate','listen'
    )
  ),
  display_name text,
  bio text,
  home_region text,
  avatar_path text,
  created_at timestamptz not null default now()
);

alter table public.listeners enable row level security;

create policy "public select listeners" on public.listeners
  for select to public using (true);

create policy "insert own listener" on public.listeners
  for insert to authenticated with check (auth.uid() = id);

create policy "update own listener" on public.listeners
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create policy "delete own listener" on public.listeners
  for delete to authenticated using (auth.uid() = id);

-- copied from 20260710_journal_follows
alter table public.listeners
  add column if not exists follows_public boolean not null default false;

-- ════════════════════════════════════════════════════════════════════════════
-- Queue — copied from 20260628_listen_phase1_mobile_detections
-- ════════════════════════════════════════════════════════════════════════════
select pgmq.create('audio_inference');

-- ════════════════════════════════════════════════════════════════════════════
-- mobile_detections — copied from 20260628_listen_phase1_mobile_detections, with
-- published (20260701), insight (20260702), session_id (20260707, see below) and
-- range_status / range_checked_at (20260720).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.mobile_detections (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  detected_at timestamptz not null default now(),

  -- Location (lat/lon from the phone; location derived for PostGIS queries)
  lat float8 not null,
  lon float8 not null,
  location geography(Point, 4326) generated always as (
    ST_SetSRID(ST_MakePoint(lon, lat), 4326)
  ) stored,

  -- Inference
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'complete', 'failed')),
  species jsonb,  -- [{ common_name, scientific_name, confidence }]

  -- Ecological metadata (all optional, collected in the Listen modal)
  habitat_type      text,     -- forest | grassland | wetland | riparian | shrubland | urban | alpine | desert
  canopy_cover      text,     -- open | partial | closed
  water_present     boolean,
  disturbance_level text,     -- none | low | moderate | high
  observer_notes    text,

  -- Internal
  audio_path  text,   -- temp Storage path, nulled by the worker after inference
  device_info jsonb,  -- browser/OS for QA
  synced_at   timestamptz  -- when the offline queue flushed this (Phase 5)
);

-- copied from 20260701_listen_consent_published
alter table public.mobile_detections
  add column if not exists published boolean not null default false;

-- copied from 20260702_listen_insight
alter table public.mobile_detections add column if not exists insight text;

-- ════════════════════════════════════════════════════════════════════════════
-- listen_sessions — copied from 20260707_listen_sessions (table, the
-- mobile_detections.session_id link, indexes, RLS and policies; not its
-- public_listen_sessions view or set_session_insight)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.listen_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,

  -- Session centroid (coarsened to ~110m in the public view). Nullable until the
  -- first capture sets it. location is derived for any future PostGIS use;
  -- ST_MakePoint is strict, so it stays null while lat/lon are null.
  lat float8,
  lon float8,
  location geography(Point, 4326) generated always as (
    ST_SetSRID(ST_MakePoint(lon, lat), 4326)
  ) stored,

  -- Place metadata for the whole outing (collected once at "finish").
  habitat_type      text,
  canopy_cover      text,
  water_present     boolean,
  disturbance_level text,
  observer_notes    text,

  insight   text,     -- the synthesized session insight
  published boolean not null default false
);

-- Nullable: legacy Listens and all node detections keep session_id null and are
-- unaffected. on delete set null so discarding a session doesn't delete captures.
alter table public.mobile_detections
  add column if not exists session_id uuid references public.listen_sessions(id) on delete set null;

create index if not exists listen_sessions_user_time_idx
  on public.listen_sessions (user_id, started_at desc);
create index if not exists listen_sessions_published_idx
  on public.listen_sessions (started_at desc) where published = true;

alter table public.listen_sessions enable row level security;

create policy "select own sessions" on public.listen_sessions
  for select to authenticated using (auth.uid() = user_id);
create policy "insert own sessions" on public.listen_sessions
  for insert to authenticated with check (auth.uid() = user_id);
create policy "update own sessions" on public.listen_sessions
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own sessions" on public.listen_sessions
  for delete to authenticated using (auth.uid() = user_id);

-- copied from 20260720_range_validity_gate (section 4)
alter table public.mobile_detections
  add column if not exists range_status text not null default 'unchecked'
    check (range_status in ('unchecked', 'plausible', 'quarantined')),
  add column if not exists range_checked_at timestamptz;

alter table public.mobile_detections enable row level security;

create policy "select own detections" on public.mobile_detections
  for select to authenticated using (auth.uid() = user_id);

create policy "insert own detections" on public.mobile_detections
  for insert to authenticated with check (auth.uid() = user_id);

create policy "update own detections" on public.mobile_detections
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- copied from 20260701_listen_consent_published
create policy "delete own detections" on public.mobile_detections
  for delete to authenticated using (auth.uid() = user_id);

create index if not exists mobile_detections_location_idx
  on public.mobile_detections using gist (location);
create index if not exists mobile_detections_user_time_idx
  on public.mobile_detections (user_id, detected_at desc);
create index if not exists mobile_detections_complete_idx
  on public.mobile_detections (detected_at desc) where status = 'complete';
-- copied from 20260707_listen_sessions
create index if not exists mobile_detections_session_idx
  on public.mobile_detections (session_id);

alter publication supabase_realtime add table public.mobile_detections;

-- ── Enqueue trigger — copied from 20260628_listen_phase1_mobile_detections ──
create or replace function public.enqueue_mobile_inference()
returns trigger
language plpgsql
security definer
set search_path = public, pgmq
as $$
begin
  perform pgmq.send('audio_inference', jsonb_build_object(
    'detection_id', NEW.id,
    'audio_path',   NEW.audio_path,
    'user_id',      NEW.user_id
  ));
  return NEW;
end;
$$;

create trigger mobile_detections_enqueue
  after insert on public.mobile_detections
  for each row
  when (NEW.status = 'pending' and NEW.audio_path is not null)
  execute function public.enqueue_mobile_inference();

-- ════════════════════════════════════════════════════════════════════════════
-- Range-validity gate — copied from 20260720_range_validity_gate (sections 1, 2,
-- 3, 5 and 6; section 4's columns are on the tables above, section 7 is the
-- public view below), with is_plausible as 20260722_range_gate_precision
-- redefines it. Not copied: replace_range_cell (the builder's writer RPC) and
-- 20260722's ebird_code corrections. auto_seed_species (the pre-history trigger
-- that fills detections.species_id before this gate runs) has no migration at
-- the pin, so it is not here either: local writers set species_id themselves.
--
-- What it means locally: is_plausible returns null (fail-open, 'unchecked')
-- for any cell with no range_allowlist rows, so rows are 'plausible' only where
-- range_allowlist lists their species for their cell. supabase/seed.sql seeds
-- range_allowlist for its two cells, which is how the portal makes rows
-- plausible too.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.range_cell_key(p_lat double precision, p_lon double precision)
returns text
language sql
immutable
as $$
  select case
    when p_lat is null or p_lon is null then null
    else floor(p_lat / 0.5)::int || ':' || floor(p_lon / 0.5)::int
  end;
$$;

-- BirdNET-style 48-week number (4 weeks per month, clamped) from a timestamp. Defined now
-- for the FUTURE week-resolved builder; v1 stores week = 0 ("all weeks", see below), so the
-- gate is week-agnostic today and this helper is not yet on the hot path.
create or replace function public.range_week(p_ts timestamptz)
returns smallint
language sql
immutable
as $$
  select case when p_ts is null then null else
    ((extract(month from p_ts)::int - 1) * 4
      + least(ceil(extract(day from p_ts)::numeric / 7.0)::int, 4))::smallint
  end;
$$;

create table if not exists public.range_allowlist (
  cell_key     text     not null,           -- range_cell_key(lat, lon)
  week         smallint not null default 0, -- 0 = all-weeks (v1); 1..48 = BirdNET week (future)
  species_id   uuid     not null references public.species(id) on delete cascade,
  source       text     not null,           -- e.g. 'ebird:obs_geo_recent'
  generated_at timestamptz not null default now(),
  primary key (cell_key, week, species_id)
);
create index if not exists range_allowlist_cell_idx on public.range_allowlist (cell_key, week);

alter table public.range_allowlist enable row level security;
create policy "range_allowlist public read" on public.range_allowlist
  for select to anon, authenticated using (true);

-- is_plausible — copied from 20260722_range_gate_precision (replaces the 20260720 body)
create or replace function public.is_plausible(
  p_species_id uuid,
  p_lat        double precision,
  p_lon        double precision,
  p_week       integer
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cell text := range_cell_key(p_lat, p_lon);
  v_code text;
begin
  if p_species_id is null or v_cell is null then
    return null;                                   -- can't resolve -> indeterminate
  end if;
  if not exists (select 1 from public.range_allowlist where cell_key = v_cell) then
    return null;                                   -- no reference for this cell yet (coverage)
  end if;
  -- Allowlist hit wins FIRST — a null-code bird that legitimately mapped in returns true, not null.
  if exists (
    select 1 from public.range_allowlist
    where cell_key = v_cell
      and species_id = p_species_id
      and week in (0, p_week)                      -- 0 = all-weeks (v1)
  ) then
    return true;
  end if;
  -- Not in the allowlist. Only a species eBird can actually judge (has a real ebird_code) may
  -- be called implausible; non-birds / null-or-empty-code species FAIL OPEN (indeterminate).
  select nullif(btrim(ebird_code), '') into v_code
  from public.species where id = p_species_id;
  if v_code is null then
    return null;
  end if;
  return false;
end;
$$;
-- Grants unchanged (create-or-replace preserves them); re-assert for clarity, no anon change.
grant execute on function public.is_plausible(uuid, double precision, double precision, integer)
  to anon, authenticated, service_role;

-- Map is_plausible's tri-state onto the range_status vocabulary. One place, both triggers.
create or replace function public.range_status_of(p_plausible boolean)
returns text
language sql
immutable
as $$
  select case
    when p_plausible is null then 'unchecked'
    when p_plausible then 'plausible'
    else 'quarantined'
  end;
$$;

-- Enforcement point A — node path (detections), BEFORE INSERT (20260720 section 5)
-- Fires AFTER auto_seed_species (trigger name sorts later: 'z…' > 'seed…'), so NEW.species_id
-- is already resolved. lat/lon come from the detection's own PostGIS point when present,
-- else the node's location. week from detected_at (v1 gate is week-agnostic; week=0 rows
-- satisfy it regardless).
create or replace function public.gate_detection_range()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lat double precision;
  v_lon double precision;
  v_plausible boolean;
begin
  -- Prefer the detection's own point; fall back to the owning node's location.
  if NEW.location is not null then
    v_lat := ST_Y(NEW.location::geometry);
    v_lon := ST_X(NEW.location::geometry);
  else
    select ST_Y(location::geometry), ST_X(location::geometry)
      into v_lat, v_lon
    from public.nodes where id = NEW.node_id;
  end if;

  v_plausible := is_plausible(NEW.species_id, v_lat, v_lon, range_week(NEW.detected_at)::int);
  NEW.range_status := range_status_of(v_plausible);
  NEW.range_checked_at := now();
  return NEW;
end;
$$;

-- 'zzz_' prefix guarantees this runs AFTER auto_seed_species (which sets NEW.species_id).
drop trigger if exists zzz_gate_detection_range on public.detections;
create trigger zzz_gate_detection_range
  before insert on public.detections
  for each row execute function public.gate_detection_range();

-- Enforcement point B — listen-post path (mobile_detections), BEFORE INSERT OR
-- UPDATE of species, lat, lon (20260720 section 6)
-- The phone inserts a PENDING row with no species; the external worker later UPDATEs it with
-- the inferred `species` jsonb ([{common_name, scientific_name, confidence}, ...]) and
-- status='complete'. So the gate must (re)run when species is populated — hence BEFORE INSERT
-- OR UPDATE. We gate on the PRIMARY (highest-confidence) species — the headline detection the
-- feed shows and the map keys on — resolved to a species_id via scientific_name then
-- common_name. Empty/again-null species -> unchecked (fail-open).
create or replace function public.gate_mobile_detection_range()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary jsonb;
  v_species_id uuid;
  v_plausible boolean;
begin
  -- Highest-confidence element of the species array (worker sorts desc, but don't assume).
  select elem
    into v_primary
  from jsonb_array_elements(coalesce(NEW.species, '[]'::jsonb)) as elem
  order by coalesce((elem->>'confidence')::numeric, 0) desc
  limit 1;

  if v_primary is not null then
    select id into v_species_id from public.species
     where scientific_name = (v_primary->>'scientific_name')
     limit 1;
    if v_species_id is null then
      select id into v_species_id from public.species
       where common_name = (v_primary->>'common_name')
       limit 1;
    end if;
  end if;

  v_plausible := is_plausible(v_species_id, NEW.lat, NEW.lon, range_week(NEW.detected_at)::int);
  NEW.range_status := range_status_of(v_plausible);
  NEW.range_checked_at := now();
  return NEW;
end;
$$;

drop trigger if exists zzz_gate_mobile_detection_range on public.mobile_detections;
create trigger zzz_gate_mobile_detection_range
  before insert or update of species, lat, lon on public.mobile_detections
  for each row execute function public.gate_mobile_detection_range();

-- ════════════════════════════════════════════════════════════════════════════
-- Queue RPCs — copied from 20260629_listen_phase2_queue_rpc
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.read_audio_jobs(p_qty int default 1, p_vt int default 60)
returns table (msg_id bigint, read_ct int, enqueued_at timestamptz, vt timestamptz, message jsonb)
language sql
security definer
set search_path = public, pgmq
as $$
  select r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message
  from pgmq.read('audio_inference', p_vt, p_qty) r;
$$;

create or replace function public.delete_audio_job(p_msg_id bigint)
returns boolean
language sql
security definer
set search_path = public, pgmq
as $$
  select pgmq.delete('audio_inference', p_msg_id);
$$;

create or replace function public.archive_audio_job(p_msg_id bigint)
returns boolean
language sql
security definer
set search_path = public, pgmq
as $$
  select pgmq.archive('audio_inference', p_msg_id);
$$;

revoke execute on function public.read_audio_jobs(int, int) from public, anon, authenticated;
revoke execute on function public.delete_audio_job(bigint)  from public, anon, authenticated;
revoke execute on function public.archive_audio_job(bigint) from public, anon, authenticated;
grant  execute on function public.read_audio_jobs(int, int) to service_role;
grant  execute on function public.delete_audio_job(bigint)  to service_role;
grant  execute on function public.archive_audio_job(bigint) to service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- public_mobile_detections — copied from 20260720_range_validity_gate (section 7),
-- the last migration at the pin that replaces it.
-- ════════════════════════════════════════════════════════════════════════════
create or replace view public.public_mobile_detections
  with (security_invoker = false) as
  select
    m.id,
    m.detected_at,
    round(m.lat::numeric, 3) as lat,
    round(m.lon::numeric, 3) as lon,
    m.species,
    m.habitat_type,
    m.canopy_cover,
    m.water_present,
    m.disturbance_level,
    m.insight,
    l.handle as listener_handle,
    (m.device_info ->> 'tz_offset')::integer as tz_offset
  from public.mobile_detections m
    left join public.listeners l on l.id = m.user_id
  where m.status = 'complete'
    and m.published = true
    and m.range_status <> 'quarantined';   -- unchecked + plausible publish; quarantined withheld

grant select on public.public_mobile_detections to anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- set_detection_insight — copied from 20260704_set_detection_insight (the insight
-- write-back after POST /api/insight, src/lib/useEcosystemInsight.js)
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.set_detection_insight(detection_id uuid, insight_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.mobile_detections
     set insight = insight_text
   where id = detection_id
     and insight is null;
end;
$$;

grant execute on function public.set_detection_insight(uuid, text) to anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- journal_follows — copied from 20260710_journal_follows (minus its node_follows
-- backfill: node_follows is not in this schema)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.journal_follows (
  id          uuid        primary key default gen_random_uuid(),
  follower_id uuid        not null default auth.uid() references public.listeners(id) on delete cascade,
  node_id     uuid        not null references public.nodes(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (follower_id, node_id)
);

create index if not exists journal_follows_follower_idx on public.journal_follows (follower_id);
create index if not exists journal_follows_node_idx on public.journal_follows (node_id);

alter table public.journal_follows enable row level security;

create policy "own journal follows: select" on public.journal_follows
  for select to authenticated using (follower_id = auth.uid());

create policy "own journal follows: insert" on public.journal_follows
  for insert to authenticated with check (follower_id = auth.uid());

create policy "own journal follows: delete" on public.journal_follows
  for delete to authenticated using (follower_id = auth.uid());

create or replace view public.public_journal_followers
  with (security_invoker = false) as
select
  jf.node_id,
  jf.follower_id as listener_id,
  l.handle,
  l.display_name,
  l.avatar_path,
  jf.created_at
from public.journal_follows jf
join public.listeners l on l.id = jf.follower_id
where l.follows_public = true;

grant select on public.public_journal_followers to anon, authenticated;

create or replace function public.journal_follower_count(target_node uuid)
  returns integer
  language sql
  stable
  security definer
  set search_path = public
as $$
  select count(*)::int from public.journal_follows where node_id = target_node;
$$;

grant execute on function public.journal_follower_count(uuid) to anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- temp-audio bucket — copied from 20260628_listen_phase1_mobile_detections
-- ════════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public)
values ('temp-audio', 'temp-audio', false)
on conflict (id) do nothing;

-- Authenticated users may upload only into their own {user_id}/ folder.
-- Reads/deletes are done by the worker via the service role (bypasses RLS).
create policy "upload own audio" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'temp-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
