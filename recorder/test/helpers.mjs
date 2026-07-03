/**
 * test/helpers.mjs — pipeline テスト用の共通ヘルパー
 *
 * 擬似セッション(トーンPCM + 発話区間メタデータ)を組み立てる。
 * PCM の中身は STT に依存しないテストでは長ささえ合っていればよい。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PCM_FORMAT } from '../src/recorder.js';

export const BYTES_PER_SEC =
  PCM_FORMAT.sampleRate * PCM_FORMAT.channels * (PCM_FORMAT.bitsPerSample / 8);

/** 指定秒数のトーン PCM(s16le 48k stereo)を生成する。 */
export function tonePcm(seconds, freq = 440) {
  const samples = Math.round(PCM_FORMAT.sampleRate * seconds);
  const buf = Buffer.alloc(samples * PCM_FORMAT.channels * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / PCM_FORMAT.sampleRate) * 8000);
    buf.writeInt16LE(v, i * 4);
    buf.writeInt16LE(v, i * 4 + 2);
  }
  return buf;
}

/**
 * 擬似セッションを一時ディレクトリに組み立てる。
 * @param {Array<{userId, displayName, pcmSeconds, utterances}>} users
 *   utterances の byteStart/byteEnd は BYTES_PER_SEC 換算の絶対バイト、
 *   startedAt/endedAt は sessionStart(t0) からの相対 ms で指定する。
 * @returns {{summary, tracks, t0, cleanup}}
 */
export async function makeSession(users, { durationMs = 60_000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pipeline-test-'));
  const t0 = Date.now() - 600_000;

  const tracks = [];
  for (const u of users) {
    const pcmPath = join(dir, `${u.userId}.pcm`);
    await writeFile(pcmPath, tonePcm(u.pcmSeconds, u.freq ?? 440));
    tracks.push({
      userId: u.userId,
      displayName: u.displayName,
      pcmPath,
      bytes: Math.round(BYTES_PER_SEC * u.pcmSeconds),
      durationSec: Math.round(u.pcmSeconds),
      utterances: (u.utterances ?? []).map((seg) => ({
        startedAt: t0 + seg.startMs,
        endedAt: t0 + seg.endMs,
        byteStart: seg.byteStart,
        byteEnd: seg.byteEnd,
      })),
    });
  }

  const summary = {
    id: 'testguild-testchan-session1',
    guildId: '123456789012345678',
    channelId: '234567890123456789',
    channelName: 'general-vc',
    startedAt: t0,
    endedAt: t0 + durationMs,
    dir,
    participants: users.map((u) => ({
      userId: u.userId,
      displayName: u.displayName,
      joinedAt: t0,
      leftAt: t0 + durationMs,
    })),
  };

  return {
    summary,
    tracks,
    t0,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
