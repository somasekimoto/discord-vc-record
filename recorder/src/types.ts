export interface Utterance {
  startedAt: number;
  endedAt: number;
  byteStart: number;
  byteEnd: number;
}
export interface Participant {
  userId: string;
  displayName: string;
  joinedAt: number;
  leftAt: number | null;
}
export interface SessionSnapshot {
  id: string;
  guildId: string;
  channelId: string;
  channelName?: string | null;
  startedAt: number;
  endedAt: number | null;
  startedByUserId?: string;
  dir: string;
  participants: Participant[];
}
export interface Track {
  userId: string;
  displayName: string;
  pcmPath: string;
  bytes: number;
  durationSec: number;
  utterances?: Utterance[];
}
export interface TranscriptUtterance {
  userId: string;
  displayName: string;
  startedAt: number;
  endedAt: number;
  text: string;
}
export interface Speaker {
  userId: string;
  displayName: string;
  durationSec: number;
  text: string;
  engine: string;
}
/** 保存済み旧 JSON も同じ送信契約。startedByUserId への改名はしない。 */
export interface Minutes {
  sessionId: string;
  guildId: string;
  channelId: string;
  channelName?: string | null;
  startedAt: number;
  endedAt: number | null;
  startedBy?: string | null;
  language: string;
  engine: string;
  participants: Participant[];
  utterances?: TranscriptUtterance[];
  speakers?: Speaker[];
}
export interface UploadFiles {
  mdPath: string;
  jsonPath: string;
  wavPaths: string[];
  mixedPath?: string | null;
}
export interface UploadResult {
  uploaded: boolean;
  sessionId?: string;
  viewUrl?: string;
  reason?: unknown;
}

/** Error 以外の mock / 外部例外も従来のプロパティ参照と同様に扱う。 */
export function errorMessage(error: unknown): unknown {
  return error != null && typeof error === 'object' && 'message' in error ? error.message : undefined;
}
export function errorCode(error: unknown): unknown {
  return error != null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}
