// Helpers for the contract tests. They run only against the local stack that
// `scripts/cloud-session-start.sh` starts (spec §4.2). The URLs and keys come from
// `.env.local`, which that script writes from `supabase status` and which
// `tests/setup-env.ts` loads. They are the local stack's throwaway keys.
import { randomUUID } from 'crypto';

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

export const TEST_EMAIL = 'field-test@example.invalid';
export const MAILPIT_URL = 'http://127.0.0.1:54324';
export const AUDIO_BUCKET = 'temp-audio';

// Seeded mobile_detections rows (supabase/seed.sql). resetListens keeps these.
export const SEEDED_LISTEN_IDS = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000004',
  '30000000-0000-4000-8000-000000000005',
  '30000000-0000-4000-8000-000000000006',
  '30000000-0000-4000-8000-000000000007',
];

const NOT_STARTED = 'run scripts/cloud-session-start.sh first';
const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

// Each variable is read by its literal name (expo/no-dynamic-env-var).
function need(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is unset: ${NOT_STARTED}`);
  return value;
}

export function supabaseUrl(): string {
  const url = need('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL);
  // The contract tests may only ever touch the local stack (spec §4.4).
  if (!LOOPBACK.has(new URL(url).hostname)) {
    throw new Error(`EXPO_PUBLIC_SUPABASE_URL is not the local stack: ${NOT_STARTED}`);
  }
  return url;
}

export function portalOrigin(): string {
  const origin = need('EXPO_PUBLIC_PORTAL_ORIGIN', process.env.EXPO_PUBLIC_PORTAL_ORIGIN);
  if (!LOOPBACK.has(new URL(origin).hostname)) {
    throw new Error(`EXPO_PUBLIC_PORTAL_ORIGIN is not the local fake: ${NOT_STARTED}`);
  }
  return origin;
}

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };

/** A client with the local anon key, as the app holds it. */
export function localClient(): SupabaseClient {
  return createClient(supabaseUrl(), need('EXPO_PUBLIC_SUPABASE_ANON_KEY', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY), noPersist);
}

/**
 * A service-role client for test setup and checks the user can't make
 * (e.g. reading temp-audio, which has no select policy). Never used by app code.
 */
export function serviceClient(): SupabaseClient {
  return createClient(supabaseUrl(), need('LOCAL_SUPABASE_SERVICE_ROLE_KEY', process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY), noPersist);
}

type MailpitMessage = { ID: string; Created: string; To: { Address: string }[] };

async function mailpit(pathAndQuery: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${MAILPIT_URL}${pathAndQuery}`, init);
  if (!res.ok) throw new Error(`Mailpit ${pathAndQuery} returned ${res.status}`);
  return res;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for the one-time code Supabase Auth sent to `email`, read from the local
 * Mailpit API (declared deviation D1: the spec's "fixed one-time code" is not
 * possible, the local stack mails a fresh code each time).
 */
export async function readOtpFromMailpit(email: string, timeoutMs = 15_000): Promise<string> {
  const query = encodeURIComponent(`to:"${email}"`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = (await (await mailpit(`/api/v1/search?query=${query}&limit=1`)).json()) as {
      messages: MailpitMessage[];
    };
    const latest = list.messages[0];
    if (latest) {
      const msg = (await (await mailpit(`/api/v1/message/${latest.ID}`)).json()) as {
        Text?: string;
        HTML?: string;
      };
      const body = `${msg.Text ?? ''}\n${msg.HTML ?? ''}`;
      const code = body.match(/\b(\d{6})\b/);
      if (code) return code[1];
      throw new Error(`no 6-digit code in the latest Mailpit message for ${email}`);
    }
    await sleep(250);
  }
  throw new Error(`no email for ${email} in Mailpit after ${timeoutMs} ms: ${NOT_STARTED}`);
}

function isOtpRateLimit(error: { status?: number; message: string }): boolean {
  return error.status === 429 || /only request this after/i.test(error.message);
}

/** Signs `email` in the way the portal's AuthModal does: signInWithOtp, then verifyOtp. */
export async function signInWithEmailOtp(
  email: string,
  client: SupabaseClient = localClient(),
): Promise<Session> {
  // Clear old mail for this address so the code we read is the one sent now.
  await mailpit(`/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`, { method: 'DELETE' });
  // Auth allows one code per address per max_frequency (supabase/config.toml,
  // 1s). A run started right after another one's sign-in can hit that window
  // ("you can only request this after N seconds", HTTP 429): wait it out.
  let sent = await client.auth.signInWithOtp({ email });
  for (let tries = 0; sent.error && isOtpRateLimit(sent.error) && tries < 5; tries++) {
    await sleep(1_100);
    sent = await client.auth.signInWithOtp({ email });
  }
  if (sent.error) throw sent.error;
  const token = await readOtpFromMailpit(email);
  const verified = await client.auth.verifyOtp({ email, token, type: 'email' });
  if (verified.error) throw verified.error;
  if (!verified.data.session) throw new Error('verifyOtp returned no session');
  return verified.data.session;
}

/** Signs in the seeded test user, `field-test@example.invalid`. */
export async function signInTestUser(): Promise<Session> {
  return signInWithEmailOtp(TEST_EMAIL);
}

/** A client acting as the signed-in user of `session`. */
export function userClient(session: Session): SupabaseClient {
  const client = createClient(supabaseUrl(), need('EXPO_PUBLIC_SUPABASE_ANON_KEY', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY), {
    ...noPersist,
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
  return client;
}

/**
 * Deletes every Listen the tests made (every mobile_detections row that is not
 * seeded), and the audio they uploaded. Seeded rows stay.
 */
export async function resetListens(): Promise<void> {
  const admin = serviceClient();
  const seeded = `(${SEEDED_LISTEN_IDS.join(',')})`;
  const { data: rows, error } = await admin
    .from('mobile_detections')
    .select('id, audio_path')
    .not('id', 'in', seeded);
  if (error) throw error;
  const paths = (rows ?? []).map((r) => r.audio_path as string | null).filter((p): p is string => !!p);
  if (paths.length) {
    const removed = await admin.storage.from(AUDIO_BUCKET).remove(paths);
    if (removed.error) throw removed.error;
  }
  const deleted = await admin.from('mobile_detections').delete().not('id', 'in', seeded);
  if (deleted.error) throw deleted.error;
}

/** Polls `read` until `done` holds or `timeoutMs` passes; returns the last value. */
export async function pollUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(everyMs);
    value = await read();
  }
  return value;
}

/** A Listen row as the owner reads it in the contract tests. */
export type OwnListen = {
  id: string;
  status: string;
  species: { common_name: string }[] | null;
  published: boolean;
  audio_path: string | null;
};

// Four bytes are enough: the fake worker never decodes the audio.
export const TEST_AUDIO = new Uint8Array([0, 0, 0, 24]);
// More than 3 decimals, so the public view's rounding is visible.
export const TEST_LAT = 29.2512345;
export const TEST_LON = -103.2498765;

/**
 * Inserts a pending, unpublished Listen as the signed-in user, the way
 * listenQueue.js's syncQueuedListen does after its upload.
 */
export async function insertPendingListen(
  db: SupabaseClient,
  userId: string,
  id: string,
  audioPath: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db.from('mobile_detections').insert({
    id,
    user_id: userId,
    lat: TEST_LAT,
    lon: TEST_LON,
    status: 'pending',
    audio_path: audioPath,
    detected_at: now,
    device_info: { platform: 'contract-test', tz_offset: -300 },
    synced_at: now,
    published: false,
  });
  if (error) throw error;
}

/** Reads one of the user's own Listens (RLS `select own detections`), or null. */
export async function readOwnListen(db: SupabaseClient, id: string): Promise<OwnListen | null> {
  const { data, error } = await db
    .from('mobile_detections')
    .select('id, status, species, published, audio_path')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data as OwnListen | null;
}

/** Polls the user's own Listen until it has `status`; returns the last read. */
export async function waitForListenStatus(
  db: SupabaseClient,
  id: string,
  status: string,
  timeoutMs = 10_000,
): Promise<OwnListen | null> {
  return pollUntil(() => readOwnListen(db, id), (r) => r?.status === status, timeoutMs);
}

/**
 * The app's whole capture flow up to the consent step: upload `<id>.m4a`, insert
 * the pending row, and wait for the fake worker to complete it. Returns the id of
 * a complete, unpublished draft (`published = false`).
 */
export async function createCompleteDraft(session: Session): Promise<string> {
  const id = randomUUID();
  const upload = await uploadViaFunction(session, AUDIO_BUCKET, `${id}.m4a`, TEST_AUDIO);
  if (upload.status !== 200 || !upload.body.path) {
    throw new Error(`upload for draft ${id} failed: ${upload.status} ${upload.body.error ?? ''}`);
  }
  const db = userClient(session);
  await insertPendingListen(db, session.user.id, id, upload.body.path);
  const row = await waitForListenStatus(db, id, 'complete');
  if (row?.status !== 'complete' || row.published !== false) {
    throw new Error(`draft ${id} did not become a complete unpublished draft (status ${row?.status})`);
  }
  return id;
}

/** Uploads bytes through the portal's storage-upload Edge Function, as storageUpload.js does. */
export async function uploadViaFunction(
  session: Session,
  bucket: string,
  filename: string,
  bytes: Uint8Array,
  type = 'audio/mp4',
): Promise<{ status: number; body: { path?: string; error?: string } }> {
  const form = new FormData();
  form.append('file', new Blob([bytes as BlobPart], { type }), filename);
  form.append('bucket', bucket);
  form.append('filename', filename);
  const res = await fetch(`${supabaseUrl()}/functions/v1/storage-upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
  return { status: res.status, body };
}
