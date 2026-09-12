/**
 * pipeline の PCM 掃除の統合テスト。
 *
 * アップロード成功時だけ中間物の PCM を消し、失敗時は残すことを確認する。
 * PCM を消せるのはアップロード後に参照されないからで、失敗時に消すと
 * reupload.js での復旧手段まで失う(wav を作り直せない)。その境界を守る。
 *
 * upload.js をモックせず、スタブ HTTP サーバを立てて実際の /ingest 経路を通す。
 * ffmpeg が必要(wav 化・切り出しが実行される)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { makeSession, BYTES_PER_SEC } from './helpers.mts';

process.env.STT_PROVIDER = 'local'; // STT は失敗してよい(掃除の検証が目的)

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/**
 * /ingest 一式に応答するスタブサーバ。
 * fail=true なら最初の /ingest で 500 を返し、アップロード失敗を再現する。
 */
async function startStubServer({ fail = false } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    req.resume(); // ボディは読み捨てる
    req.on('end', () => {
      if (fail) {
        res.writeHead(500).end('stub failure');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (url.pathname === '/ingest/audio/init') {
        res.end(JSON.stringify({ uploadId: 'stub-upload' }));
      } else if (url.pathname === '/ingest/audio/part') {
        res.end(JSON.stringify({ partNumber: Number(url.searchParams.get('partNumber')), etag: 'e' }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

const oneUser = [
  {
    userId: '111',
    displayName: 'Alice',
    pcmSeconds: 1,
    utterances: [{ startMs: 0, endMs: 1000, byteStart: 0, byteEnd: BYTES_PER_SEC }],
  },
];

/** WEB_BASE_URL を差し替えて pipeline を動かす(元の環境変数は必ず戻す)。 */
async function withStub<T>({ fail }: { fail: boolean }, fn: (run: typeof import('../src/pipeline.ts').process) => Promise<T>) {
  const stub = await startStubServer({ fail });
  const prev = { base: process.env.WEB_BASE_URL, secret: process.env.INGEST_SECRET };
  process.env.WEB_BASE_URL = stub.base;
  process.env.INGEST_SECRET = 'stub-secret';
  try {
    const { process: runPipeline } = await import('../src/pipeline.ts');
    return await fn(runPipeline);
  } finally {
    prev.base == null ? delete process.env.WEB_BASE_URL : (process.env.WEB_BASE_URL = prev.base);
    prev.secret == null ? delete process.env.INGEST_SECRET : (process.env.INGEST_SECRET = prev.secret);
    await stub.close();
  }
}

test('アップロード成功時は pcm を削除し、wav と transcript は残す', async (t) => {
  const { summary, tracks, cleanup } = await makeSession(oneUser);
  t.after(cleanup);

  const { files, upload } = await withStub({ fail: false }, (run) => run(summary, tracks));
  assert.equal(upload.uploaded, true);

  assert.equal(await exists(tracks[0].pcmPath), false, 'pcm should be deleted');
  assert.equal(await exists(files.wavPaths[0]), true, 'wav must survive');
  assert.equal(await exists(files.jsonPath), true, 'transcript must survive');
});

test('アップロード失敗時は pcm を残す(reupload.js での復旧手段を壊さない)', async (t) => {
  const { summary, tracks, cleanup } = await makeSession(oneUser);
  t.after(cleanup);

  const { upload } = await withStub({ fail: true }, (run) => run(summary, tracks));
  assert.equal(upload.uploaded, false);
  assert.equal(await exists(tracks[0].pcmPath), true, 'pcm must survive for recovery');
});
