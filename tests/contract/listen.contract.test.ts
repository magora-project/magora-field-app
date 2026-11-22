/**
 * @jest-environment node
 */
// Contract tests for the Listen loop (spec §3) against the local stack and the
// fake worker. Start the stack first: `bash scripts/cloud-session-start.sh`
// (locally, with FIELD_STACK=1).
//
// Each test makes its own Listen, so any one of them passes alone
// (`npm run test:contract -- -t '<name>'`).
import { randomUUID } from 'crypto';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

import {
  AUDIO_BUCKET,
  TEST_AUDIO,
  createCompleteDraft,
  insertPendingListen,
  localClient,
  readOwnListen,
  resetListens,
  serviceClient,
  signInTestUser,
  uploadViaFunction,
  userClient,
  waitForListenStatus,
} from './stack';

jest.setTimeout(60_000);

let session: Session;
let uid: string;
let db: SupabaseClient;

beforeAll(async () => {
  await resetListens();
  session = await signInTestUser();
  uid = session.user.id;
  db = userClient(session);
});

afterAll(async () => {
  await resetListens();
});

async function publicRows(id: string) {
  const { data, error } = await localClient()
    .from('public_mobile_detections')
    .select('id, lat, lon, species')
    .eq('id', id);
  expect(error).toBeNull();
  return data ?? [];
}

describe('Listen contract', () => {
  test('upload lands at {uid}/{filename} in temp-audio', async () => {
    const res = await uploadViaFunction(session, AUDIO_BUCKET, 't1.m4a', TEST_AUDIO);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: `${uid}/t1.m4a` });

    const { data, error } = await serviceClient().storage.from(AUDIO_BUCKET).list(uid, { search: 't1.m4a' });
    expect(error).toBeNull();
    expect((data ?? []).map((o) => o.name)).toContain('t1.m4a');
  });

  test('pending insert is enqueued and completed by the worker', async () => {
    const id = randomUUID();
    const upload = await uploadViaFunction(session, AUDIO_BUCKET, `${id}.m4a`, TEST_AUDIO);
    expect(upload.status).toBe(200);
    expect(upload.body.path).toBe(`${uid}/${id}.m4a`);

    await insertPendingListen(db, uid, id, upload.body.path as string);
    expect((await readOwnListen(db, id))?.status).toMatch(/^(pending|complete)$/);

    const row = await waitForListenStatus(db, id, 'complete');
    expect(row?.status).toBe('complete');
    expect(row?.species?.[0]?.common_name).toBe('Cactus Wren');
  });

  test('unpublished complete row is not public', async () => {
    const id = await createCompleteDraft(session);
    expect(await publicRows(id)).toEqual([]);
  });

  test('publishing makes it public', async () => {
    const id = await createCompleteDraft(session);
    expect(await publicRows(id)).toEqual([]);

    const { error } = await db.from('mobile_detections').update({ published: true }).eq('id', id);
    expect(error).toBeNull();

    const rows = await publicRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].lat).toBe(29.251);
    expect(rows[0].lon).toBe(-103.25);
    expect(rows[0].species[0].common_name).toBe('Cactus Wren');
  });

  test('discard deletes own draft', async () => {
    // The app's discard: a complete Listen the user chose not to post.
    const id = await createCompleteDraft(session);

    const { error } = await db.from('mobile_detections').delete().eq('id', id);
    expect(error).toBeNull();

    expect(await readOwnListen(db, id)).toBeNull();
    // Gone from the table, not only hidden from the user.
    const { data } = await serviceClient().from('mobile_detections').select('id').eq('id', id);
    expect(data).toEqual([]);
  });

  test('fail- audio ends failed', async () => {
    const id = randomUUID();
    await insertPendingListen(db, uid, id, `${uid}/fail-${id}.m4a`);

    const row = await waitForListenStatus(db, id, 'failed');
    expect(row?.status).toBe('failed');
    expect(row?.species).toBeNull();
  });
});
