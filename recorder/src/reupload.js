/**
 * reupload.js — ローカル保存済みセッションを web へ再アップロードする
 *
 * アップロードだけ失敗した(413等)セッションの復旧用。
 * セッションディレクトリの transcript.json と <userId>.wav を読んで uploadToWeb を呼ぶ。
 *
 * 使い方:
 *   node src/reupload.js <sessionId>
 *   (RECORDINGS_DIR 配下の <sessionId>/ を対象。既定 ./recordings)
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadToWeb } from './upload.js';

const sessionId = process.argv[2];
if (!sessionId) {
  console.error('usage: node src/reupload.js <sessionId>');
  process.exit(1);
}

const dir = join(process.env.RECORDINGS_DIR || './recordings', sessionId);
const jsonPath = join(dir, 'transcript.json');
const mdPath = join(dir, 'transcript.md');

const minutes = JSON.parse(await readFile(jsonPath, 'utf8'));

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

console.log(`[reupload] session=${minutes.sessionId} wavs=${wavPaths.length}`);
const result = await uploadToWeb(minutes, { mdPath, jsonPath, wavPaths });
console.log(JSON.stringify(result, null, 2));
process.exit(result.uploaded ? 0 : 1);
