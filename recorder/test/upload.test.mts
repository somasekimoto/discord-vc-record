import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { uploadToWeb } from '../src/upload.ts';
import type { Minutes, UploadFiles } from '../src/types.ts';

async function fixture(statuses: Record<string, number[]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'upload-test-'));
  const minutes: Minutes = {
    sessionId: 'legacy-session', guildId: 'guild', channelId: 'channel',
    startedAt: 1000, endedAt: 3000, language: 'ja', engine: 'local', participants: [],
    speakers: [{ userId: '111', displayName: 'Alice', durationSec: 1, text: '旧録音', engine: 'local' }],
  };
  const files: UploadFiles = {
    mdPath: join(dir, 'transcript.md'), jsonPath: join(dir, 'transcript.json'),
    wavPaths: [join(dir, '111.wav')], mixedPath: join(dir, 'mixed.m4a'),
  };
  await writeFile(files.mdPath, '# 旧録音');
  await writeFile(files.jsonPath, JSON.stringify(minutes));
  await writeFile(files.wavPaths[0], Buffer.from([1, 2, 3, 4]));
  await writeFile(files.mixedPath!, Buffer.from([5, 6]));
  const requests: { path: string; userId: string | null; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ path: url.pathname, userId: url.searchParams.get('userId'), body });
      const status = statuses[url.pathname]?.shift() ?? 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      if (status !== 200) return res.end('stub failure');
      if (url.pathname.endsWith('/init')) return res.end(JSON.stringify({ uploadId: 'saved-upload' }));
      if (url.pathname.endsWith('/part')) return res.end(JSON.stringify({ partNumber: Number(url.searchParams.get('partNumber')), etag: 'saved-etag' }));
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const prev = { base: process.env.WEB_BASE_URL, secret: process.env.INGEST_SECRET };
  process.env.WEB_BASE_URL = base;
  process.env.INGEST_SECRET = 'local-test-secret';
  return {
    dir, minutes, files, requests, base,
    async close() {
      prev.base == null ? delete process.env.WEB_BASE_URL : process.env.WEB_BASE_URL = prev.base;
      prev.secret == null ? delete process.env.INGEST_SECRET : process.env.INGEST_SECRET = prev.secret;
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

for (const status of [408, 429, 500]) {
  test(`upload: ${status} は再送し complete の500応答も再送する`, async (t) => {
    const f = await fixture({ '/ingest': [status], '/ingest/audio/complete': [500] });
    t.after(() => f.close());
    const result = await uploadToWeb(f.minutes, f.files);
    assert.equal(result.uploaded, true);
    assert.equal(f.requests.filter((r) => r.path === '/ingest').length, 2);
    assert.equal(f.requests.filter((r) => r.path.endsWith('/complete')).length, 3);
    assert.equal(f.requests.filter((r) => r.path.endsWith('/abort')).length, 0);
    const metaRequest = f.requests.find((r) => r.path === '/ingest');
    assert.ok(metaRequest);
    assert.match(metaRequest.body.toString(), /"startedBy":null/);
    assert.doesNotMatch(metaRequest.body.toString(), /startedByUserId/);
    const complete = f.requests.find((r) => r.path.endsWith('/complete'));
    assert.ok(complete);
    assert.deepEqual(JSON.parse(complete.body.toString()), {
      sessionId: 'legacy-session', userId: '111', uploadId: 'saved-upload',
      parts: [{ partNumber: 1, etag: 'saved-etag' }], durationSec: 1,
    });
  });
}

test('upload: 400 の音声は再送せず abort、次の mixed は続行し viewUrl を保持する', async (t) => {
  const f = await fixture({ '/ingest/audio/part': [400] });
  t.after(() => f.close());
  const result = await uploadToWeb(f.minutes, f.files);
  assert.equal(result.uploaded, false);
  assert.equal(result.viewUrl, `${f.base}/s/legacy-session`);
  assert.match(String(result.reason), /111: audio part 400/);
  const parts = f.requests.filter((r) => r.path.endsWith('/part'));
  assert.deepEqual(parts.map((r) => r.userId), ['111', 'mixed']);
  const abort = f.requests.filter((r) => r.path.endsWith('/abort'));
  assert.equal(abort.length, 1);
  assert.deepEqual(JSON.parse(abort[0].body.toString()), { sessionId: 'legacy-session', userId: '111', uploadId: 'saved-upload' });
  assert.equal(f.requests.filter((r) => r.path.endsWith('/complete')).length, 1);
});

test('upload: plain object の文字列 status は408でも再送しない（旧 strict 比較を保持）', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw { status: '408', message: 'plain mock timeout' };
  });
  const result = await uploadToWeb(f.minutes, f.files);
  assert.equal(result.uploaded, false);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.match(String(result.reason), /plain mock timeout/);
});

test('upload: 未設定ならファイルを読まずスキップする', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  delete process.env.WEB_BASE_URL;
  await rm(f.files.mdPath);
  const result = await uploadToWeb(f.minutes, f.files);
  assert.equal(result.uploaded, false);
  assert.equal(f.requests.length, 0);
});

test('reupload: utterances のない旧保存 JSON と既存音声から復旧する', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const sessionDir = join(f.dir, f.minutes.sessionId);
  await mkdir(sessionDir);
  await writeFile(join(sessionDir, 'transcript.json'), JSON.stringify(f.minutes));
  await writeFile(join(sessionDir, 'transcript.md'), '# 旧録音');
  await writeFile(join(sessionDir, '111.wav'), Buffer.from([1, 2, 3, 4]));
  // mixed.m4a が無い旧保存データも復旧できる。
  const { stdout } = await promisify(execFile)(process.execPath, ['src/reupload.ts', f.minutes.sessionId], {
    env: { ...process.env, RECORDINGS_DIR: f.dir },
  });
  assert.match(stdout, /"uploaded": true/);
  assert.equal(f.requests.filter((r) => r.path.endsWith('/part')).length, 1);
  const meta = f.requests.find((r) => r.path === '/ingest');
  assert.ok(meta);
  assert.match(meta.body.toString(), /旧録音/);
  assert.doesNotMatch(meta.body.toString(), /"utterances"/);
});
