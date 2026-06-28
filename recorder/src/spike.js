/**
 * Phase 0 — DAVE 録音スパイク
 *
 * 目的: 「Bot がテスト VC に join し、参加者の声を 1 ファイルに録音できる」ことだけを検証する。
 * これが通れば @discordjs/voice 0.19.2 + @snazzah/davey が DAVE(E2EE) 下でも
 * 受信音声を復号できている = 全体構成が成立する、と判断できる。
 *
 * 使い方:
 *   1. recorder/.env に DISCORD_TOKEN / GUILD_ID / VOICE_CHANNEL_ID を設定
 *   2. npm run spike
 *   3. VC に入って数秒喋る → Ctrl+C で停止
 *   4. recordings/spike-<userId>.wav が再生でき、無音でなければ成功
 *
 * 注意: これは検証用の使い捨てスクリプト。本実装は recorder.js 側で行う。
 */
import 'dotenv/config';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import prism from 'prism-media';

const { DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID } = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error('[spike] DISCORD_TOKEN / GUILD_ID / VOICE_CHANNEL_ID を .env に設定してください');
  process.exit(1);
}

const OUT_DIR = new URL('../recordings/', import.meta.url);

// 48kHz / stereo / s16le の生 PCM に最小 WAV ヘッダを付ける。
// (検証目的なので ffmpeg を挟まず、PCM をそのまま WAV 化して再生可能にする)
function wavHeader(dataLength, { sampleRate = 48000, channels = 2, bitsPerSample = 16 } = {}) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataLength, 40);
  return buf;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const recording = new Set(); // 同一ユーザーの二重購読を防ぐ

client.once('clientReady', async () => {
  console.log(`[spike] logged in as ${client.user.tag}`);
  await mkdir(OUT_DIR, { recursive: true });

  const connection = joinVoiceChannel({
    channelId: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    adapterCreator: client.guilds.cache.get(GUILD_ID).voiceAdapterCreator,
    selfDeaf: false, // 受信するので deaf にしない
    selfMute: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log('[spike] voice connection READY — VC で喋ってください。Ctrl+C で停止。');
  } catch (err) {
    console.error('[spike] 接続が READY になりませんでした (DAVE ネゴシエーション失敗の可能性):', err);
    connection.destroy();
    process.exit(1);
  }

  const receiver = connection.receiver;

  receiver.speaking.on('start', async (userId) => {
    if (recording.has(userId)) return;
    recording.add(userId);
    console.log(`[spike] recording user ${userId} ...`);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    const pcmPath = new URL(`spike-${userId}.pcm`, OUT_DIR);
    const out = createWriteStream(pcmPath, { flags: 'a' });

    try {
      await pipeline(opusStream, decoder, out);
    } catch (err) {
      console.error(`[spike] stream error for ${userId}:`, err.message);
    } finally {
      recording.delete(userId);
      console.log(`[spike] segment ended for ${userId} -> ${pcmPath.pathname}`);
    }
  });
});

// Ctrl+C で PCM を WAV に変換して終了
async function shutdown() {
  console.log('\n[spike] stopping...');
  const conn = getVoiceConnection(GUILD_ID);
  if (conn) conn.destroy();

  // 生 PCM ファイルを WAV 化（ヘッダだけ付け直す）
  const { readdir, readFile, writeFile } = await import('node:fs/promises');
  const files = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.pcm'));
  for (const f of files) {
    const pcm = await readFile(new URL(f, OUT_DIR));
    const wav = Buffer.concat([wavHeader(pcm.length), pcm]);
    const wavName = f.replace(/\.pcm$/, '.wav');
    await writeFile(new URL(wavName, OUT_DIR), wav);
    console.log(`[spike] wrote ${wavName} (${(pcm.length / 1024 / 1024).toFixed(2)} MiB PCM)`);
    if (pcm.length === 0) console.warn(`[spike] ⚠ ${wavName} が空です — 音声を受信できていません（DAVE 受信不可の疑い）`);
  }
  console.log('[spike] done. recordings/ の .wav を再生して確認してください。');
  await client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(DISCORD_TOKEN);
