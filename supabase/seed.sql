-- Synthetic seed for the local stack (spec §4.2, plan Task 4). Every name, place,
-- person and Listen here is made up. Loaded by scripts/cloud-session-start.sh
-- after the schema, as the postgres role (RLS does not apply).
--
-- Fixed ids, so tests can name them:
--   users     10000000-0000-4000-8000-00000000000N
--   nodes     20000000-0000-4000-8000-00000000000N
--   Listens   30000000-0000-4000-8000-00000000000N  (tests/contract/stack.ts SEEDED_LISTEN_IDS)
--   species   40000000-0000-4000-8000-00000000000N
--
-- "Today" rows are stamped minutes before the seed runs. The session script
-- re-seeds on every run, so they are today's as of the session start.

-- ── Users ────────────────────────────────────────────────────────────────────
-- The test user signs in by email code (Mailpit, declared deviation D1). Neither
-- user has a password.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'field-test@example.invalid', '', now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'other@example.invalid', '', now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '{"sub":"10000000-0000-4000-8000-000000000001","email":"field-test@example.invalid","email_verified":true}',
   'email', now(), now(), now()),
  ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   '{"sub":"10000000-0000-4000-8000-000000000002","email":"other@example.invalid","email_verified":true}',
   'email', now(), now(), now());

-- Only the test user has a Listener profile.
insert into public.listeners (id, handle, display_name)
values ('10000000-0000-4000-8000-000000000001', 'fieldtest', 'Field Test');

-- ── Nodes: two in the Big Bend area, one Colorado montane post ──────────────
insert into public.nodes (id, name, hardware_type, location, elevation_m, elevation_unit, habitat_type, is_active)
values
  ('20000000-0000-4000-8000-000000000001', 'Cottonwood Wash', 'pi',
   'SRID=4326;POINT(-103.2510 29.2480)'::geography, 2200, 'ft', 'Riparian', true),
  ('20000000-0000-4000-8000-000000000002', 'Mesa Trail post', 'pi',
   'SRID=4326;POINT(-103.1980 29.3110)'::geography, 3400, 'ft', 'Desert', true),
  ('20000000-0000-4000-8000-000000000003', 'Spruce Gulch post', 'pi',
   'SRID=4326;POINT(-105.5900 39.6300)'::geography, 9800, 'ft', 'Alpine', true);

-- ── Species: every species seeded below ─────────────────────────────────────
insert into public.species (id, common_name, scientific_name)
values
  ('40000000-0000-4000-8000-000000000001', 'Cactus Wren',          'Campylorhynchus brunneicapillus'),
  ('40000000-0000-4000-8000-000000000002', 'Verdin',               'Auriparus flaviceps'),
  ('40000000-0000-4000-8000-000000000003', 'Vermilion Flycatcher', 'Pyrocephalus rubinus'),
  ('40000000-0000-4000-8000-000000000004', 'Canyon Towhee',        'Melozone fusca'),
  ('40000000-0000-4000-8000-000000000005', 'Mountain Chickadee',   'Poecile gambeli'),
  ('40000000-0000-4000-8000-000000000006', 'Steller''s Jay',       'Cyanocitta stelleri');

-- ── Range allowlist ─────────────────────────────────────────────────────────
-- The range-validity gate (contract-schema.sql, from portal 20260720/20260722)
-- sets range_status itself in BEFORE triggers: on every detections insert, and
-- on every mobile_detections insert or update of species, lat or lon. A value
-- written here would be overwritten. A row is 'plausible' only when
-- range_allowlist lists its species for its ~0.5° cell; a cell with no rows
-- leaves it 'unchecked'. That is how the portal makes rows plausible, so the
-- seed does the same, for its two cells (both Big Bend nodes share one), keyed
-- through range_cell_key exactly as the gate keys them. Week 0 = all weeks.
insert into public.range_allowlist (cell_key, week, species_id, source)
select public.range_cell_key(ST_Y(n.location::geometry), ST_X(n.location::geometry)), 0, a.s, 'seed'
from (values
  ('20000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000001'::uuid),  -- Cactus Wren
  ('20000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000002'::uuid),  -- Verdin
  ('20000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000003'::uuid),  -- Vermilion Flycatcher
  ('20000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000004'::uuid),  -- Canyon Towhee
  ('20000000-0000-4000-8000-000000000003'::uuid, '40000000-0000-4000-8000-000000000005'::uuid),  -- Mountain Chickadee
  ('20000000-0000-4000-8000-000000000003'::uuid, '40000000-0000-4000-8000-000000000006'::uuid)   -- Steller's Jay
) as a(n, s)
join public.nodes n on n.id = a.n;

-- ── Node detections today ───────────────────────────────────────────────────
-- Cottonwood Wash: Cactus Wren 4, Verdin 2, Vermilion Flycatcher 1. Mesa Trail
-- post: Verdin 1. All at or above the portal's MIN_CONFIDENCE (0.30, portal
-- src/lib/supabase.js).
-- range_status: the plan asks for null, but the pinned schema (20260720) makes
-- it NOT NULL and the gate computes it. With the allowlist above every row here
-- comes out 'plausible' (checked at the end of this file): that passes
-- NodePage's filter (null or not 'quarantined') and is the value MapPage's node
-- query requires (a node is listed only with at least one detection whose
-- range_status = 'plausible'), so both read the seed.
insert into public.detections (node_id, species_id, species_name, raw_label, confidence, detected_at)
-- greatest(): never earlier than the start of the current UTC day.
select n, s, sn, sci || '_' || sn, c, greatest(date_trunc('day', now()), now() - make_interval(mins => m))
from (values
  ('20000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000001'::uuid, 'Cactus Wren',          'Campylorhynchus brunneicapillus', 0.91, 5),
  ('20000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000001'::uuid, 'Cactus Wren',          'Campylorhynchus brunneicapillus', 0.84, 9),
  ('20000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000001'::uuid, 'Cactus Wren',          'Campylorhynchus brunneicapillus', 0.77, 14),
  ('20000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000001'::uuid, 'Cactus Wren',          'Campylorhynchus brunneicapillus', 0.62, 20),
  ('20000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000002'::uuid, 'Verdin',               'Auriparus flaviceps',             0.73, 7),
  ('20000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000002'::uuid, 'Verdin',               'Auriparus flaviceps',             0.58, 18),
  ('20000000-0000-4000-8000-000000000001'::uuid, '40000000-0000-4000-8000-000000000003'::uuid, 'Vermilion Flycatcher', 'Pyrocephalus rubinus',            0.66, 11),
  ('20000000-0000-4000-8000-000000000002'::uuid, '40000000-0000-4000-8000-000000000002'::uuid, 'Verdin',               'Auriparus flaviceps',             0.69, 8)
) as d(n, s, sn, sci, c, m);

-- Spruce Gulch post: one detection two days ago, not today. It is there so that
-- MapPage's node query (which needs a 'plausible' detection) lists all three
-- nodes, and a map test excludes the Colorado post by its bounding box alone.
insert into public.detections (node_id, species_id, species_name, raw_label, confidence, detected_at)
values ('20000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000005', 'Mountain Chickadee',
        'Poecile gambeli_Mountain Chickadee', 0.76, now() - interval '2 days');

-- ── Listens ─────────────────────────────────────────────────────────────────
-- Six published, complete Listens by the test user, two near each node, and one
-- unpublished complete draft by other@example.invalid (for the RLS test).
insert into public.mobile_detections
  (id, user_id, detected_at, lat, lon, status, species, habitat_type, device_info, published)
values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', now() - interval '1 day',
   29.24812, -103.25133, 'complete',
   '[{"common_name":"Cactus Wren","scientific_name":"Campylorhynchus brunneicapillus","confidence":0.88}]',
   'riparian', '{"tz_offset":-300}', true),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', now() - interval '2 days',
   29.24955, -103.25021, 'complete',
   '[{"common_name":"Verdin","scientific_name":"Auriparus flaviceps","confidence":0.74}]',
   'riparian', '{"tz_offset":-300}', true),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', now() - interval '3 days',
   29.31078, -103.19822, 'complete',
   '[{"common_name":"Canyon Towhee","scientific_name":"Melozone fusca","confidence":0.67}]',
   'desert', '{"tz_offset":-300}', true),
  ('30000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', now() - interval '4 days',
   29.31164, -103.19715, 'complete',
   '[{"common_name":"Verdin","scientific_name":"Auriparus flaviceps","confidence":0.71}]',
   'desert', '{"tz_offset":-300}', true),
  ('30000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', now() - interval '5 days',
   39.63021, -105.59011, 'complete',
   '[{"common_name":"Mountain Chickadee","scientific_name":"Poecile gambeli","confidence":0.81}]',
   'alpine', '{"tz_offset":-420}', true),
  ('30000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', now() - interval '6 days',
   39.62947, -105.58962, 'complete',
   '[{"common_name":"Steller''s Jay","scientific_name":"Cyanocitta stelleri","confidence":0.79}]',
   'alpine', '{"tz_offset":-420}', true),
  ('30000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000002', now() - interval '1 hour',
   29.24870, -103.25090, 'complete',
   '[{"common_name":"Cactus Wren","scientific_name":"Campylorhynchus brunneicapillus","confidence":0.83}]',
   'riparian', '{"tz_offset":-300}', false);

-- ── Place follows ───────────────────────────────────────────────────────────
insert into public.journal_follows (follower_id, node_id)
values ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001');

-- ── Check: the gate passed every seeded row ─────────────────────────────────
-- If the gate or the allowlist drifts, fail the seed (the session script then
-- prints STACK FAILED: load seed) rather than serve rows the map can't see.
do $$
declare
  bad_detections int;
  bad_listens int;
begin
  select count(*) into bad_detections from public.detections where range_status <> 'plausible';
  select count(*) into bad_listens from public.mobile_detections where range_status <> 'plausible';
  if bad_detections > 0 or bad_listens > 0 then
    raise exception 'seed: % detections and % Listens are not plausible after the range gate',
      bad_detections, bad_listens;
  end if;
end;
$$;
