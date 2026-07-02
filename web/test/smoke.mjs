/**
 * smoke.mjs — /ingest → audio init/part/complete/abort のE2Eスモーク
 *
 * ローカルの wrangler dev(miniflare の D1/R2)相手に一連の取り込みフローを検証する。
 *
 * 実行手順:
 *   cd web
 *   npx wrangler d1 execute vc-record --local --file=schema.sql
 *   npx wrangler dev --port 8788 --var INGEST_SECRET:smoke-test-secret
 *   node test/smoke.mjs
 *
 * 検証項目:
 *  1. meta先行 /ingest → 200
 *  2. init → part×2 (5MiB + 端数) → complete → 200, tracks.r2_key 更新
 *  3. complete 再送(レスポンス喪失リトライ想定) → 200 + alreadyCompleted
 *  4. 不正 userId (パス脱出) → 400
 *  5. 不正 JSON → 400
 *  6. 未知セッション init → 404
 *  7. abort の冪等性 (完了済み uploadId の abort → 200)
 *  8. 不正 uploadId の part → 4xx (500でない)
 *  9. 認証なし → 401
 * 10. 不正 guildId の meta → 400
 * 11. 不正な parts 要素の complete → 400
 */
const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8788';
const SECRET = process.env.SMOKE_INGEST_SECRET || 'smoke-test-secret';
const AUTH = { Authorization: `Bearer ${SECRET}` };
const SID = 'smoketest-session-1';
const UID = '123456789012345678';

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
  if (!cond) failed++;
};

const metaForm = (meta) => {
  const form = new FormData();
  form.set('meta', JSON.stringify(meta));
  form.set('transcript_md', new Blob(['# smoke'], { type: 'text/markdown' }), 'transcript.md');
  form.set('transcript_json', new Blob(['{}'], { type: 'application/json' }), 'transcript.json');
  return form;
};

// 1. meta 先行
let res = await fetch(`${BASE}/ingest`, {
  method: 'POST', headers: AUTH,
  body: metaForm({
    sessionId: SID, guildId: '999888777666555444', channelId: '111222333444555666',
    channelName: 'smoke-vc', startedAt: 1751500000000, endedAt: 1751503600000,
    speakers: [{ userId: UID, durationSec: 12.3 }],
    participants: [{ userId: UID, displayName: 'smoke', joinedAt: 1751500000000, leftAt: null }],
  }),
});
check('ingest meta 200', res.status === 200, `status=${res.status} ${await res.clone().text()}`);

// 2. init → part×2 → complete
res = await fetch(`${BASE}/ingest/audio/init`, {
  method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: SID, userId: UID }),
});
check('audio init 200', res.status === 200);
const { uploadId, key } = await res.json();
check('init returns uploadId', Boolean(uploadId));

const part1 = new Uint8Array(5 * 1024 * 1024).fill(1); // 5MiB (R2最小パート)
const part2 = new Uint8Array(1024).fill(2);            // 端数
const parts = [];
for (const [i, buf] of [part1, part2].entries()) {
  const q = new URLSearchParams({ sessionId: SID, userId: UID, uploadId, partNumber: String(i + 1) });
  res = await fetch(`${BASE}/ingest/audio/part?${q}`, {
    method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/octet-stream' }, body: buf,
  });
  check(`audio part ${i + 1} 200`, res.status === 200, `status=${res.status} ${await res.clone().text()}`);
  parts.push(await res.json());
}

const completeBody = JSON.stringify({ sessionId: SID, userId: UID, uploadId, parts, durationSec: 12.3 });
res = await fetch(`${BASE}/ingest/audio/complete`, {
  method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: completeBody,
});
const c1 = await res.json().catch(() => ({}));
check('audio complete 200', res.status === 200, JSON.stringify(c1));
check('complete returns key', c1.key === key);

// 3. complete 再送 → 冪等
res = await fetch(`${BASE}/ingest/audio/complete`, {
  method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: completeBody,
});
const c2 = await res.json().catch(() => ({}));
check('complete retry 200 (idempotent)', res.status === 200 && c2.alreadyCompleted === true, JSON.stringify(c2));

// 4. パス脱出 userId → 400
res = await fetch(`${BASE}/ingest/audio/init`, {
  method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: SID, userId: '../escape' }),
});
check('init invalid userId 400', res.status === 400, `status=${res.status}`);

// 5. 不正 JSON → 400
res = await fetch(`${BASE}/ingest/audio/init`, {
  method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: '{not json',
});
check('init malformed json 400', res.status === 400, `status=${res.status}`);

// 6. 未知セッション → 404
res = await fetch(`${BASE}/ingest/audio/init`, {
  method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: 'no-such-session', userId: UID }),
});
check('init unknown session 404', res.status === 404, `status=${res.status}`);

// 7. 完了済み uploadId の abort → 200 (冪等)
res = await fetch(`${BASE}/ingest/audio/abort`, {
  method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: SID, userId: UID, uploadId }),
});
check('abort after complete 200 (idempotent)', res.status === 200, `status=${res.status}`);

// 8. 不正 uploadId の part → 4xx
const q = new URLSearchParams({ sessionId: SID, userId: UID, uploadId: 'bogus-upload-id', partNumber: '1' });
res = await fetch(`${BASE}/ingest/audio/part?${q}`, {
  method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(16),
});
check('part with bogus uploadId is 4xx', res.status >= 400 && res.status < 500, `status=${res.status}`);

// 9. 認証なし → 401
res = await fetch(`${BASE}/ingest/audio/init`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: SID, userId: UID }),
});
check('init without auth 401', res.status === 401, `status=${res.status}`);

// 10. 不正 guildId の meta → 400
res = await fetch(`${BASE}/ingest`, {
  method: 'POST', headers: AUTH,
  body: metaForm({ sessionId: 'smoketest-bad-guild', guildId: 'evil/../path', channelId: '1', speakers: [] }),
});
check('ingest invalid guildId 400', res.status === 400, `status=${res.status}`);

// 11. 不正な parts 要素の complete → 400
res = await fetch(`${BASE}/ingest/audio/complete`, {
  method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: SID, userId: UID, uploadId: 'whatever', parts: [{ partNumber: 'x', etag: 1 }] }),
});
check('complete invalid parts 400', res.status === 400, `status=${res.status}`);

console.log(failed ? `\n${failed} FAILED` : '\nALL SMOKE TESTS PASSED');
process.exit(failed ? 1 : 0);
