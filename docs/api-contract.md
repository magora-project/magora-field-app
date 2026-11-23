# API contract

What the field app calls, one entry per row of spec §3 (`docs/superpowers/specs/2026-11-21-field-app-design.md`). The app adds no backend: every call here is one the portal already makes.

**Portal commit:** every source below was read from magora-portal at `768bd2f9a7e94c7afd8ee298e2be2f253fab7492`, the value of `portal-pin.txt`. Moving the pin means re-reading each source and updating this file in the same PR.

`SUPABASE_URL`, the anon key and `PORTAL_ORIGIN` are the app's build-time settings (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`, `EXPO_PUBLIC_PORTAL_ORIGIN`). Locally they point at the local stack and the fake (`scripts/cloud-session-start.sh`).

`MIN_CONFIDENCE` is `0.30` (`src/lib/supabase.js`).

## 1. Sign in

- **Source:** `src/components/AuthModal.jsx` (`sendCode`, `verify`).
- **Call:** `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })`, then `supabase.auth.verifyOtp({ email, token, type: 'email' })`.
- **Request:** `email` (trimmed); `token` is the 6-digit code from the email.
- **Response:** `{ data: { session, user }, error }`. The session holds the user's JWT (`access_token`). OAuth is out of scope.
- **Local:** codes are mailed to Mailpit (`http://127.0.0.1:54324`); the contract tests read them from its API (declared deviation D1).

## 2. Upload audio

- **Source:** `src/lib/storageUpload.js` (`uploadViaFunction`), `supabase/functions/storage-upload/index.ts`, `src/lib/listenQueue.js` (`syncQueuedListen`), `src/lib/listen.js` (`BUCKET = 'temp-audio'`).
- **Call:** `POST {SUPABASE_URL}/functions/v1/storage-upload`, header `Authorization: Bearer <user access_token>`.
- **Request:** `multipart/form-data` with `file` (the audio), `bucket: 'temp-audio'`, `filename: '<listen id>.<ext>'`. `filename` must match `^[A-Za-z0-9._-]+$`; at most 25 MiB.
- **Response:** `200 { "path": "<uid>/<filename>" }`. Errors: `401 { error }` (missing or bad token), `400 { error }` (bad bucket, filename, size or form), `500 { error }` (storage write).
- The function writes with the service role to `temp-audio/<uid>/<filename>`, `upsert: true`, so a retry of one Listen id overwrites, not duplicates.

## 3. Create the Listen

- **Source:** `src/lib/listenQueue.js` (`syncQueuedListen`); `supabase/migrations/20260628_listen_phase1_mobile_detections.sql`, `20260701_listen_consent_published.sql`.
- **Call:** `supabase.from('mobile_detections').insert({...})`, as the signed-in user, after the upload succeeds.
- **Request:** `id` (client uuid), `user_id` (= auth uid; RLS `insert own detections` checks it), `lat`, `lon` (both `not null`), `status: 'pending'`, `audio_path` (the upload's `path`), `device_info` (jsonb; the portal stores `tz_offset` in it), `detected_at` (`not null default now()`: send the recording's time, or omit it for the insert time; never `null`), `habitat_type`, `canopy_cover`, `water_present`, `disturbance_level`, `observer_notes` (all nullable), `synced_at`, `published: false`.
- **Response:** `{ error }`. A unique violation on `id` means the row already exists.
- The `mobile_detections_enqueue` trigger sends `{ detection_id, audio_path, user_id }` to the pgmq queue `audio_inference` when a row is inserted with `status = 'pending'` and a non-null `audio_path`.

## 4. Result

- **Source:** the Fly.io worker (outside both repos); `supabase/migrations/20260629_listen_phase2_queue_rpc.sql` (the worker's queue RPCs: `read_audio_jobs`, `delete_audio_job`, `archive_audio_job`, service role only).
- **Call:** the app polls its own row: `supabase.from('mobile_detections').select('id, status, species, ...').eq('id', id)`.
- **Response:** `status` is `pending`, `processing`, `complete` or `failed`. On `complete`, `species` is `[{ common_name, scientific_name, confidence }]`.
- **Local:** `scripts/fakes/server.mjs` drains the queue every 2 s. Audio filename `fail-*` gives `failed`; `hold-*` stays `pending`; any other gives `complete` with one Cactus Wren (confidence 0.82).
- **`audio_path` after inference:** the real worker nulls `audio_path` once it has run inference (the column comment in `20260628_listen_phase1_mobile_detections.sql`: "temp Storage path, nulled by the worker after inference"). The fake does **not** null it, on purpose: `resetListens()` in `tests/contract/stack.ts` reads each test row's `audio_path` to delete the audio the tests uploaded. So the app must not rely on `audio_path` being null (or set) after `complete` or `failed`.
- **Range gate:** the worker's species update fires the `zzz_gate_mobile_detection_range` trigger (`20260720_range_validity_gate.sql`, `is_plausible` as `20260722_range_gate_precision.sql` redefines it), which sets `range_status` to `plausible`, `unchecked` or `quarantined`. The app never writes `range_status`.

## 5. Post (consent) and discard

- **Source:** `supabase/migrations/20260701_listen_consent_published.sql`; the view's current definition is in `20260720_range_validity_gate.sql` (section 7).
- **Post:** `supabase.from('mobile_detections').update({ published: true }).eq('id', id)` as the owner (RLS `update own detections`).
- **Public read:** `public_mobile_detections` (anon and authenticated) has `id, detected_at, lat, lon` (rounded to 3 decimals), `species, habitat_type, canopy_cover, water_present, disturbance_level, insight, listener_handle, tz_offset`, only for rows with `status = 'complete'`, `published = true` and `range_status <> 'quarantined'`.
- **Discard:** `supabase.from('mobile_detections').delete().eq('id', id)` as the owner (RLS `delete own detections`).

## 6. Insight

- **Source:** `api/insight.js` (`handler`, `mobileInsight`, `buildMobileInsightPrompt`); request built by `src/lib/useEcosystemInsight.js`; write-back RPC `supabase/migrations/20260704_set_detection_insight.sql`.
- **Call:** `POST {PORTAL_ORIGIN}/api/insight`, `Content-Type: application/json`.
- **Request:** `{ mobile: true, detection_id, species, lat, lon, detected_at, tz_offset, habitat_type, canopy_cover, water_present, disturbance_level }`. `species` is the row's species at or above `MIN_CONFIDENCE`, minus hidden species. The server also reads `nearby` and `observer_notes` if sent.
- **Response:** `200 { "insight": "<text>" }`; `400 { error }` when there are no species and no `nearby`; `502 { error }` on a model error; `405` for non-POST.
- **Write-back:** `supabase.rpc('set_detection_insight', { detection_id, insight_text })` (anon or authenticated; writes only while `insight` is null).
- **Local:** the fake answers `{ "insight": "The wash is busy this morning." }`.

## 7. Map, Place, Today (read-only)

### Places: nodes

- **Source:** `src/pages/MapPage.jsx` (`nodes` section), `src/pages/NodePage.jsx` (`fetchData`), `src/lib/geo.js` (`parseNodeLocation`).
- **Map:** `supabase.from('nodes').select('*, detections!inner(id)').eq('detections.range_status', 'plausible').limit(1, { foreignTable: 'detections' })`. A node is listed only once it has a plausible detection.
- **Place:** `supabase.from('nodes').select('*').eq('id', id).single()`.
- **Response:** node rows; `location` is PostGIS `geography(Point)` (hex EWKB or GeoJSON; `parseNodeLocation` reads both), plus `name`, `habitat_type`, `elevation_m`, `elevation_unit`, `hardware_type`, `is_active`, `owner_id`, `created_at`, `last_seen_at`, `banner_path`.

### Places: node detections

- **Source:** `src/pages/NodePage.jsx` (`fetchData`, the all-time species query), `src/pages/MapPage.jsx` (`detections` and `today` sections).
- **Call:** `supabase.from('detections').select('*, species(guild, migratory_status, indicator_status, sensitivity_flag)').eq('node_id', id).gte('confidence', MIN_CONFIDENCE).or('range_status.is.null,range_status.neq.quarantined').order('detected_at', { ascending: false }).limit(30)`.
- **Response:** `id, node_id, species_id, species_name, raw_label, confidence, detected_at, location, is_dawn_chorus, insight, range_status, ...` with the embedded `species` traits.

### Places: follows (`journal_follows`)

- **Source:** `src/lib/journalFollows.js`; `supabase/migrations/20260710_journal_follows.sql` (supersedes `node_follows`); MapPage's Following feed.
- **Follow:** `supabase.from('journal_follows').insert({ node_id })`. `follower_id` defaults to `auth.uid()` and references `listeners(id)`, so a user without a Listener profile gets Postgres `23503`.
- **Unfollow:** `supabase.from('journal_follows').delete().eq('node_id', nodeId)`.
- **Is following:** `supabase.from('journal_follows').select('id').eq('node_id', nodeId).eq('follower_id', uid).maybeSingle()`.
- **Followed places (Today):** `supabase.from('journal_follows').select('node_id')` (RLS returns only the caller's rows).
- **Counts and public followers:** `supabase.rpc('journal_follower_count', { target_node })`; `public_journal_followers` (`listener_id, handle, display_name, avatar_path, created_at` for opted-in Listeners).

### Listener profile (needed to follow a place)

- **Source:** `src/lib/listener.js` (`getListenerByUser`, `createListener`, `validateHandle`, `RESERVED_HANDLES`), `src/components/HandlePrompt.jsx` (`submit`: normalization and the `23505` message), `supabase/migrations/20260703_listener_profiles.sql` (the table, its `handle` check and RLS). Read at `768bd2f9a7e94c7afd8ee298e2be2f253fab7492`.
- **`myListener(userId)`** mirrors `getListenerByUser`: `supabase.from('listeners').select('*').eq('id', userId).maybeSingle()`. Returns the row, or `null` when there is none (the portal also returns `null` on an error).
- **`claimHandle(userId, handle)`** mirrors `createListener` as `HandlePrompt` calls it: `supabase.from('listeners').insert({ id: userId, handle, display_name: null }).select().single()` (`.select()` because inserts return no row by default). The portal sends the trimmed display name or `null`; the app's `claimHandle(userId, handle)` takes no name, so it sends `null`. It throws the Postgres error. `23505` (unique violation) means the handle is taken; the portal shows "That handle is already taken. Try another." RLS `insert own listener` requires `id = auth.uid()`.
- **Handle rules** (`validateHandle`, applied to `handle.toLowerCase().trim()` before the insert):
  - empty: "Choose a handle for your field journal.";
  - must match `^[a-z0-9_]{3,24}$`, else "Use 3–24 lowercase letters, numbers, or underscores.";
  - must not be reserved, else "That handle is reserved. Pick another one." Reserved: `admin`, `api`, `journal`, `me`, `support`, `help`, `www`, `mail`, `node`, `species`, `dashboard`, `register`, `about`, `donate`, `listen`.
  - The table's `check` constraint enforces the same format and reserved list, so a bypassed client check fails with `23514`.
- **Response:** a `listeners` row: `id, handle, display_name, bio, home_region, avatar_path, created_at, follows_public`.

### Today: followed places

- **Source:** `src/pages/MapPage.jsx` (the Following tab: `journal_follows` `select('node_id')`, then `detections.filter(d => followedSet.has(d.node_id))`; the `detections` section's filters), `src/lib/journalFollows.js`, `supabase/migrations/20260710_journal_follows.sql`. Read at `768bd2f9a7e94c7afd8ee298e2be2f253fab7492`.
- **Call, in order:**
  1. `supabase.from('journal_follows').select('node_id')` (RLS returns only the caller's rows) → `nodeIds`. With no follows, stop: the feed is empty (an empty `.in()` is not sent).
  2. `supabase.from('detections').select('*, species(guild, migratory_status, indicator_status, sensitivity_flag)').in('node_id', nodeIds).gte('confidence', MIN_CONFIDENCE).or('range_status.is.null,range_status.neq.quarantined').gte('detected_at', since).order('detected_at', { ascending: false }).limit(50)`, where `since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()`.
- **Difference from the portal:** MapPage reads the latest 50 detections overall and filters them by followed `node_id` in the browser, with no time window. The app moves the `node_id` filter into the query and adds the 7-day window (plan Task 16). Same table, columns, confidence and range filters, order and limit; no new backend object.
- **Response:** as "Places: node detections" above.

### Journal: my Listens (own rows)

- **Source:** RLS `select own detections` (`supabase/migrations/20260628_listen_phase1_mobile_detections.sql`, `using (auth.uid() = user_id)`); the portal's own-row read in `src/components/ListenModal.jsx` (`supabase.from('mobile_detections').select('*').eq('id', id).single()`). Read at `768bd2f9a7e94c7afd8ee298e2be2f253fab7492`.
- **Call:** `supabase.from('mobile_detections').select('id, detected_at, lat, lon, status, species, published, habitat_type, canopy_cover, water_present, disturbance_level, observer_notes, insight, range_status').eq('user_id', userId).order('detected_at', { ascending: false }).limit(100)`, as the signed-in user.
- **Response:** the user's own rows only, drafts (`published = false`) and posts alike, newest first. Another user's rows never come back (RLS).
- **Difference from the portal:** the portal's journal (`src/pages/JournalPage.jsx`) reads `public_mobile_detections` by `listener_handle`, so it shows posted Listens only. The app reads the base table under the owner policy, the same table and policy as the Result poll (entry 4); no new backend object. The limit of 100 is JournalPage's.

### Today and Map: public Listens

- **Source:** `src/pages/MapPage.jsx` (`mobile` section).
- **Call:** `supabase.from('public_mobile_detections').select('*').order('detected_at', { ascending: false }).limit(50)`.
- **Response:** the view's columns (entry 5).
