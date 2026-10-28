import type { TransactionDatabase } from './client';
import { ApiError } from '../middleware/errors';

export interface StoredPhoto extends Record<string, unknown> {
  id: string;
  owner_user_id: string;
  object_key: string;
  byte_size: number;
  state: 'RESERVED' | 'UPLOADED' | 'ATTACHED';
  published: boolean;
}

export async function readPhoto(database: TransactionDatabase, photoId: string) {
  return database.withTransaction(async (client) => {
    const result = await client.query<StoredPhoto>(
      `SELECT p.id, p.owner_user_id, p.object_key, p.byte_size, p.state,
         (p.state = 'ATTACHED' AND (r.id IS NOT NULL OR parent.id IS NOT NULL)) AS published
       FROM report_photos p
       LEFT JOIN reports r ON p.purpose = 'REPORT' AND r.id = p.report_id
       LEFT JOIN cleanup_submissions cleanup ON p.purpose = 'CLEANUP' AND cleanup.id = p.cleanup_id
       LEFT JOIN reports parent ON parent.id = cleanup.report_id
       WHERE p.id = $1::uuid`, [photoId],
    );
    return result.rows[0] ?? null;
  });
}

/** Operator/scheduler only: retain expired unattached evidence for at least 24 hours. */
export async function removeExpiredPhotos(database: TransactionDatabase, bucket: Pick<R2Bucket, 'delete'>) {
  return database.withTransaction(async (client) => {
    const result = await client.query<{ id: string; object_key: string }>(
      `SELECT p.id, p.object_key FROM report_photos p
       WHERE p.state IN ('RESERVED', 'UPLOADED') AND p.report_id IS NULL AND p.cleanup_id IS NULL
         AND p.upload_expires_at < clock_timestamp() - interval '24 hours'
         AND NOT EXISTS (
           SELECT 1 FROM ai_analyses a WHERE a.photo_ids ? p.id::text
             AND a.status IN ('RUNNING', 'READY') AND a.consumed_at IS NULL
             AND (a.expires_at IS NULL OR a.expires_at > clock_timestamp())
         )
       ORDER BY p.upload_expires_at, p.id LIMIT 25 FOR UPDATE OF p SKIP LOCKED`,
    );
    // Hold photo locks through object deletion so attachment cannot race housekeeping.
    for (const photo of result.rows) {
      try { await bucket.delete(photo.object_key); }
      catch { throw new ApiError(503, 'UNAVAILABLE', 'Photo cleanup is temporarily unavailable.'); }
      await client.query('DELETE FROM report_photos WHERE id = $1::uuid', [photo.id]);
    }
    return result.rows.length;
  });
}
