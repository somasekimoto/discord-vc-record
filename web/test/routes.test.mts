import { afterAll, beforeAll, expect, test } from 'vitest';

import { readObject, readUpload } from './http.mts';
import { INGEST_SECRET, startWorker } from './worker-process.mts';
import type { WorkerProcess } from './worker-process.mts';

let base: string;
const auth = { Authorization: `Bearer ${INGEST_SECRET}` };
let worker: WorkerProcess | undefined;
let cookie: string;
beforeAll(async () => {
  worker = await startWorker();
  base = worker.base;
  const cookieResponse = await fetch(`${base}/__test/cookie`);
  expect(cookieResponse.status).toBe(200);
  cookie = await cookieResponse.text();
});
afterAll(async () => {
  await worker?.stop();
});
const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
const seed = (guild: string, role = '7001') => request(`/__test/seed?guild=${guild}&role=${role}`);
const access = async (query: string) => readObject(await request(`/__test/authz?${query}`));

// 認証もworkerd内の本物のRequest/Cryptoで検証する。Node globalsと混ぜない。
test('署名、有効期限、改ざん、Cookie を維持する', async () => {
  const payload = { userId: '1', username: 'テスト', accessToken: 'dummy-token', exp: 4000000000 };
  const token = await (await request('/__test/sign')).text();
  const verify = async (value: string, secret = ''): Promise<unknown> => (await request(`/__test/verify?${new URLSearchParams({ token: value, secret })}`)).json();
  expect(await verify(token)).toStrictEqual(payload);
  expect(await verify(token + 'x')).toBe(null);
  expect(await verify(token, 'wrong')).toBe(null);
  expect(await verify('bad')).toBe(null);
  expect(await (await request('/__test/verify')).json()).toBe(null);
  expect(await verify(await (await request('/__test/sign?exp=1')).text())).toBe(null);
  expect(await verify(await (await request('/__test/sign?exp=0')).text())).toStrictEqual({ ...payload, exp: 0 });
  expect(await readObject(await request('/__test/session', { headers: { Cookie: `vcr_session=${encodeURIComponent(token)}` } }))).toStrictEqual(payload);
  expect(await (await request('/__test/session')).json()).toBe(null);
});

test('login scope/state、logout、callback missing code を維持する', async () => {
  const response = await request('/login?next=/g/1', { redirect: 'manual' });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('Location')!);
  expect(location.searchParams.get('scope')).toBe('identify guilds guilds.members.read');
  expect(location.searchParams.get('state')).toBe('/g/1');
  expect(location.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8788/callback');
  expect((await request('/callback')).status).toBe(400);
  expect((await request('/logout', { redirect: 'manual' })).headers.get('Set-Cookie')!).toMatch(/Max-Age=0/);
});

test('OAuth 成功と上流エラー、cookie属性を維持する', async () => {
  await request('/__test/mode?mode=success');
  const response = await request('/callback?code=code&state=/g/1', { redirect: 'manual' });
  expect(response.status).toBe(302);
  expect(response.headers.get('Location')).toBe('/g/1');
  expect(response.headers.get('Set-Cookie')!).toMatch(/HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=28800/);
  const session = await readObject(await request('/__test/session', { headers: { Cookie: response.headers.get('Set-Cookie')!.split(';')[0] } }));
  expect(session.userId).toBe('1');
  expect(session.username).toBe('テスト');
  expect(session.accessToken).toBe('dummy-token');
  for (const mode of ['token-error', 'user-error']) {
    await request(`/__test/mode?mode=${mode}`);
    expect((await request('/callback?code=bad')).status).toBe(502);
  }
  await request('/__test/mode?mode=success');
});

test('認可: 未ログイン、未設定、member/role 不一致、401/404/429 とキャッシュ', async () => {
  expect((await access('anonymous')).reason).toBe('not_logged_in');
  await seed('9100', '');
  expect((await access('guild=9100')).reason).toBe('no_role_configured');
  for (const [guild, token, reason] of [['9101', 'denied', 'missing_role'], ['9102', 'status-401', 'token_expired'], ['9103', 'status-404', 'not_a_member'], ['9104', 'status-429', 'rate_limited'], ['9105', 'status-503', 'discord_error_503']]) {
    await seed(guild);
    expect((await access(`guild=${guild}&token=${token}`)).reason).toBe(reason);
  }
  await seed('9106');
  const allowed = await access('guild=9106');
  expect(allowed.allowed).toBe(true);
  await seed('9106', 'changed-role');
  const cached = await access('guild=9106&token=denied');
  expect(cached.allowed).toBe(true);
  expect(cached.discordCalls).toBe(allowed.discordCalls); // 現仕様: role/token が変わっても user:guild キャッシュ
  const limited = await access('guild=9104&token=status-429');
  const retried = await access('guild=9104&token=allowed');
  expect(retried.allowed).toBe(true);
  expect(typeof limited.discordCalls).toBe('number');
  expect(retried.discordCalls).toBe(Number(limited.discordCalls) + 1); // 429 はキャッシュしない
  const denied = await access('guild=9101&token=allowed');
  expect(denied.reason).toBe('missing_role'); // 拒否結果もキャッシュする
  await request('/__test/clock?offset=300001');
  try {
    expect((await access('guild=9101&token=allowed')).allowed).toBe(true);
    expect((await access('guild=9106&token=allowed')).reason).toBe('missing_role');
  } finally {
    await request('/__test/clock?offset=0');
  }
});

test('config と匿名/不明ルートのHTTP契約', async () => {
  expect((await request('/config', { method: 'POST', body: '{}' })).status).toBe(401);
  expect((await request('/config', { method: 'POST', headers: auth, body: '{}' })).status).toBe(400);
  expect((await request('/config', { method: 'POST', headers: auth, body: '{bad' })).status).toBe(500);
  expect((await request('/unknown')).status).toBe(404);
  expect((await request('/s/no-such-session')).status).toBe(404);
  const denied = await request('/g/9001');
  expect(denied.status).toBe(200); // 拒否ページも既存は200
  expect(await denied.text()).toMatch(/ログインが必要/);
  expect(await (await request('/')).text()).toMatch(/Discordでログイン/);
});

test('実D1/R2: 一覧、詳細、mixed/話者/文字起こしDL、再ingestでキー保持', async () => {
  const form = () => {
    const value = new FormData();
    value.set('meta', JSON.stringify({ sessionId: 'route-fixture', guildId: '9001', channelId: '8001', channelName: '<VC>', startedAt: 1751500000000, participants: [{ userId: '123', displayName: '<Speaker>' }], speakers: [{ userId: '123', durationSec: 2 }] }));
    value.set('transcript_md', new Blob(['# <transcript>']), 'transcript.md');
    value.set('transcript_json', new Blob(['{"test":true}']), 'transcript.json');
    return value;
  };
  expect((await request('/config', { method: 'POST', headers: auth, body: JSON.stringify({ guildId: '9001', requiredRoleId: '7001' }) })).status).toBe(200);
  expect((await request('/ingest', { method: 'POST', headers: auth, body: form() })).status).toBe(200);
  for (const userId of ['mixed', '123']) {
    const init = await readUpload(await request('/ingest/audio/init', { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'route-fixture', userId }) }));
    const part = await readObject(await request(`/ingest/audio/part?${new URLSearchParams({ sessionId: 'route-fixture', userId, uploadId: init.uploadId, partNumber: '1' })}`, { method: 'PUT', headers: auth, body: new Uint8Array([1, 2, 3]) }));
    expect((await request('/ingest/audio/complete', { method: 'POST', headers: auth, body: JSON.stringify({ sessionId: 'route-fixture', userId, uploadId: init.uploadId, parts: [part] }) })).status).toBe(200);
  }
  const beforeReingest = await readObject(await request('/__test/tracks'));
  expect(beforeReingest.tracks).toStrictEqual([
    { user_id: '123', r2_key: 'sessions/9001/route-fixture/audio/123.wav', duration_sec: 2 },
    { user_id: 'mixed', r2_key: 'sessions/9001/route-fixture/audio/mixed.m4a', duration_sec: null },
  ]);
  expect((await request('/ingest', { method: 'POST', headers: auth, body: form() })).status).toBe(200);
  expect(await readObject(await request('/__test/tracks'))).toStrictEqual(beforeReingest);
  const headers = { Cookie: cookie };
  expect(await (await request('/', { headers })).text()).toMatch(/&lt;Guild&gt;/);
  expect(await (await request('/g/9001', { headers })).text()).toMatch(/&lt;VC&gt;/);
  expect(await (await request('/g/9001/c/8001', { headers })).text()).toMatch(/route-fixture/);
  const detail = await (await request('/s/route-fixture', { headers })).text();
  expect(detail).toMatch(/<audio controls/);
  expect(detail).toMatch(/&lt;Speaker&gt;/);
  expect(detail).toMatch(/# &lt;transcript&gt;/);
  for (const [kind, contentType, disposition] of [['audio-mixed', 'audio/mp4', 'inline'], ['audio-123', 'audio/wav', 'attachment'], ['md', 'text/markdown; charset=utf-8', 'attachment'], ['json', 'application/json', 'attachment']]) {
    const response = await request(`/s/route-fixture/dl/${kind}`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(contentType);
    expect(response.headers.get('Content-Disposition')!).toMatch(new RegExp(`^${disposition};`));
    if (kind.startsWith('audio-')) expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(new Uint8Array([1, 2, 3]));
    else expect(await response.text()).toBe(kind === 'md' ? '# <transcript>' : '{"test":true}');
  }
  expect((await request('/s/route-fixture/dl/bad', { headers })).status).toBe(400);
  expect((await request('/s/route-fixture/dl/audio-999', { headers })).status).toBe(404);
});

test('未検証の既存入力受理範囲とnullableなD1/R2表示を維持する', async () => {
  // config はstring限定ではなく、従来のtruthy判定とD1の数値→TEXTを維持。
  expect((await request('/config', { method: 'POST', headers: auth, body: JSON.stringify({ guildId: 9010, requiredRoleId: 7001 }) })).status).toBe(200);
  expect((await request('/config', { method: 'POST', headers: auth, body: JSON.stringify({ guildId: '9002', requiredRoleId: '7001' }) })).status).toBe(200);
  const form = new FormData();
  form.set('meta', JSON.stringify({ sessionId: 'nullable-fixture', guildId: '9002', channelId: '8002' }));
  form.set('transcript_md', new Blob(['temporary']), 'transcript.md');
  expect((await request('/ingest', { method: 'POST', headers: auth, body: form })).status).toBe(200);
  const headers = { Cookie: cookie };
  expect((await request('/__test/remove-files')).status).toBe(200);
  const missingObject = await request('/s/nullable-fixture/dl/md', { headers });
  expect(missingObject.status).toBe(404);
  expect(await missingObject.text()).toBe('not found in storage');
  expect(await (await request('/s/nullable-fixture', { headers })).text()).toMatch(/文字起こしがありません/);
  form.delete('transcript_md');
  expect((await request('/ingest', { method: 'POST', headers: auth, body: form })).status).toBe(200);
  const missingKey = await request('/s/nullable-fixture/dl/md', { headers });
  expect(missingKey.status).toBe(404);
  expect(await missingKey.text()).toBe('not available');
  const detail = await (await request('/s/nullable-fixture', { headers })).text();
  expect(detail).toMatch(/<h1>- の録音/);
  expect(detail).not.toMatch(/<audio controls/);
  expect(await (await request('/g/9002/c/8003', { headers })).text()).toMatch(/まだありません/);
});
