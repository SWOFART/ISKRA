import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { withTestDatabase } from '../auth/postgres';
import { PostgresTransactionDatabase, type TransactionDatabase } from '../../../src/worker/db/client';
import { readPhoto, removeExpiredPhotos } from '../../../src/worker/db/evidence-store';
import { authorizePhotoRead, createPhotoReadCapability, createReportMediaResolver } from '../../../src/worker/services/media';
import { PostgresReportReadService } from '../../../src/worker/services/report-context';
import { createApp } from '../../../src/worker';

const migration = await readFile(new URL('../../../migrations/0001_p0_core.sql', import.meta.url), 'utf8');
const origin = 'https://iskra.test';
const secret = 'integration-photo-signing-key-at-least-32-bytes';
const owner = 'photo-owner';

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
