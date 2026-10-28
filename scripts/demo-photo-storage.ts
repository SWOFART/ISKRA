import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { demoSeedPhotoObjectKeys, type DemoPhotoFixture } from '../src/worker/services/demo-seeds';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const wranglerCli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const workerConfig = fileURLToPath(new URL('./wrangler.demo-seed.jsonc', import.meta.url));
const localR2State = fileURLToPath(new URL('../.wrangler/state', import.meta.url));

function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a loopback port for local demo photo storage.'));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function sanitizedWranglerEnvironment(): NodeJS.ProcessEnv {
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

async function waitForLocalWorker(
  child: ReturnType<typeof spawn>,
  origin: string,
  token: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('The local demo photo Worker stopped before becoming ready.');
    }
    try {
      const ready = await fetch(`${origin}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(500),
      });
      if (ready.status === 204) return;
    } catch {
      // Wrangler needs a short start-up window for its local workerd process.
    }
    await delay(100);
  }
  throw new Error('The local demo photo Worker did not become ready.');
}

async function stopLocalWorker(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit').then(() => true).catch(() => true);
  child.kill();
  if (!await Promise.race([exited, delay(3_000).then(() => false)])) child.kill('SIGKILL');
}

/** Store only the fixed, hash-addressed demo fixtures in the isolated local bucket. */
export async function ensureLocalDemoPhotoObjects(
  photoBytes: Uint8Array,
  photo: DemoPhotoFixture,
): Promise<number> {
  const actualSha256 = createHash('sha256').update(photoBytes).digest('hex');
  if (photoBytes.byteLength !== photo.byteSize || actualSha256 !== photo.sha256) {
    throw new Error('The controlled demo photo bytes do not match their fixture metadata.');
  }

  const token = randomBytes(32).toString('hex');
  const port = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [
    wranglerCli,
    'dev',
    '--config', workerConfig,
    '--local',
    '--ip', '127.0.0.1',
    '--port', String(port),
    '--persist-to', localR2State,
    '--var', `DEMO_SEED_TOKEN:${token}`,
  ], {
    cwd: repositoryRoot,
    env: sanitizedWranglerEnvironment(),
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => undefined);

  try {
    await waitForLocalWorker(child, origin, token);
    const keys = Object.values(demoSeedPhotoObjectKeys(photo.sha256));
    for (const key of keys) {
      const result = await fetch(`${origin}/photos?${new URLSearchParams({ key })}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
        body: Buffer.from(photoBytes),
        signal: AbortSignal.timeout(10_000),
      });
      const receipt = await result.json().catch(() => null) as {
        outcome?: unknown;
        byteSize?: unknown;
        sha256?: unknown;
      } | null;
      if (![200, 201].includes(result.status) || !receipt
        || !['created', 'already-present'].includes(String(receipt.outcome))
        || receipt.byteSize !== photo.byteSize || receipt.sha256 !== photo.sha256) {
        throw new Error('A controlled demo photo could not be created atomically and verified in local R2.');
      }
    }
    return keys.length;
  } finally {
    await stopLocalWorker(child);
  }
}
