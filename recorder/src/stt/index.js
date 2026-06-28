/**
 * stt/index.js — STT プロバイダ抽象化レイヤー
 *
 * pipeline.js は具体実装を知らず、この transcribe() だけを呼ぶ。
 * プロバイダの追加 = ファイル1枚 + 下の分岐1行。
 *
 * 共通 interface:
 *   transcribe(audioPath, { language }) -> Promise<{
 *     text: string,
 *     segments: Array<{ start: number, end: number, text: string }>,  // 秒
 *     engine: string,
 *   }>
 */
import { transcribe as openaiTranscribe } from './openai.js';
import { transcribe as localTranscribe } from './local.js';

const PROVIDERS = {
  openai: openaiTranscribe,
  local: localTranscribe,
};

export function getProviderName() {
  return process.env.STT_PROVIDER ?? 'openai';
}

/**
 * @param {string} audioPath  文字起こし対象の音声ファイル(wav/mp3 等)
 * @param {object} [opts]
 * @param {string} [opts.language] ISO-639-1(例: 'ja')
 */
export async function transcribe(audioPath, opts = {}) {
  const name = getProviderName();
  const impl = PROVIDERS[name];
  if (!impl) {
    throw new Error(`不明な STT_PROVIDER: ${name}（利用可能: ${Object.keys(PROVIDERS).join(', ')}）`);
  }
  return impl(audioPath, { language: 'ja', ...opts });
}
