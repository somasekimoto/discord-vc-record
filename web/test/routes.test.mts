import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { readObject, readUpload } from './http.mts';

let base: string;
const auth = { Authorization: 'Bearer smoke-test-secret' };
let server: ChildProcessByStdio<null, Readable, Readable> | undefined;
let stateDirectory: string | undefined;
let logs = '';
let cookie: string;
const runId = randomUUID();
before(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'vc-web-test-'));
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
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  execFileSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'vc-record',
    '--config', 'wrangler.ci.toml', '--local', '--file=schema.sql', '--persist-to', stateDirectory,
  ], { env });
  server = spawn(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'dev', 'test/worker.ts', '--config', 'wrangler.ci.toml',
    '--port', String(port), '--inspector-port', '0', '--persist-to', stateDirectory,
    '--var', 'INGEST_SECRET:smoke-test-secret', '--var', 'SESSION_SECRET:local-session-test',
    '--var', 'DISCORD_CLIENT_ID:123', '--var', 'DISCORD_CLIENT_SECRET:dummy', '--var', `TEST_RUN_ID:${runId}`,
  ], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (data: Buffer) => { logs += String(data); });
  server.stderr.on('data', (data: Buffer) => { logs += String(data); });
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(logs);
    try {
      const response = await fetch(`${base}/__test/identity`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await readObject(response)).runId === runId) {
        const cookieResponse = await fetch(`${base}/__test/cookie`);
        assert.equal(cookieResponse.status, 200);
        cookie = await cookieResponse.text();
        return;
      }
    } catch {}
    await setTimeout(250);
  }
  throw new Error(`Worker not ready: ${logs}`);
});
after(async () => {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    process.kill(-server.pid, 'SIGTERM');
    await exited;
  }
  // 自分で作った一時ディレクトリだけを削除。既存 .wrangler/state には触れない。
  if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
});
const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
const seed = (guild: string, role = '7001') => request(`/__test/seed?guild=${guild}&role=${role}`);
const access = async (query: string) => readObject(await request(`/__test/authz?${query}`));

// 認証もworkerd内の本物のRequest/Cryptoで検証する。Node globalsと混ぜない。
test('署名、有効期限、改ざん、Cookie を維持する', async () => {
  const payload = { userId: '1', username: 'テスト', accessToken: 'dummy-token', exp: 4000000000 };
  const token = await (await request('/__test/sign')).text();
  const verify = async (value: string, secret = ''): Promise<unknown> => (await request(`/__test/verify?${new URLSearchParams({ token: value, secret })}`)).json();
  assert.deepEqual(await verify(token), payload);
  assert.equal(await verify(token + 'x'), null);
  assert.equal(await verify(token, 'wrong'), null);
  assert.equal(await verify('bad'), null);
  assert.equal(await (await request('/__test/verify')).json(), null);
  assert.equal(await verify(await (await request('/__test/sign?exp=1')).text()), null);
  assert.deepEqual(await verify(await (await request('/__test/sign?exp=0')).text()), { ...payload, exp: 0 });
  assert.deepEqual(await readObject(await request('/__test/session', { headers: { Cookie: `vcr_session=${encodeURIComponent(token)}` } })), payload);
  assert.equal(await (await request('/__test/session')).json(), null);
});

test('login scope/state、logout、callback missing code を維持する', async () => {
  const response = await request('/login?next=/g/1', { redirect: 'manual' });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('Location')!);
  assert.equal(location.searchParams.get('scope'), 'identify guilds guilds.members.read');
  assert.equal(location.searchParams.get('state'), '/g/1');
  assert.equal(location.searchParams.get('redirect_uri'), 'http://127.0.0.1:8788/callback');
  assert.equal((await request('/callback')).status, 400);
  assert.match((await request('/logout', { redirect: 'manual' })).headers.get('Set-Cookie')!, /Max-Age=0/);
});

test('OAuth 成功と上流エラー、cookie属性を維持する', async () => {
  await request('/__test/mode?mode=success');
  const response = await request('/callback?code=code&state=/g/1', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/g/1');
  assert.match(response.headers.get('Set-Cookie')!, /HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=28800/);
  const session = await readObject(await request('/__test/session', { headers: { Cookie: response.headers.get('Set-Cookie')!.split(';')[0] } }));
  assert.equal(session.userId, '1');
  assert.equal(session.username, 'テスト');
  assert.equal(session.accessToken, 'dummy-token');
  for (const mode of ['token-error', 'user-error']) {
    await request(`/__test/mode?mode=${mode}`);
    assert.equal((await request('/callback?code=bad')).status, 502);
  }
  await request('/__test/mode?mode=success');
});

test('認可: 未ログイン、未設定、member/role 不一致、401/404/429 とキャッシュ', async () => {
  assert.equal((await access('anonymous')).reason, 'not_logged_in');
  await seed('9100', '');
  assert.equal((await access('guild=9100')).reason, 'no_role_configured');
  for (const [guild, token, reason] of [['9101', 'denied', 'missing_role'], ['9102', 'status-401', 'token_expired'], ['9103', 'status-404', 'not_a_member'], ['9104', 'status-429', 'rate_limited'], ['9105', 'status-503', 'discord_error_503']]) {
    await seed(guild);
    assert.equal((await access(`guild=${guild}&token=${token}`)).reason, reason);
  }
  await seed('9106');
  const allowed = await access('guild=9106');
  assert.equal(allowed.allowed, true);
  await seed('9106', 'changed-role');
  const cached = await access('guild=9106&token=denied');
  assert.equal(cached.allowed, true);
  assert.equal(cached.discordCalls, allowed.discordCalls); // 現仕様: role/token が変わっても user:guild キャッシュ
  const limited = await access('guild=9104&token=status-429');
  const retried = await access('guild=9104&token=allowed');
  assert.equal(retried.allowed, true);
  assert.equal(typeof limited.discordCalls, 'number');
  assert.equal(retried.discordCalls, Number(limited.discordCalls) + 1); // 429 はキャッシュしない
  const denied = await access('guild=9101&token=allowed');
  assert.equal(denied.reason, 'missing_role'); // 拒否結果もキャッシュする
  await request('/__test/clock?offset=300001');
  try {
    assert.equal((await access('guild=9101&token=allowed')).allowed, true);
    assert.equal((await access('guild=9106&token=allowed')).reason, 'missing_role');
  } finally {
    await request('/__test/clock?offset=0');
  }
});

test('config と匿名/不明ルートのHTTP契約', async () => {
  assert.equal((await request('/config', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await request('/config', { method: 'POST', headers: auth, body: '{}' })).status, 400);
  assert.equal((await request('/config', { method: 'POST', headers: auth, body: '{bad' })).status, 500);
  assert.equal((await request('/unknown')).status, 404);
  assert.equal((await request('/s/no-such-session')).status, 404);
  const denied = await request('/g/9001');
  assert.equal(denied.status, 200); // 拒否ページも既存は200
  assert.match(await denied.text(), /ログインが必要/);
  assert.match(await (await request('/')).text(), /Discordでログイン/);
});

test('実D1/R2: 一覧、詳細、mixed/話者/文字起こしDL、再ingestでキー保持', async () => {
  const form = () => {
    const value = new FormData();
    value.set('meta', JSON.stringify({ sessionId: 'route-fixture', guildId: '9001', channelId: '8001', channelName: '<VC>', startedAt: 1751500000000, participants: [{ userId: '123', displayName: '<Speaker>' }], speakers: [{ userId: '123', durationSec: 2 }] }));
    value.set('transcript_md', new Blob(['# <transcript>']), 'transcript.md');
    value.set('transcript_json', new Blob(['{"test":true}']), 'transcript.json');
    return value;
  };
  assert.equal((await request('/config', { method: 'POST', headers: auth, body: JSON.stringify({ guildId: '9001', requiredRoleId: '7001' }) })).status, 200);
  assert.equal((await request('/ingest', { method: 'POST', headers: auth, body: form() })).status, 200);
  for (const userId of ['mixed', '123']) {
    const init = await readUpload(await request('/ingest/audio/init', { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'route-fixture', userId }) }));
    const part = await readObject(await request(`/ingest/audio/part?${new URLSearchParams({ sessionId: 'route-fixture', userId, uploadId: init.uploadId, partNumber: '1' })}`, { method: 'PUT', headers: auth, body: new Uint8Array([1, 2, 3]) }));
    assert.equal((await request('/ingest/audio/complete', { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'route-fixture', userId, uploadId: init.uploadId, parts: [part] }) })).status, 200);
  }
  const beforeReingest = await readObject(await request('/__test/tracks'));
  assert.deepEqual(beforeReingest.tracks, [
    { user_id: '123', r2_key: 'sessions/9001/route-fixture/audio/123.wav', duration_sec: 2 },
    { user_id: 'mixed', r2_key: 'sessions/9001/route-fixture/audio/mixed.m4a', duration_sec: null },
  ]);
  assert.equal((await request('/ingest', { method: 'POST', headers: auth, body: form() })).status, 200);
  assert.deepEqual(await readObject(await request('/__test/tracks')), beforeReingest);
  const headers = { Cookie: cookie };
  assert.match(await (await request('/', { headers })).text(), /&lt;Guild&gt;/);
  assert.match(await (await request('/g/9001', { headers })).text(), /&lt;VC&gt;/);
  assert.match(await (await request('/g/9001/c/8001', { headers })).text(), /route-fixture/);
  const detail = await (await request('/s/route-fixture', { headers })).text();
  assert.match(detail, /<audio controls/);
  assert.match(detail, /&lt;Speaker&gt;/);
  assert.match(detail, /# &lt;transcript&gt;/);
  for (const [kind, contentType, disposition] of [['audio-mixed', 'audio/mp4', 'inline'], ['audio-123', 'audio/wav', 'attachment'], ['md', 'text/markdown; charset=utf-8', 'attachment'], ['json', 'application/json', 'attachment']]) {
    const response = await request(`/s/route-fixture/dl/${kind}`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), contentType);
    assert.match(response.headers.get('Content-Disposition')!, new RegExp(`^${disposition};`));
    if (kind.startsWith('audio-')) assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
    else assert.equal(await response.text(), kind === 'md' ? '# <transcript>' : '{"test":true}');
  }
  assert.equal((await request('/s/route-fixture/dl/bad', { headers })).status, 400);
  assert.equal((await request('/s/route-fixture/dl/audio-999', { headers })).status, 404);
});

test('未検証の既存入力受理範囲とnullableなD1/R2表示を維持する', async () => {
  // config はstring限定ではなく、従来のtruthy判定とD1の数値→TEXTを維持。
  assert.equal((await request('/config', { method: 'POST', headers: auth, body: JSON.stringify({ guildId: 9010, requiredRoleId: 7001 }) })).status, 200);
  assert.equal((await request('/config', { method: 'POST', headers: auth, body: JSON.stringify({ guildId: '9002', requiredRoleId: '7001' }) })).status, 200);
  const form = new FormData();
  form.set('meta', JSON.stringify({ sessionId: 'nullable-fixture', guildId: '9002', channelId: '8002' }));
  form.set('transcript_md', new Blob(['temporary']), 'transcript.md');
  assert.equal((await request('/ingest', { method: 'POST', headers: auth, body: form })).status, 200);
  const headers = { Cookie: cookie };
  assert.equal((await request('/__test/remove-files')).status, 200);
  const missingObject = await request('/s/nullable-fixture/dl/md', { headers });
  assert.equal(missingObject.status, 404);
  assert.equal(await missingObject.text(), 'not found in storage');
  assert.match(await (await request('/s/nullable-fixture', { headers })).text(), /文字起こしがありません/);
  form.delete('transcript_md');
  assert.equal((await request('/ingest', { method: 'POST', headers: auth, body: form })).status, 200);
  const missingKey = await request('/s/nullable-fixture/dl/md', { headers });
  assert.equal(missingKey.status, 404);
  assert.equal(await missingKey.text(), 'not available');
  const detail = await (await request('/s/nullable-fixture', { headers })).text();
  assert.match(detail, /<h1>- の録音/);
  assert.doesNotMatch(detail, /<audio controls/);
  assert.match(await (await request('/g/9002/c/8003', { headers })).text(), /まだありません/);
});
