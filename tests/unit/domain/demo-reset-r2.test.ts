import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createWranglerObjectStore } from '../../../scripts/reset-demo';
import { demoSeedPhotoObjectKeys } from '../../../src/worker/services/demo-seeds';

const execFileAsync = promisify(execFile);
const bucket = 'iskra-demo';
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const wranglerCli = fileURLToPath(new URL('../../../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const fixture = await readFile(new URL('../../fixtures/photos/restart.jpg', import.meta.url));

function localWranglerEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SYSTEMROOT: process.env.SYSTEMROOT,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
  };
}

describe('guarded demo reset with Wrangler local R2', () => {
  it('deletes only the exact seeded photo keys and preserves other bucket objects', async () => {
    const temporaryState = await mkdtemp(join(tmpdir(), 'iskra-demo-reset-r2-'));
    const fixturePath = join(temporaryState, 'controlled-photo.jpg');
    const downloadPath = join(temporaryState, 'downloaded-photo.jpg');
    const hash = createHash('sha256').update(fixture).digest('hex');
    const keys = Object.values(demoSeedPhotoObjectKeys(hash));
    const unrelatedKey = 'uploads/unrelated/photo.jpg';

    async function runWrangler(...args: string[]) {
      await execFileAsync(process.execPath, [wranglerCli, ...args], {
        cwd: repositoryRoot,
        env: localWranglerEnvironment(),
        timeout: 30_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      });
    }

    async function put(key: string) {
      await runWrangler(
        'r2', 'object', 'put', `${bucket}/${key}`, `--file=${fixturePath}`,
        '--content-type=image/jpeg', '--local', '--persist-to', temporaryState, '--force',
      );
    }

    async function get(key: string) {
      await runWrangler(
        'r2', 'object', 'get', `${bucket}/${key}`, `--file=${downloadPath}`,
        '--local', '--persist-to', temporaryState,
      );
      return readFile(downloadPath);
    }

    try {
      await writeFile(fixturePath, fixture);
      for (const key of keys) await put(key);
      await put(unrelatedKey);

      await createWranglerObjectStore(bucket, temporaryState).deleteObjectKeys(keys);

      for (const key of keys) {
        await expect(get(key)).rejects.toThrow();
      }
      await expect(get(unrelatedKey)).resolves.toEqual(fixture);
    } finally {
      await rm(temporaryState, { recursive: true, force: true });
    }
  }, 60_000);
});
