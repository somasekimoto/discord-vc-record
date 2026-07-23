/**
 * mix.js のテスト:
 *  - computeMixPlan(純粋関数): 配置・クランプ・フレーム境界揃え
 *  - writeMixedPcm: 実時間軸への配置と同時発話の合算(クリップ含む)を生PCMで検証
 *  - buildMixedAudio: m4a 生成まで通しで確認(ffmpeg 必須)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeMixPlan, writeMixedPcm, buildMixedAudio } from '../src/mix.js';
import { BYTES_PER_SEC } from './helpers.mjs';

const track = (bytes, utterances, pcmPath = '/x/track.pcm') => ({ pcmPath, bytes, utterances });

test('computeMixPlan: 発話が実時刻オフセットに配置され、総量はセッション長になる', () => {
  const summary = { startedAt: 0, endedAt: 10_000 };
  const plan = computeMixPlan(summary, [
    track(BYTES_PER_SEC, [{ startedAt: 2000, endedAt: 3000, byteStart: 0, byteEnd: BYTES_PER_SEC }]),
  ]);
  assert.equal(plan.totalBytes, BYTES_PER_SEC * 10);
  assert.deepEqual(plan.tracks[0].segments, [
    { srcStart: 0, length: BYTES_PER_SEC, dstOffset: BYTES_PER_SEC * 2 },
  ]);
});

test('computeMixPlan: セッション終了時刻を超える発話は総量を押し広げる', () => {
  const summary = { startedAt: 0, endedAt: 1000 };
  const plan = computeMixPlan(summary, [
    track(BYTES_PER_SEC * 2, [{ startedAt: 500, endedAt: 2500, byteStart: 0, byteEnd: BYTES_PER_SEC * 2 }]),
  ]);
  assert.equal(plan.totalBytes, Math.round(BYTES_PER_SEC * 0.5) + BYTES_PER_SEC * 2);
});

test('computeMixPlan: byteEnd はファイルサイズへクランプ、範囲外の発話は落とす', () => {
  const summary = { startedAt: 0, endedAt: 10_000 };
  const plan = computeMixPlan(summary, [
    track(BYTES_PER_SEC, [
      // byteEnd がファイルサイズ超 → 実サイズまで
      { startedAt: 0, endedAt: 2000, byteStart: 0, byteEnd: BYTES_PER_SEC * 5 },
      // byteStart がファイルサイズ以降 → 長さ0で落ちる
      { startedAt: 3000, endedAt: 4000, byteStart: BYTES_PER_SEC * 2, byteEnd: BYTES_PER_SEC * 3 },
    ]),
  ]);
  assert.equal(plan.tracks[0].segments.length, 1);
  assert.equal(plan.tracks[0].segments[0].length, BYTES_PER_SEC);
});

test('computeMixPlan: オフセットは常にサンプルフレーム(4バイト)境界に揃う', () => {
  const summary = { startedAt: 0, endedAt: 10_000 };
  const plan = computeMixPlan(summary, [
    // 1ms = 192バイト相当だが、7ms 等の中途半端な時刻でも 4 の倍数に丸まる
    track(BYTES_PER_SEC, [{ startedAt: 7, endedAt: 1007, byteStart: 2, byteEnd: BYTES_PER_SEC - 2 }]),
  ]);
  const seg = plan.tracks[0].segments[0];
  assert.equal(seg.dstOffset % 4, 0);
  assert.equal(seg.srcStart % 4, 0);
  assert.equal(seg.length % 4, 0);
});

test('computeMixPlan: 配置できる発話が1つも無ければ null(utterances 未記録の旧録音)', () => {
  const summary = { startedAt: 0, endedAt: 10_000 };
  assert.equal(computeMixPlan(summary, [track(BYTES_PER_SEC, [])]), null);
  assert.equal(computeMixPlan(summary, []), null);
});

/** 指定秒数の一定値 PCM(s16le 48k stereo)。合算検証を単純にするためトーンではなく定数 */
function constPcm(seconds, value) {
  const samples = Math.round(48000 * seconds);
  const buf = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(value, i * 4);
    buf.writeInt16LE(value, i * 4 + 2);
  }
  return buf;
}

const sampleAt = (buf, sec) => buf.readInt16LE(Math.round(BYTES_PER_SEC * sec / 4) * 4);

test('writeMixedPcm: 実時間軸に配置され、同時発話は合算・無音は0のまま', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mix-test-'));
  try {
    const aPath = join(dir, 'a.pcm');
    const bPath = join(dir, 'b.pcm');
    await writeFile(aPath, constPcm(1, 1000));
    await writeFile(bPath, constPcm(1, 2000));

    const summary = { startedAt: 0, endedAt: 4000 };
    const plan = computeMixPlan(summary, [
      // A: 1.0〜2.0秒 / B: 1.5〜2.5秒 → 1.5〜2.0秒が重なる
      track(BYTES_PER_SEC, [{ startedAt: 1000, endedAt: 2000, byteStart: 0, byteEnd: BYTES_PER_SEC }], aPath),
      track(BYTES_PER_SEC, [{ startedAt: 1500, endedAt: 2500, byteStart: 0, byteEnd: BYTES_PER_SEC }], bPath),
    ]);
    const outPath = join(dir, 'mixed.pcm');
    await writeMixedPcm(plan, outPath);

    const mixed = await readFile(outPath);
    assert.equal(mixed.length, BYTES_PER_SEC * 4); // セッション長 = 4秒
    assert.equal(sampleAt(mixed, 0.5), 0);         // 発話前は無音
    assert.equal(sampleAt(mixed, 1.25), 1000);     // A のみ
    assert.equal(sampleAt(mixed, 1.75), 3000);     // A + B の重なり
    assert.equal(sampleAt(mixed, 2.25), 2000);     // B のみ
    assert.equal(sampleAt(mixed, 3.5), 0);         // 発話後も無音
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeMixedPcm: 合算は int16 でクリップされる', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mix-test-'));
  try {
    const aPath = join(dir, 'a.pcm');
    const bPath = join(dir, 'b.pcm');
    await writeFile(aPath, constPcm(0.5, 20000));
    await writeFile(bPath, constPcm(0.5, 20000));

    const summary = { startedAt: 0, endedAt: 1000 };
    const half = Math.round(BYTES_PER_SEC / 2);
    const plan = computeMixPlan(summary, [
      track(half, [{ startedAt: 0, endedAt: 500, byteStart: 0, byteEnd: half }], aPath),
      track(half, [{ startedAt: 0, endedAt: 500, byteStart: 0, byteEnd: half }], bPath),
    ]);
    const outPath = join(dir, 'mixed.pcm');
    await writeMixedPcm(plan, outPath);

    const mixed = await readFile(outPath);
    assert.equal(sampleAt(mixed, 0.25), 32767); // 20000+20000 → クリップ
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildMixedAudio: m4a が生成され durationSec がセッション長になる(ffmpeg 必須)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mix-test-'));
  try {
    const aPath = join(dir, 'a.pcm');
    await writeFile(aPath, constPcm(1, 1000));

    const summary = { startedAt: 0, endedAt: 4000 };
    const tracks = [
      track(BYTES_PER_SEC, [{ startedAt: 1000, endedAt: 2000, byteStart: 0, byteEnd: BYTES_PER_SEC }], aPath),
    ];
    const outPath = join(dir, 'mixed.m4a');
    const result = await buildMixedAudio(summary, tracks, outPath);

    assert.equal(result.path, outPath);
    assert.equal(result.durationSec, 4);
    const { size } = await stat(outPath);
    assert.ok(size > 0, 'mixed.m4a が空');
    // 中間 PCM は消えている
    await assert.rejects(stat(`${outPath}.tmp.pcm`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildMixedAudio: 配置できる発話が無ければ null を返しファイルを作らない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mix-test-'));
  try {
    const summary = { startedAt: 0, endedAt: 4000 };
    const outPath = join(dir, 'mixed.m4a');
    assert.equal(await buildMixedAudio(summary, [track(BYTES_PER_SEC, [])], outPath), null);
    await assert.rejects(stat(outPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
