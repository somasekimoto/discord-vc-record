/**
 * pipeline.process() の統合テスト(STT失敗経路)。
 *
 * STT_PROVIDER=local(未実装で throw)にして、STT が全区間失敗しても
 * 切り出し→並列実行→時系列マージ→Markdown生成が最後まで通り、
 * 失敗区間が「（文字起こし失敗: …）」として時系列に残ることを確認する。
 * ffmpeg が必要(切り出しは実行される)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { makeSession, BYTES_PER_SEC } from './helpers.mjs';

process.env.STT_PROVIDER = 'local';
delete process.env.WEB_BASE_URL; // upload はスキップさせる

const { process: runPipeline } = await import('../src/pipeline.js');

test('STT が失敗しても時系列の議事録が生成される', async () => {
  const { summary, tracks, t0, cleanup } = await makeSession([
    {
      userId: '111',
      displayName: 'Alice',
      pcmSeconds: 2,
      utterances: [
        // 2発話・ギャップ3秒(>1.5s)なので結合されない
        { startMs: 1000, endMs: 2000, byteStart: 0, byteEnd: BYTES_PER_SEC },
        { startMs: 5000, endMs: 6000, byteStart: BYTES_PER_SEC, byteEnd: BYTES_PER_SEC * 2 },
      ],
    },
    {
      userId: '222',
      displayName: 'Bob',
      pcmSeconds: 1.5,
      freq: 880,
      utterances: [
        { startMs: 3000, endMs: 4500, byteStart: 0, byteEnd: BYTES_PER_SEC * 1.5 },
      ],
    },
  ]);

  try {
    const { markdown, minutes, files, upload } = await runPipeline(summary, tracks);

    // 発話は話者をまたいで開始時刻順に並ぶ
    assert.deepEqual(
      minutes.utterances.map((u) => `${u.displayName}@${u.startedAt - t0}`),
      ['Alice@1000', 'Bob@3000', 'Alice@5000'],
    );
    // 全区間 STT 失敗でも各発話が失敗表記で時系列に残る
    for (const u of minutes.utterances) {
      assert.match(u.text, /文字起こし失敗/);
    }

    // Markdown は会話ログ形式
    assert.match(markdown, /## 会話ログ/);
    assert.match(markdown, /\*\*\[0:01\] Alice\*\*:/);
    assert.match(markdown, /\*\*\[0:03\] Bob\*\*:/);
    assert.match(markdown, /\*\*\[0:05\] Alice\*\*:/);
    // 時系列に載ったので旧方式のフォールバックセクションは出ない
    assert.doesNotMatch(markdown, /話者別（時刻情報なし）/);

    // speakers は web(ingest/upload)が参照するため後方互換の形を維持する
    assert.equal(minutes.speakers.length, 2);
    for (const s of minutes.speakers) {
      for (const k of ['userId', 'displayName', 'durationSec', 'text', 'engine']) {
        assert.ok(k in s, `speakers[].${k} が無い`);
      }
    }

    // 会話全体のミックス音声も生成される
    assert.ok(files.mixedPath?.endsWith('mixed.m4a'));
    assert.ok((await stat(files.mixedPath)).size > 0, 'mixed.m4a が空');

    // WEB_BASE_URL 未設定なので upload はスキップ
    assert.equal(upload.uploaded, false);
  } finally {
    await cleanup();
  }
});

test('発話区間情報が無いトラックは旧方式(話者別セクション)にフォールバックする', async () => {
  const { summary, tracks, cleanup } = await makeSession([
    { userId: '111', displayName: 'Alice', pcmSeconds: 1, utterances: [] },
  ]);

  try {
    const { markdown, minutes, files } = await runPipeline(summary, tracks);

    assert.equal(minutes.utterances.length, 0);
    // 実時刻が無いのでミックスは作れない
    assert.equal(files.mixedPath, null);
    assert.match(markdown, /## 話者別（時刻情報なし）/);
    assert.match(markdown, /### Alice/);
    // speakers にはトラック全体一括の結果(ここでは失敗表記)が入る
    assert.match(minutes.speakers[0].text, /文字起こし失敗/);
  } finally {
    await cleanup();
  }
});
