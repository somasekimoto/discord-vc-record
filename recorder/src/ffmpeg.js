/**
 * ffmpeg.js — ffmpeg 実行の共通ヘルパー
 *
 * pipeline.js(wav 化・区間切り出し)と mix.js(ミックス音声のエンコード)で共用する。
 */
import { spawn } from 'node:child_process';

export function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${err}`))));
    p.on('error', reject);
  });
}
