/**
 * recorder-contract.mts — 実 recorder uploader(recorder/src/upload.ts) → ローカル Worker(D1/R2) の契約テスト
 *
 * recorder と web の片側だけ API を変えると落ちるよう、両側の本物のコードを接続する。
 * 間に置く中継プロキシで応答喪失・部分失敗を注入し、retry / abort / 再送の契約を確かめる。
 * 大容量・異常入力の網羅は smoke.mts、HTTP/認可/表示は routes.test.mts の責務。
 *
 * 実行: cd web && pnpm run test:contract
 * (recorder の依存は不要。upload.ts は Node 組み込みだけを使う)
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { uploadToWeb } from '../../recorder/src/upload.ts';
import type { Minutes, UploadFiles } from '../../recorder/src/types.ts';
import { readObject } from './http.mts';
import { INGEST_SECRET, startWorker } from './worker-process.mts';
import type { WorkerProcess } from './worker-process.mts';

const GUILD = '9001';
const SPEAKER = '123456789012345678';
// recorder の PART_SIZE(40MiB) を超え、2 パートに分かれるサイズ
const BIG = 40 * 1024 * 1024 + 1024 * 1024;

type Fault = 'drop-response' | { status: number };
type Exchange = { method: string; path: string; userId: string | null; status: number; fault: boolean };
let injector: (path: string, userId: string | null) => Fault | undefined = () => undefined;
const exchanges: Exchange[] = [];

let worker: WorkerProcess | undefined;
let proxy: Server | undefined;
let proxyBase: string;
let cookie: string;
let workDir: string;
const env = { base: process.env.WEB_BASE_URL, secret: process.env.INGEST_SECRET };

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** recorder → Worker の中継。injector の指示で失敗の注入・応答の破棄を行う。 */
async function relay(target: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, 'http://proxy');
  const userId = url.searchParams.get('userId');
  const body = await readBody(req);
  // init/complete/abort の userId は JSON body にある
  let bodyUserId = userId;
  if (!bodyUserId && req.headers['content-type'] === 'application/json') {
    try { bodyUserId = (JSON.parse(body.toString()) as { userId?: string }).userId ?? null; } catch {}
  }
  const fault = injector(url.pathname, bodyUserId);
  if (fault && fault !== 'drop-response') {
    // Worker へ届けずに失敗を返す
    exchanges.push({ method: req.method!, path: url.pathname, userId: bodyUserId, status: fault.status, fault: true });
    res.writeHead(fault.status).end('injected failure');
    return;
  }
  const headers: Record<string, string> = {};
  for (const name of ['authorization', 'content-type']) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const upstream = await fetch(`${target}${url.pathname}${url.search}`, {
    method: req.method, headers, body: req.method === 'GET' ? undefined : body,
    signal: AbortSignal.timeout(60_000),
  });
  const payload = Buffer.from(await upstream.arrayBuffer());
  exchanges.push({ method: req.method!, path: url.pathname, userId: bodyUserId, status: upstream.status, fault: fault === 'drop-response' });
  if (fault === 'drop-response') {
    // Worker は処理済みだが recorder には応答が届かない(レスポンス喪失)
    res.socket?.destroy();
    return;
  }
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') ?? 'text/plain' }).end(payload);
}

beforeAll(async () => {
  worker = await startWorker();
  const target = worker.base;
  proxy = createServer((req, res) => {
    relay(target, req, res).catch((error: unknown) => {
      // Worker の停止・無応答を recorder のタイムアウト待ちにせず、原因付きの 502 で即座に返す
      const message = error instanceof Error ? error.message : String(error);
      const url = new URL(req.url!, 'http://proxy');
      exchanges.push({ method: req.method!, path: url.pathname, userId: url.searchParams.get('userId'), status: 502, fault: false });
      if (res.headersSent) return res.destroy();
      res.writeHead(502).end(`proxy upstream error: ${message}\n${worker?.logs().slice(-2000) ?? ''}`);
    });
  });
  await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy port');
  proxyBase = `http://127.0.0.1:${address.port}`;
  process.env.WEB_BASE_URL = proxyBase;
  process.env.INGEST_SECRET = INGEST_SECRET;

  // DL 確認用: role 7001 を要求し、テスト cookie(accessToken=allowed)は 7001 を持つ
  const config = await fetch(`${target}/config`, {
    method: 'POST', headers: { Authorization: `Bearer ${INGEST_SECRET}` },
    body: JSON.stringify({ guildId: GUILD, requiredRoleId: '7001' }),
  });
  expect(config.status).toBe(200);
  cookie = await (await fetch(`${target}/__test/cookie`)).text();
  workDir = await mkdtemp(join(tmpdir(), 'vc-contract-'));
});

afterAll(async () => {
  env.base == null ? delete process.env.WEB_BASE_URL : process.env.WEB_BASE_URL = env.base;
  env.secret == null ? delete process.env.INGEST_SECRET : process.env.INGEST_SECRET = env.secret;
  if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
  await worker?.stop();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

/** pipeline の保存物と同じ構成(transcript.md/json, <userId>.wav, mixed.m4a)を作る。 */
async function recording(sessionId: string, wavSize: number) {
  const dir = join(workDir, sessionId);
  await mkdir(dir);
  const minutes: Minutes = {
    sessionId, guildId: GUILD, channelId: '8001', channelName: 'contract-vc',
    startedAt: 1751500000000, endedAt: 1751500042000, startedBy: SPEAKER,
    language: 'ja', engine: 'local',
    participants: [{ userId: SPEAKER, displayName: '契約テスト話者', joinedAt: 1751500000000, leftAt: null }],
    speakers: [{ userId: SPEAKER, displayName: '契約テスト話者', durationSec: 37, text: 'こんにちは', engine: 'local' }],
  };
  const files: UploadFiles = {
    mdPath: join(dir, 'transcript.md'), jsonPath: join(dir, 'transcript.json'),
    wavPaths: [join(dir, `${SPEAKER}.wav`)], mixedPath: join(dir, 'mixed.m4a'),
  };
  const content = {
    md: Buffer.from(`# ${sessionId}\n\nこんにちは\n`),
    json: Buffer.from(JSON.stringify(minutes)),
    wav: randomBytes(wavSize),
    mixed: randomBytes(64 * 1024),
  };
  await writeFile(files.mdPath, content.md);
  await writeFile(files.jsonPath, content.json);
  await writeFile(files.wavPaths[0], content.wav);
  await writeFile(files.mixedPath!, content.mixed);
  return { minutes, files, content };
}

const download = (sessionId: string, kind: string) =>
  fetch(`${worker!.base}/s/${sessionId}/dl/${kind}`, { headers: { Cookie: cookie } });

async function tracks(sessionId: string) {
  return (await readObject(await fetch(`${worker!.base}/__test/tracks?session=${sessionId}`))).tracks;
}

async function assertDelivered(sessionId: string, content: Awaited<ReturnType<typeof recording>>['content']) {
  for (const [kind, expected] of [['md', content.md], ['json', content.json], [`audio-${SPEAKER}`, content.wav], ['audio-mixed', content.mixed]] as const) {
    const response = await download(sessionId, kind);
    expect(response.status, `${kind} DL`).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(expected), `${kind} の内容が送信元と一致する`).toBeTruthy();
  }
  expect(await tracks(sessionId)).toStrictEqual([
    { user_id: SPEAKER, r2_key: `sessions/${GUILD}/${sessionId}/audio/${SPEAKER}.wav`, duration_sec: 37 },
    // mixed の長さは recorder が endedAt - startedAt から算出する
    { user_id: 'mixed', r2_key: `sessions/${GUILD}/${sessionId}/audio/mixed.m4a`, duration_sec: 42 },
  ]);
}

function reset(fault: typeof injector = () => undefined) {
  injector = fault;
  exchanges.length = 0;
}

test('契約: 40MiB 超の話者 wav・mixed・文字起こしが分割送信され、D1/R2 から同じ内容で配信される', async () => {
  reset();
  const sessionId = 'contract-ok';
  const { minutes, files, content } = await recording(sessionId, BIG);
  const result = await uploadToWeb(minutes, files);
  expect(result).toStrictEqual({ uploaded: true, sessionId, viewUrl: `${proxyBase}/s/${sessionId}` });
  const speakerParts = exchanges.filter((e) => e.path === '/ingest/audio/part' && e.userId === SPEAKER);
  expect(speakerParts.map((e) => e.status)).toStrictEqual([200, 200]);
  expect(exchanges.every((e) => e.status === 200), JSON.stringify(exchanges)).toBeTruthy();
  await assertDelivered(sessionId, content);
  const detail = await (await fetch(`${worker!.base}/s/${sessionId}`, { headers: { Cookie: cookie } })).text();
  expect(detail).toMatch(/契約テスト話者/);
  expect(detail).toMatch(/contract-vc/);
});

test('契約: complete の応答喪失は recorder の再送を Worker が冪等に受け、トラックは重複しない', async () => {
  let dropped = false;
  reset((path, userId) => {
    if (path === '/ingest/audio/complete' && userId === SPEAKER && !dropped) {
      dropped = true;
      return 'drop-response';
    }
    return undefined;
  });
  const sessionId = 'contract-lost-complete';
  const { minutes, files, content } = await recording(sessionId, 1024);
  const result = await uploadToWeb(minutes, files);
  expect(result.uploaded, String(result.reason)).toBe(true);
  const completes = exchanges.filter((e) => e.path === '/ingest/audio/complete' && e.userId === SPEAKER);
  // 1 回目は Worker で完了済み(応答だけ喪失)、2 回目は alreadyCompleted の 200
  expect(completes.map((e) => [e.status, e.fault])).toStrictEqual([[200, true], [200, false]]);
  expect(exchanges.filter((e) => e.path === '/ingest/audio/abort').length).toBe(0);
  await assertDelivered(sessionId, content);
});

test('契約: 音声の部分失敗は abort して他を続行し、同じ保存物の再送で欠けたトラックだけが埋まる', async () => {
  reset((path, userId) => (path === '/ingest/audio/part' && userId === SPEAKER ? { status: 400 } : undefined));
  const sessionId = 'contract-partial';
  const { minutes, files, content } = await recording(sessionId, 1024);
  const failed = await uploadToWeb(minutes, files);
  expect(failed.uploaded).toBe(false);
  // 文字起こしは届いているので WebUI の URL は残る(pipeline はこの結果で PCM を残す)
  expect(failed.viewUrl).toBe(`${proxyBase}/s/${sessionId}`);
  expect(String(failed.reason)).toMatch(new RegExp(`${SPEAKER}: audio part 400`));
  const aborts = exchanges.filter((e) => e.path === '/ingest/audio/abort');
  expect(aborts.map((e) => [e.userId, e.status, e.fault])).toStrictEqual([[SPEAKER, 200, false]]);
  expect((await download(sessionId, `audio-${SPEAKER}`)).status).toBe(404);
  expect((await download(sessionId, 'audio-mixed')).status).toBe(200);
  expect(await tracks(sessionId)).toStrictEqual([
    { user_id: SPEAKER, r2_key: null, duration_sec: 37 },
    { user_id: 'mixed', r2_key: `sessions/${GUILD}/${sessionId}/audio/mixed.m4a`, duration_sec: 42 },
  ]);

  // reupload.ts と同じく、保存済みの同じファイルで uploadToWeb をやり直す
  reset();
  const retried = await uploadToWeb(minutes, files);
  expect(retried.uploaded, String(retried.reason)).toBe(true);
  await assertDelivered(sessionId, content);
});
