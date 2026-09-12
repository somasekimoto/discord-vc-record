/**
 * reupload.js — ローカル保存済みセッションを web へ再アップロードする
 *
 * アップロードだけ失敗した(413等)セッションの復旧用。
 * セッションディレクトリの transcript.json と <userId>.wav(あれば mixed.m4a も)を
 * 読んで uploadToWeb を呼ぶ。
 *
 * 使い方:
 *   node src/reupload.ts <sessionId>
 *   (RECORDINGS_DIR 配下の <sessionId>/ を対象。既定 ./recordings)
 */
import type { Minutes } from './types.ts';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadToWeb } from './upload.ts';

const sessionId = process.argv[2];
if (!sessionId) {
  console.error('usage: node src/reupload.ts <sessionId>');
  process.exit(1);
}

const dir = join(process.env.RECORDINGS_DIR || './recordings', sessionId);
const jsonPath = join(dir, 'transcript.json');
const mdPath = join(dir, 'transcript.md');

// 旧保存 JSON の信頼境界。移行で形式や受理条件を変更しない。
const saved: unknown = JSON.parse(await readFile(jsonPath, 'utf8'));
const minutes = saved as Minutes;

const wavPaths = [];
for (const s of minutes.speakers || []) {
  const p = join(dir, `${s.userId}.wav`);
  try {
    await stat(p);
    wavPaths.push(p);
  } catch {
    console.warn(`[reupload] wav が見つからないためスキップ: ${p}`);
  }
}

let mixedPath: string | null = join(dir, 'mixed.m4a');
try {
  await stat(mixedPath);
} catch {
  mixedPath = null;
}

console.log(`[reupload] session=${minutes.sessionId} wavs=${wavPaths.length} mixed=${Boolean(mixedPath)}`);
const result = await uploadToWeb(minutes, { mdPath, jsonPath, wavPaths, mixedPath });
console.log(JSON.stringify(result, null, 2));
process.exit(result.uploaded ? 0 : 1);
