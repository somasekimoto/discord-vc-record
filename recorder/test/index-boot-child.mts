import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as discord from 'discord.js';
import type { InteractionReplyOptions } from 'discord.js';

// 子プロセス専用: SDK export の置換はこの境界だけ。録音/decoder は本物を import する。
let client: FakeClient;
class FakeClient extends EventEmitter {
  user = { tag: 'local-fake' };
  guilds = { cache: new Map<string, never>() };
  channels = { fetch: async () => { throw new Error('unexpected channel fetch'); } };
  constructor() { super(); client = this; }
  async login(token: string) {
    assert.equal(token, 'local-fake-token');
    assert.equal(this.listenerCount('voiceStateUpdate'), 1);
    assert.equal(this.listenerCount('interactionCreate'), 1);
    this.emit('clientReady');
    return token;
  }
  async destroy() { console.log('fake-client-destroyed'); }
}
// CJS の default/module.exports を含む namespace 全体は展開しない。
// SDK の非 configurable な getter を Node の mock が再定義するのを避ける。
mock.module('discord.js', {
  namedExports: {
    Client: FakeClient,
    GatewayIntentBits: discord.GatewayIntentBits,
    MessageFlags: discord.MessageFlags,
  },
});
mock.module('dotenv/config', { namedExports: {} });
globalThis.fetch = async () => { throw new Error('network forbidden in boot test'); };
await import('../src/index.ts');

const replies: InteractionReplyOptions[] = [];
const edits: unknown[] = [];
const interaction = {
  guildId: 'guild', channelId: 'voice', user: { id: 'user' }, member: null,
  message: { edit: async (payload: unknown) => { edits.push(payload); } },
  reply: async (payload: InteractionReplyOptions) => { replies.push(payload); },
  deferUpdate: async () => {},
  isButton: () => true,
  customId: 'recstart:voice',
};
// EventEmitter.emit は async listener を待たないので、登録された同じ handler を直接待つ。
for (const handler of client!.listeners('interactionCreate')) await handler(interaction);
assert.match(replies[0].content!, /先にVCに参加/);
for (const handler of client!.listeners('interactionCreate')) await handler({ ...interaction, customId: 'autostop:stop:old' });
assert.match(replies[1].content!, /すでに終了/);
assert.deepEqual(edits, [{ components: [] }]);
for (const handler of client!.listeners('interactionCreate')) await handler({
  ...interaction, isButton: () => false, isChatInputCommand: () => true,
  commandName: 'rec', options: { getSubcommand: () => 'status' },
});
assert.match(replies[2].content!, /録音は行われていません/);
client!.emit('voiceStateUpdate', { guild: { id: 'guild' }, channelId: null }, { guild: { id: 'guild' }, channelId: null });
console.log('index-boot-verified');
process.emit('SIGTERM', 'SIGTERM');
