import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { withTestDatabase } from '../auth/postgres';
import { PostgresTransactionDatabase, type TransactionDatabase } from '../../../src/worker/db/client';
import { readPhoto, removeExpiredPhotos, sweepUnindexedPhotos, type UnindexedPhotoObject } from '../../../src/worker/db/evidence-store';
import { authorizePhotoRead, createPhotoReadCapability, createReportMediaResolver } from '../../../src/worker/services/media';
import { PostgresReportReadService } from '../../../src/worker/services/report-context';
import { createApp } from '../../../src/worker';
import { PhotoSchema } from '../../../src/shared/contracts';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const origin = 'https://iskra.test';
const secret = 'integration-photo-signing-key-at-least-32-bytes';
const owner = 'photo-owner';
function orphan(id = crypto.randomUUID()): UnindexedPhotoObject {
  const old = new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString();
  return { id, key: 'photos/' + id, createdAt: old, updatedAt: old, expiresAt: old, generation: '1234', metageneration: '1' };
}

async function setup(pool: Pool) {
  await pool.query(migration);
  await pool.query("INSERT INTO users(id,nickname) VALUES ($1, 'Resident')", [owner]);
  return new PostgresTransactionDatabase(pool);
}
async function photo(pool: Pool, { expired = true, reportId }: { expired?: boolean; reportId?: string } = {}) {
  const id = crypto.randomUUID(); const key = `private-evidence/${crypto.randomUUID()}`;
  await pool.query(
    `INSERT INTO report_photos(id,owner_user_id,purpose,state,report_id,object_key,ordinal,mime_type,byte_size,sha256,upload_expires_at)
     VALUES($1,$2,'REPORT',$3,$4,$5,0,'image/jpeg',3,$6,
       CASE WHEN $7 THEN now()-interval '25 hours' ELSE now()+interval '5 minutes' END)`,
    [id,owner,reportId ? 'ATTACHED' : 'UPLOADED',reportId ?? null,key,'a'.repeat(64),expired],
  );
  return { id, key, ordinal: 1, purpose: 'REPORT' as const };
}
async function report(pool: Pool) {
  const analysis = await pool.query<{ id: string }>(
    `INSERT INTO ai_analyses(owner_user_id,kind,status,input_hash,result,expires_at)
     VALUES($1,'REPORT','READY',$2,'{"decision":"ACCEPT"}',now()+interval '15 minutes') RETURNING id`,
    [owner,crypto.randomUUID()],
  );
  const result = await pool.query<{ id: string }>(
    `INSERT INTO reports(author_user_id,route,description,lat,lng,measured_lat,measured_lng,accuracy_m,captured_location_at,analysis_id)
     VALUES($1,'GREEN','Controlled litter example',49.14,9.22,49.14,9.22,10,now(),$2) RETURNING id`,
    [owner,analysis.rows[0].id],
  );
  return result.rows[0].id;
}

// R2 is an explicit object-store test double; the SQL/locking below uses real PostgreSQL.
describe('photo authorization and orphan transactions', () => {
  it('sweeps only unindexed old objects, preserving attached/reserved/uploads and even row-less live analysis references', () =>
    withTestDatabase(async (pool) => {
      const database = await setup(pool);
      const attached = await photo(pool, { reportId: await report(pool) });
      const uploaded = await photo(pool); const reserved = await photo(pool);
      await pool.query("UPDATE report_photos SET state='RESERVED' WHERE id=$1", [reserved.id]);
      const activeId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO ai_analyses(owner_user_id,kind,status,input_hash,photo_ids,expires_at)
         VALUES($1,'REPORT','RUNNING',$2,$3::jsonb,now()+interval '45 seconds')`,
        [owner, crypto.randomUUID(), JSON.stringify([activeId])],
      );
      const abandoned = orphan();
      const objects = [orphan(attached.id), orphan(uploaded.id), orphan(reserved.id), orphan(activeId), abandoned];
      let insideTransaction = false;
      const observed: TransactionDatabase = { withTransaction: (work) => database.withTransaction(async (client) => {
        insideTransaction = true; try { return await work(client); } finally { insideTransaction = false; }
      }) };
      const remove = vi.fn(async () => { expect(insideTransaction).toBe(false); return 'deleted' as const; });
      expect(await sweepUnindexedPhotos(observed, objects, remove)).toMatchObject({ eligible: 1, protected: 4, deleted: 0, dryRun: true });
      expect(remove).not.toHaveBeenCalled();
      expect(await sweepUnindexedPhotos(observed, objects, remove, true)).toMatchObject({ deleted: 1, protected: 4, failed: false });
      expect(remove).toHaveBeenCalledExactlyOnceWith(abandoned);
      expect((await pool.query('SELECT count(*)::int AS n FROM report_photos')).rows[0].n).toBe(3);
      expect((await pool.query('SELECT count(*)::int AS n FROM ai_analyses')).rows[0].n).toBe(2);
      expect((await pool.query('SELECT count(*)::int AS n FROM reward_ledger')).rows[0].n).toBe(0);
    }));

  it('rechecks SQL references after listing and preserves a newly indexed object', () => withTestDatabase(async (pool) => {
    const database = await setup(pool); const object = orphan(); let checks = 0;
    const raced: TransactionDatabase = { withTransaction: (work) => database.withTransaction((client) => work({
      query: async <Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) => {
        const result = await client.query<Row>(sql, parameters);
        if (sql.includes('jsonb_array_elements_text') && ++checks === 1) {
          await pool.query(
            `INSERT INTO report_photos(id,owner_user_id,purpose,state,object_key,ordinal,mime_type,byte_size,sha256,upload_expires_at)
             VALUES($1,$2,'REPORT','UPLOADED',$3,0,'image/jpeg',3,$4,now())`,
            [object.id, owner, object.key, 'a'.repeat(64)],
          );
        }
        return result;
      },
    })) };
    const remove = vi.fn(async () => 'deleted' as const);
    expect(await sweepUnindexedPhotos(raced, [object], remove, true)).toMatchObject({ selected: 1, protected: 1, deleted: 0 });
    expect(remove).not.toHaveBeenCalled();
  }));

  it('bounds deletes to25, treats changed/missing generations safely and stops after a storage failure', () => withTestDatabase(async (pool) => {
    const database = await setup(pool); const objects = Array.from({ length: 30 }, () => orphan());
    const remove = vi.fn(async () => 'deleted' as const);
    expect(await sweepUnindexedPhotos(database, objects, remove, true)).toMatchObject({ eligible: 30, selected: 25, deleted: 25 });
    expect(remove).toHaveBeenCalledTimes(25);
    const outcomes = vi.fn().mockResolvedValueOnce('changed').mockResolvedValueOnce('missing').mockRejectedValueOnce(new Error('private provider detail'));
    expect(await sweepUnindexedPhotos(database, objects, outcomes, true)).toMatchObject({ changed: 1, missing: 1, deleted: 0, failed: true });
    expect(outcomes).toHaveBeenCalledTimes(3);
    expect((await pool.query('SELECT count(*)::int AS n FROM report_photos')).rows[0].n).toBe(0);
  }));

  it('issues and refreshes owner previews after PUT expiry without exposing storage keys or granting guest access', () =>
    withTestDatabase(async (pool) => {
      const database = await setup(pool);
      const uploaded = await photo(pool, { expired: false });
      await pool.query("UPDATE report_photos SET ordinal = 4, upload_expires_at = now() - interval '10 minutes' WHERE id = $1", [uploaded.id]);
      const get = vi.fn(async () => ({ size: 3, body: new Response(new Uint8Array([1, 2, 3])).body }));
      const env = { FIREBASE_PROJECT_ID: 'iskra-test', PHOTOS: { get } as unknown as R2Bucket, MEDIA_SIGNING_SECRET: secret };
      const app = createApp({ database, verify: async (uid) => ({ uid }) });
      const request = (uid?: string) => app.request(`${origin}/api/photos/${uploaded.id.toUpperCase()}`, {
        headers: uid ? { Authorization: 'Bearer ' + uid } : {},
      }, env);
      expect((await request()).status).toBe(401);
      expect((await request('foreign-owner')).status).toBe(404);
      const response = await request(owner);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      const preview = PhotoSchema.parse(await response.json());
      expect(preview).toMatchObject({ id: uploaded.id, ordinal: 5 });
      expect(JSON.stringify(preview)).not.toContain(uploaded.key);
      expect(get).not.toHaveBeenCalled();
      expect((await app.request(preview.mediaUrl, {}, env)).status).toBe(403);
      expect((await app.request(preview.mediaUrl, { headers: { Authorization: 'Bearer foreign-owner' } }, env)).status).toBe(403);
      expect((await app.request(preview.mediaUrl, { headers: { Authorization: 'Bearer ' + owner } }, env)).status).toBe(200);
      try {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 301_000);
        expect((await app.request(preview.mediaUrl, { headers: { Authorization: 'Bearer ' + owner } }, env)).status).toBe(410);
        const refreshed = PhotoSchema.parse(await (await request(owner)).json());
        expect(refreshed.mediaUrl).not.toBe(preview.mediaUrl);
        expect((await app.request(refreshed.mediaUrl, { headers: { Authorization: 'Bearer ' + owner } }, env)).status).toBe(200);
        await pool.query("UPDATE report_photos SET state = 'RESERVED' WHERE id = $1", [uploaded.id]);
        expect((await app.request(refreshed.mediaUrl, { headers: { Authorization: 'Bearer ' + owner } }, env)).status).toBe(404);
      } finally { vi.useRealTimers(); }
    }));

  it('limits preview issuance to retained unattached uploads or photos protected by a live analysis', () =>
    withTestDatabase(async (pool) => {
      const database = await setup(pool);
      const attached = await photo(pool, { reportId: await report(pool) });
      const expired = await photo(pool);
      const reserved = await photo(pool, { expired: false });
      await pool.query("UPDATE report_photos SET state = 'RESERVED' WHERE id = $1", [reserved.id]);
      const protectedPhoto = await photo(pool);
      const analysis = await pool.query<{ id: string }>(
        `INSERT INTO ai_analyses(owner_user_id,kind,status,input_hash,photo_ids,expires_at)
         VALUES($1,'REPORT','RUNNING',$2,$3::jsonb,now()+interval '45 seconds') RETURNING id`,
        [owner, crypto.randomUUID(), JSON.stringify([protectedPhoto.id])],
      );
      const env = { FIREBASE_PROJECT_ID: 'iskra-test', PHOTOS: {} as R2Bucket, MEDIA_SIGNING_SECRET: secret };
      const app = createApp({ database, verify: async () => ({ uid: owner }) });
      const preview = (id: string) => app.request(`${origin}/api/photos/${id}`, { headers: { Authorization: 'Bearer test' } }, env);
      for (const id of [attached.id, expired.id, reserved.id, crypto.randomUUID()]) {
        const response = await preview(id);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: 'Photo not found.' } });
      }
      expect((await preview(protectedPhoto.id)).status).toBe(200);
      await pool.query("UPDATE ai_analyses SET created_at=now()-interval '1 minute', expires_at=now()-interval '1 second' WHERE id=$1", [analysis.rows[0].id]);
      expect((await preview(protectedPhoto.id)).status).toBe(404);
    }));

  it('projects and serves real database-attached photos to guests, while private photos require their owner', () =>
    withTestDatabase(async (pool) => {
      const database = await setup(pool);
      const reportId = await report(pool);
      const attached = await photo(pool, { reportId });
      const unattached = await photo(pool, { expired: false });
      const media = createReportMediaResolver(origin, secret);
      const detail = await new PostgresReportReadService(database, media).getDetail(reportId);
      expect(detail?.beforePhotos[0].id).toBe(attached.id);
      expect(detail).not.toHaveProperty('viewer');
      expect(JSON.stringify(detail)).not.toContain(attached.key);
      const get = vi.fn(async (key: string) => {
        expect(key).toBe(attached.key);
        return { size: 3, body: new Response(new Uint8Array([1,2,3])).body };
      });
      const env = { PHOTOS: { get } as unknown as R2Bucket, MEDIA_SIGNING_SECRET: secret };
      const response = await createApp({ database }).request(detail!.beforePhotos[0].mediaUrl, {}, env);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1,2,3]));
      const ownerLink = await createPhotoReadCapability(unattached, origin, secret, owner);
      const token = new URL(ownerLink.mediaUrl).searchParams.get('token')!;
      await expect(authorizePhotoRead(database, unattached.id, token, origin, secret)).rejects.toMatchObject({ code:'FORBIDDEN' });
      await expect(authorizePhotoRead(database, unattached.id, token, origin, secret, 'other')).rejects.toMatchObject({ code:'FORBIDDEN' });
      await expect(authorizePhotoRead(database, unattached.id, token, origin, secret, owner)).resolves.toMatchObject({ id:unattached.id });
    }));

  it('removes only long-expired unattached rows, preserving attached, fresh and active-analysis evidence', () =>
    withTestDatabase(async (pool) => {
      const database = await setup(pool);
      const reportId = await report(pool);
      const attached = await photo(pool, { reportId });
      const expired = await photo(pool);
      const fresh = await photo(pool, { expired:false });
      const analyzing = await photo(pool);
      await pool.query(
        `INSERT INTO ai_analyses(owner_user_id,kind,status,input_hash,photo_ids)
         VALUES($1,'REPORT','RUNNING',$2,$3::jsonb)`,[owner,crypto.randomUUID(),JSON.stringify([analyzing.id])],
      );
      const remove = vi.fn(async () => {});
      expect(await removeExpiredPhotos(database, { delete:remove })).toBe(1);
      expect(remove).toHaveBeenCalledExactlyOnceWith(expired.key);
      expect(await readPhoto(database, expired.id)).toBeNull();
      for (const row of [attached,fresh,analyzing]) expect(await readPhoto(database,row.id)).not.toBeNull();
      expect(await removeExpiredPhotos(database, { delete:remove })).toBe(0);
    }));

  it('skips locked evidence, holds its own photo locks through deletion, and prevents a racing attachment', () =>
    withTestDatabase(async (pool) => {
      const database = await setup(pool);
      const reportId = await report(pool);
      const expired = await photo(pool);
      const locker = await pool.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM report_photos WHERE id=$1 FOR UPDATE',[expired.id]);
        const remove = vi.fn(async () => {});
        expect(await removeExpiredPhotos(database,{delete:remove})).toBe(0);
        expect(remove).not.toHaveBeenCalled();
        await locker.query('ROLLBACK');
        const deletion = vi.fn(async () => {
          await locker.query('BEGIN');
          await locker.query("SET LOCAL lock_timeout='100ms'");
          await expect(locker.query("UPDATE report_photos SET state='ATTACHED',report_id=$2 WHERE id=$1",[expired.id,reportId]))
            .rejects.toMatchObject({code:'55P03'});
          await locker.query('ROLLBACK');
        });
        expect(await removeExpiredPhotos(database,{delete:deletion})).toBe(1);
        expect(deletion).toHaveBeenCalledExactlyOnceWith(expired.key);
      } finally { await locker.query('ROLLBACK'); locker.release(); }
    }));

  it('keeps retryable rows after storage failure or SQL failure following object deletion', () =>
    withTestDatabase(async (pool) => {
      const database = await setup(pool);
      const expired = await photo(pool);
      await expect(removeExpiredPhotos(database,{delete:async()=>{throw new Error('private storage credential');}}))
        .rejects.toMatchObject({code:'UNAVAILABLE',message:'Photo cleanup is temporarily unavailable.'});
      expect(await readPhoto(database,expired.id)).not.toBeNull();
      const failing:TransactionDatabase = { withTransaction:work=>database.withTransaction(client=>work({
        query:async(text,parameters)=> {
          if(text.startsWith('DELETE FROM report_photos')) throw new Error('injected rollback');
          return client.query(text,parameters);
        },
      })) };
      const remove = vi.fn(async () => {});
      await expect(removeExpiredPhotos(failing,{delete:remove})).rejects.toThrow('injected rollback');
      expect(await readPhoto(database,expired.id)).not.toBeNull();
      expect(await removeExpiredPhotos(database,{delete:remove})).toBe(1);
      expect(remove).toHaveBeenCalledTimes(2);
      expect(await readPhoto(database,expired.id)).toBeNull();
    }));

  it('bounds each housekeeping invocation to 25 objects', () => withTestDatabase(async(pool)=>{
    const database=await setup(pool);
    for(let i=0;i<26;i++)await photo(pool);
    const remove=vi.fn(async()=>{});
    expect(await removeExpiredPhotos(database,{delete:remove})).toBe(25);
    expect(await removeExpiredPhotos(database,{delete:remove})).toBe(1);
    expect(await removeExpiredPhotos(database,{delete:remove})).toBe(0);
    expect(remove).toHaveBeenCalledTimes(26);
  }));
});
