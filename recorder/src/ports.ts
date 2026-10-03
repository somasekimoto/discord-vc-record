import type { APIActionRowComponent, APIButtonComponentWithCustomId, InteractionReplyOptions, APIInteractionGuildMember } from 'discord.js';

/** コントローラが使うフィールドだけ。SDK 全体の fake は要求しない。 */
export type ButtonRows = APIActionRowComponent<APIButtonComponentWithCustomId>[];
export interface PromptPayload { content: string; components: ButtonRows }
export interface MessageEdit { content?: string; components: ButtonRows }
export interface EditableMessage { edit(payload: MessageEdit): Promise<unknown> }
export interface PromptChannel { send(payload: PromptPayload): Promise<unknown> }
export interface VoiceEntry {
  id?: string;
  channelId: string | null;
  member?: { user?: { bot?: boolean }; displayName?: string } | null;
}
export interface GuildPort {
  id: string;
  voiceStates?: { cache: { filter(predicate: (state: VoiceEntry) => boolean): { size: number } } };
}
export interface VoiceStatePort extends VoiceEntry {
  guild?: GuildPort;
  channel?: PromptChannel | null;
}
export interface StartOptions {
  guildId: string;
  channelId: string;
  startedByUserId: string;
  notifyChannelId?: string | null;
}
export interface StartButtonPort {
  customId: string;
  guildId: string | null;
  channelId: string | null;
  user: { id: string };
  member?: { voice?: { channelId?: string | null } } | APIInteractionGuildMember | null;
  reply(payload: InteractionReplyOptions): Promise<unknown>;
  deferUpdate(): Promise<unknown>;
  message?: EditableMessage;
}
export interface AutoStopButtonPort {
  customId: string;
  guildId: string | null;
  reply(payload: InteractionReplyOptions): Promise<unknown>;
  update(payload: MessageEdit): Promise<unknown>;
  message?: EditableMessage;
}
export interface AutoSession {
  id: string;
  channelId: string;
  notifyChannelId: string | null;
}
export type TimerHandle = number | NodeJS.Timeout;
export interface Timers {
  setTimeout(callback: () => Promise<void>, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null): void;
}
export interface AutoStopState {
  sessionId: string;
  phase: 'countdown' | 'extended';
  timer: TimerHandle | null;
  message: EditableMessage | null;
}
export interface AutoStopOptions {
  sessions: { get(guildId: string): AutoSession | undefined };
  stop(guildId: string, reason: string): Promise<void>;
  fetchChannel(channelId: string | null): Promise<{ send(payload: PromptPayload): Promise<EditableMessage> }>;
  getGuild(guildId: string): GuildPort | undefined;
  emptyDelayMs?: number;
  timers?: Timers;
}
