/**
 * pipeline.process() の統合テスト(openai 経路の正常系)。
 *
 * OPENAI_BASE_URL をローカルのモックサーバーに向け、実際の切り出し音声が
 * 期待の長さで送られてくること・結合で呼び出し数が減ること・
 * 時系列 Markdown が正しく組まれることを確認する。ffmpeg が必要。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeSession, BYTES_PER_SEC } from './helpers.mjs';

// --- モック OpenAI transcriptions API ---
// multipart ボディのサイズから音声長を概算してテキストに埋める(区間の識別用)
const calls = [];
const server = createServer((req, res) => {
  let size = 0;
  req.on('data', (d) => (size += d.length));
  req.on('end', () => {
    calls.push({ size });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ text: `発話${calls.length}(${(size / BYTES_PER_SEC).toFixed(2)}s相当)` }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

process.env.STT_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = 'sk-test-dummy';
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
delete process.env.WEB_BASE_URL;

const { process: runPipeline } = await import('../src/pipeline.js');

test.after(() => server.close());

test('正常系: 結合・短小スキップ・時系列マージ・切り出し音声長', async () => {
  const { summary, tracks, t0, cleanup } = await makeSession([
    {
      userId: '111',
      displayName: 'Alice',
      pcmSeconds: 3.2,
      utterances: [
        // #0 と #1 はギャップ 0.8s(<=1.5s) → 1区間に結合されるはず
        { startMs: 1000, endMs: 2000, byteStart: 0, byteEnd: BYTES_PER_SEC },
        { startMs: 2800, endMs: 3800, byteStart: BYTES_PER_SEC, byteEnd: BYTES_PER_SEC * 2 },
        // 0.2 秒 → 短小区間としてスキップされるはず
        { startMs: 30000, endMs: 30200, byteStart: BYTES_PER_SEC * 3, byteEnd: BYTES_PER_SEC * 3.2 },
      ],
    },
    {
      userId: '222',
      displayName: 'Bob',
      pcmSeconds: 1,
      freq: 880,
      utterances: [
        { startMs: 10000, endMs: 11000, byteStart: 0, byteEnd: BYTES_PER_SEC },
      ],
    },
  ]);

  try {
    const { markdown, minutes } = await runPipeline(summary, tracks);

    // 結合により STT 呼び出しは Alice 1回 + Bob 1回 = 計2回
    assert.equal(calls.length, 2);

    // 発話は Alice(結合済み) → Bob の時刻順。短小区間は落ちる
    assert.deepEqual(
      minutes.utterances.map((u) => `${u.displayName}@${u.startedAt - t0}`),
      ['Alice@1000', 'Bob@10000'],
    );
    // 結合区間の endedAt は後半の発話の終了時刻
    assert.equal(minutes.utterances[0].endedAt, t0 + 3800);

    // Markdown に STT の返答テキストが時系列で載る
    assert.match(markdown, /\*\*\[0:01\] Alice\*\*: 発話/);
    assert.match(markdown, /\*\*\[0:10\] Bob\*\*: 発話/);

    // Alice の結合区間の切り出し音声は発話2秒+パディング(最大0.25s、multipart外皮込みで概算)
    const largest = Math.max(...calls.map((c) => c.size));
    const approxSec = largest / BYTES_PER_SEC;
    assert.ok(approxSec > 1.9 && approxSec < 2.8, `結合区間の音声長が想定外: ${approxSec.toFixed(2)}s`);

    // speakers[].text は本人の発話テキストの連結
    const alice = minutes.speakers.find((s) => s.userId === '111');
    assert.match(alice.text, /発話/);
  } finally {
    await cleanup();
  }
});
