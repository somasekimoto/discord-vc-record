/** STT の時刻は音声内の秒。OpenAI は終了時刻を返さない。 */
export interface TranscribeOptions { language?: string }
export interface Transcription {
  text: string;
  segments: { start: number; end: number | null; text: string }[];
  engine: string;
}
export type Transcribe = (audioPath: string, opts?: TranscribeOptions) => Promise<Transcription>;
