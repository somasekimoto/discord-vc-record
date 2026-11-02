// テスト用 Wrangler(test/worker.ts) を空きポート・専用の一時保存先で起動/停止する。Node 側専用。
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readObject } from './http.mts';

export const INGEST_SECRET = 'smoke-test-secret';

export type WorkerProcess = {
  base: string;
  logs: () => string;
  stop: () => Promise<void>;
};

async function reservePort() {
  // 予約用socketを閉じてからWranglerを起動。万一の競合はrunIdで検出する。
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing local port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  return port;
}

export async function startWorker(): Promise<WorkerProcess> {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'vc-web-test-'));
  const runId = randomUUID();
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  let logs = '';
  let server: ReturnType<typeof spawn> | undefined;
  const stop = async () => {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      process.kill(-server.pid, 'SIGTERM');
      await exited;
    }
    // 自分で作った一時ディレクトリだけを削除。既存 .wrangler/state には触れない。
    await rm(stateDirectory, { recursive: true, force: true });
  };
  try {
    execFileSync(process.execPath, [
      'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'vc-record',
      '--config', 'wrangler.ci.toml', '--local', '--file=schema.sql', '--persist-to', stateDirectory,
    ], { env });
    server = spawn(process.execPath, [
      'node_modules/wrangler/bin/wrangler.js', 'dev', 'test/worker.ts', '--config', 'wrangler.ci.toml',
      '--port', String(port), '--inspector-port', '0', '--persist-to', stateDirectory,
      '--var', `INGEST_SECRET:${INGEST_SECRET}`, '--var', 'SESSION_SECRET:local-session-test',
      '--var', 'DISCORD_CLIENT_ID:123', '--var', 'DISCORD_CLIENT_SECRET:dummy', '--var', `TEST_RUN_ID:${runId}`,
    ], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout?.on('data', (data: Buffer) => { logs += String(data); });
    server.stderr?.on('data', (data: Buffer) => { logs += String(data); });
    for (let i = 0; i < 120; i++) {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(logs);
      try {
        const response = await fetch(`${base}/__test/identity`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await readObject(response)).runId === runId) {
          return { base, logs: () => logs, stop };
        }
      } catch {}
      await setTimeout(250);
    }
    throw new Error(`Worker not ready: ${logs}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
