import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { PostgresTransactionDatabase } from '../src/worker/db/client';
import { sweepUnindexedPhotos, type UnindexedPhotoObject } from '../src/worker/db/evidence-store';
import { parseGoogleIdentity, readGoogleJson } from '../src/worker/services/google-auth';
import { UuidSchema } from '../src/shared/contracts';

export function assertOrphanSweepTarget(config: Record<string, string>, project: string) {
  const identity = parseGoogleIdentity(config.VERTEX_AUTH_JSON);
  if (config.APP_ENV !== 'staging' || identity.environment !== 'staging' || identity.projectId !== project
    || config.GCS_PHOTOS_BUCKET !== project + '-staging-photos'
    || config.APP_URL !== identity.issuer) throw new Error('Orphan sweep requires the matching staging Google configuration.');
}

export function parseOrphanObjects(reply: Record<string, unknown>): UnindexedPhotoObject[] {
  // shortcut: one 1000-object staging page; add resumable pagination before a larger dataset.
  if ((reply.nextPageToken !== undefined && reply.nextPageToken !== '') || (reply.items !== undefined && !Array.isArray(reply.items))
    || (Array.isArray(reply.items) && reply.items.length > 1000)) throw new Error('Orphan listing exceeds its safety bound.');
  const objects: UnindexedPhotoObject[] = [];
  for (const entry of (reply.items ?? []) as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const metadata = item.metadata as Record<string, unknown> | null;
    if (!metadata || typeof metadata !== 'object' || typeof metadata.photoId !== 'string'
      || !UuidSchema.safeParse(metadata.photoId).success || metadata.photoId !== metadata.photoId.toLowerCase()
      || item.name !== 'photos/' + metadata.photoId
      || typeof metadata.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(metadata.sha256)
      || [metadata.expiresAt, item.timeCreated, item.updated, item.generation, item.metageneration].some((v) => typeof v !== 'string')) continue;
    objects.push({ id: metadata.photoId, key: item.name as string, createdAt: item.timeCreated as string,
      updatedAt: item.updated as string, expiresAt: metadata.expiresAt as string,
      generation: item.generation as string, metageneration: item.metageneration as string });
  }
  return objects;
}

export async function removeOrphanObject(bucket: string, token: string, photo: UnindexedPhotoObject,
  fetcher: typeof fetch = fetch): Promise<'deleted' | 'missing' | 'changed'> {
  const query = new URLSearchParams({ ifGenerationMatch: photo.generation, ifMetagenerationMatch: photo.metageneration });
  const response = await fetcher('https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket)
    + '/o/' + encodeURIComponent(photo.key) + '?' + query, {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + token }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (response.status === 204) return 'deleted';
  if (response.status === 404) return 'missing';
  if (response.status === 412) return 'changed';
  throw new Error('Conditional orphan deletion failed.');
}

export async function runOrphanSweep(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, 'proxy-port': { type: 'string' } } });
  if (!values['proxy-port'] || !/^[0-9]{1,5}$/.test(values['proxy-port'])
    || Number(values['proxy-port']) < 1 || Number(values['proxy-port']) > 65535) {
    throw new Error('Usage: node scripts/sweep-photo-orphans.cli.mjs --proxy-port <loopback Cloud SQL Auth Proxy port> [--apply]');
  }
  const bootstrap = JSON.parse(await readFile(new URL('../infra/cloudflare-bootstrap.json', import.meta.url), 'utf8'));
  const project: string = bootstrap.project_id;
  if (project !== 'iskra-512914') throw new Error('This operator command is limited to the ISKRA staging project.');
  function secret(name: string) {
    return JSON.parse(execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret=' + name,
      '--project=' + project], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }));
  }
  const config = secret(bootstrap.environments.staging.secret);
  const access = secret('iskra-staging-sql-access');
  assertOrphanSweepTarget(config, project);
  if (access.project !== project || access.instance !== 'iskra-staging-pg' || access.database !== 'iskra'
    || !config.HYPERDRIVE_ID || access.hyperdrive_id !== config.HYPERDRIVE_ID) {
    throw new Error('Cloud SQL operator configuration does not match staging.');
  }
  const pool = new Pool({ host: '127.0.0.1', port: Number(values['proxy-port']), database: access.database,
    user: 'iskra_runtime', password: access.runtime_password, ssl: false,
    options: '-c search_path=pg_catalog,iskra -c default_transaction_read_only=on',
    max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, query_timeout: 8_000 });
  try {
    const who = await pool.query("SELECT current_database() AS database, current_user AS username, current_setting('default_transaction_read_only') AS readonly");
    if (who.rows[0].database !== 'iskra' || who.rows[0].username !== 'iskra_runtime' || who.rows[0].readonly !== 'on') throw new Error('Wrong database identity or writable connection.');
    const token = execFileSync('gcloud', ['auth', 'print-access-token'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    }).trim();
    const query = new URLSearchParams({ prefix: 'photos/', maxResults: '1000',
      fields: 'nextPageToken,items(name,generation,metageneration,timeCreated,updated,metadata)' });
    const response = await fetch('https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(config.GCS_PHOTOS_BUCKET)
      + '/o?' + query, { headers: { Authorization: 'Bearer ' + token }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error('Google object listing failed.'); }
    const listing = await readGoogleJson(response, 1024 * 1024);
    const objects = parseOrphanObjects(listing);
    const result = await sweepUnindexedPhotos(new PostgresTransactionDatabase(pool), objects,
      (photo) => removeOrphanObject(config.GCS_PHOTOS_BUCKET, token, photo), values.apply);
    console.log(JSON.stringify({ environment: 'staging', listed: Array.isArray(listing.items) ? listing.items.length : 0, ...result }));
    if (result.failed) process.exitCode = 1;
  } finally { await pool.end(); }
}
