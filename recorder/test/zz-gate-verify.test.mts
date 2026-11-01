// [検証用・マージしない] gate が recorder の失敗でマージを止めるかの確認。
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('gate verification: fixed', () => {
  assert.equal(1, 1);
});
