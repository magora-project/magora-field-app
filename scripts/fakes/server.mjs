// Local fake for the services outside this repo (spec §4.2, plan Task 4):
//   * the Fly.io BirdNET worker: drains the `audio_inference` queue through the
//     portal's queue RPCs and writes a canned result to each Listen;
//   * the portal's `POST /api/insight`: answers with a canned insight.
//
// Started in the background by scripts/cloud-session-start.sh. It talks only to
// the local stack: SUPABASE_URL must be a loopback URL, and the key is the local
// stack's throwaway service-role key, passed in the environment, never stored.
//
// Rules, keyed on the audio filename (the last segment of audio_path):
//   fail-*  -> status 'failed', message deleted
//   hold-*  -> left 'pending', message NOT deleted (it reappears after the
//              visibility timeout, like a worker that never finishes)
//   other   -> status 'complete' with one Cactus Wren, message deleted
// A message whose Listen row no longer exists is deleted.
import http from 'node:http';

const PORT = Number(process.env.FAKE_PORT ?? 8787);
const POLL_MS = Number(process.env.FAKE_POLL_MS ?? 2000);
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const CANNED_SPECIES = [
  { common_name: 'Cactus Wren', scientific_name: 'Campylorhynchus brunneicapillus', confidence: 0.82 },
];
const CANNED_INSIGHT = 'The wash is busy this morning.';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function assertLocal() {
  let host = '';
  try {
    host = new URL(SUPABASE_URL).hostname;
  } catch {
    // fall through
  }
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    console.error('fake: SUPABASE_URL must be the local stack (127.0.0.1 or localhost)');
    process.exit(1);
  }
  if (!SERVICE_KEY) {
    console.error('fake: SUPABASE_SERVICE_ROLE_KEY is unset');
    process.exit(1);
  }
}

// Each request, body read included, is aborted after this long, so a stalled
// Supabase response cannot hold `draining` for undici's 300 s defaults.
const REQUEST_TIMEOUT_MS = 15_000;

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const rpc = (name, args) => rest(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });

function outcomeFor(audioPath) {
  const filename = String(audioPath ?? '').split('/').pop() ?? '';
  if (filename.startsWith('hold-')) return 'hold';
  if (filename.startsWith('fail-')) return 'failed';
  return 'complete';
}

async function handleJob(job) {
  const { detection_id: id, audio_path: audioPath } = job.message ?? {};
  const rows = await rest(`mobile_detections?id=eq.${encodeURIComponent(id)}&select=id`);
  if (!rows.length) {
    await rpc('delete_audio_job', { p_msg_id: job.msg_id });
    log(`job ${job.msg_id}: no row ${id}, message deleted`);
    return;
  }
  const outcome = outcomeFor(audioPath);
  if (outcome === 'hold') {
    log(`job ${job.msg_id}: ${id} held pending`);
    return;
  }
  const patch = outcome === 'failed' ? { status: 'failed' } : { status: 'complete', species: CANNED_SPECIES };
  await rest(`mobile_detections?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  await rpc('delete_audio_job', { p_msg_id: job.msg_id });
  log(`job ${job.msg_id}: ${id} -> ${patch.status}`);
}

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    // A 30 s visibility timeout: a held message comes back, like a stuck worker's.
    const jobs = await rpc('read_audio_jobs', { p_qty: 10, p_vt: 30 });
    for (const job of jobs ?? []) {
      try {
        await handleJob(job);
      } catch (err) {
        log(`job ${job.msg_id}: ${err.message}`);
      }
    }
  } catch (err) {
    log(`drain: ${err.message}`);
  } finally {
    draining = false;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function send(res, status, body) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/insight') {
    if (req.method !== 'POST') {
      send(res, 405, { error: 'POST only' });
      return;
    }
    // A client that drops mid-body makes `req` emit 'error'; without a
    // listener that would crash the fake.
    req.on('error', (err) => log(`fake: /api/insight request error: ${err.message}`));
    req.resume();
    req.on('end', () => send(res, 200, { insight: CANNED_INSIGHT }));
    return;
  }
  send(res, 404, { error: 'not found' });
});

assertLocal();
server.listen(PORT, '127.0.0.1', () => {
  log(`fake: listening on http://127.0.0.1:${PORT}, draining audio_inference every ${POLL_MS} ms`);
});
const timer = setInterval(drain, POLL_MS);

function stop() {
  clearInterval(timer);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
