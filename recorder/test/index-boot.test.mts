import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('index: 実エントリポイントの起動・操作配線・正常終了を通信なしで確認する', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'index-boot-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--experimental-test-module-mocks', fileURLToPath(new URL('./index-boot-child.mts', import.meta.url)),
  ], {
    cwd, timeout: 15000,
    env: { PATH: process.env.PATH, DISCORD_TOKEN: 'local-fake-token', RECORDINGS_RETENTION_DAYS: '0', AUTO_STOP_EMPTY_SEC: '60', RECORD_PROMPT_CHANNEL_IDS: 'voice' },
  });
  assert.match(stdout, /logged in as local-fake/);
  assert.match(stdout, /index-boot-verified/);
  assert.match(stdout, /shutting down/);
  assert.match(stdout, /fake-client-destroyed/);
});
