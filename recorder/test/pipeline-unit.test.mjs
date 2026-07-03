/**
 * pipeline の純粋関数のユニットテスト:
 * 発話区間の結合・短小除去(mergeUtterances)とタイムスタンプ整形(fmtOffset)。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeUtterances, fmtOffset } from '../src/pipeline.js';
import { BYTES_PER_SEC } from './helpers.mjs';

// 1秒 = BYTES_PER_SEC。読みやすいようにヘルパーで組む
const utt = (startMs, endMs, byteStartSec, byteEndSec) => ({
  startedAt: startMs,
  endedAt: endMs,
  byteStart: Math.round(BYTES_PER_SEC * byteStartSec),
  byteEnd: Math.round(BYTES_PER_SEC * byteEndSec),
});

test('mergeUtterances: ギャップ1.5秒以下の発話は1区間に結合される', () => {
  const merged = mergeUtterances([
    utt(1000, 2000, 0, 1),
    utt(3500, 4500, 1, 2), // ギャップちょうど 1500ms
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].startedAt, 1000);
  assert.equal(merged[0].endedAt, 4500);
  assert.equal(merged[0].byteStart, 0);
  assert.equal(merged[0].byteEnd, BYTES_PER_SEC * 2);
});

test('mergeUtterances: ギャップが1.5秒を超える発話は結合されない', () => {
  const merged = mergeUtterances([
    utt(1000, 2000, 0, 1),
    utt(3501, 4501, 1, 2), // ギャップ 1501ms
  ]);
  assert.equal(merged.length, 2);
});

test('mergeUtterances: 3連続の近接発話は1区間にまとまる', () => {
  const merged = mergeUtterances([
    utt(0, 1000, 0, 1),
    utt(1500, 2500, 1, 2),
    utt(3000, 4000, 2, 3),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].byteEnd, BYTES_PER_SEC * 3);
});

test('mergeUtterances: 300ms未満(バイト長基準)の区間は除かれる', () => {
  const merged = mergeUtterances([
    utt(0, 1000, 0, 1),
    utt(10000, 10200, 1, 1.2), // 0.2秒 → 除外
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].startedAt, 0);
});

test('mergeUtterances: 単体では短い発話も結合で300msを超えれば残る', () => {
  const merged = mergeUtterances([
    utt(0, 200, 0, 0.2),
    utt(500, 700, 0.2, 0.4), // 結合して 0.4秒
  ]);
  assert.equal(merged.length, 1);
});

test('mergeUtterances: 入力が結合対象の元配列を破壊しない', () => {
  const input = [utt(0, 1000, 0, 1), utt(1500, 2500, 1, 2)];
  const before = JSON.stringify(input);
  mergeUtterances(input);
  assert.equal(JSON.stringify(input), before);
});

test('mergeUtterances: 空配列は空配列を返す', () => {
  assert.deepEqual(mergeUtterances([]), []);
});

test('fmtOffset: 1時間未満は m:ss', () => {
  assert.equal(fmtOffset(5000), '0:05');
  assert.equal(fmtOffset(65000), '1:05');
  assert.equal(fmtOffset(599000), '9:59');
});

test('fmtOffset: 1時間以上は h:mm:ss', () => {
  assert.equal(fmtOffset(3600000), '1:00:00');
  assert.equal(fmtOffset(3723000), '1:02:03');
});

test('fmtOffset: 負値は 0:00 に丸める', () => {
  assert.equal(fmtOffset(-500), '0:00');
});
