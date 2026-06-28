/**
 * stt/local.js — ローカル文字起こし（faster-whisper）— スタブ
 *
 * MVP では未配線。STT_PROVIDER=local にした時の枠だけ用意してある。
 * 将来ここで faster-whisper（Python サイドカー or CLI）を呼び、
 * 同じ { text, segments, engine } を返すように実装する。
 *
 * 実装メモ:
 *  - faster-whisper は Python なので、子プロセスで呼ぶ薄い CLI を用意するか、
 *    HTTP の transcribe ワーカーを立てて叩く。
 *  - large-v3 は重いので lazy-start / モデルキャッシュを検討。
 */
export async function transcribe(_audioPath, _opts = {}) {
  throw new Error(
    'ローカル STT(faster-whisper) は未実装です。STT_PROVIDER=openai を使うか、stt/local.js を実装してください。',
  );
}
