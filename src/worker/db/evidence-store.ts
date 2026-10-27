import type { UploadRequestSchema } from '../../shared/contracts';
import type { Infer } from '../../shared/schema';
import type { TransactionDatabase } from './client';
import { ApiError } from '../middleware/errors';

/** Read admission only: a ticket does not claim a cleanup or create usable evidence. */
export async function admitUpload(
  database: TransactionDatabase,
  uid: string,
  request: Infer<typeof UploadRequestSchema>,
  photoId?: string,
): Promise<void> {
  await database.withTransaction(async (client) => {
    const user = await client.query('SELECT id FROM users WHERE id = $1', [uid]);
    if (!user.rows.length) {
      throw new ApiError(403, 'NOT_ELIGIBLE', 'Complete account setup before uploading photos.');
    }
    if (request.purpose === 'CLEANUP') {
      const report = await client.query<{ route: string; status: string }>(
        'SELECT route, status FROM reports WHERE id = $1', [request.reportId],
      );
      const target = report.rows[0];
      if (!target) throw new ApiError(404, 'NOT_FOUND', 'Report not found.');
      if (target.route !== 'GREEN' || target.status !== 'VERIFIED') {
        throw new ApiError(403, 'NOT_ELIGIBLE', 'This report cannot accept cleanup evidence.');
      }
    }
    if (photoId) {
      const photo = await client.query('SELECT id FROM report_photos WHERE id = $1', [photoId]);
      if (photo.rows.length) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This photo ID has already been used.');
      }
    }
  });
}
