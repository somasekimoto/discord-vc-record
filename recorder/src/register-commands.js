/**
 * register-commands.js — スラッシュコマンドを Discord に登録する。
 *
 * 使い方: npm run register
 * GUILD_ID があればそのギルドへ即時登録(開発向け・反映が速い)。
 * 無ければグローバル登録(反映に最大1時間)。
 */
import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('[register] DISCORD_TOKEN と DISCORD_CLIENT_ID を .env に設定してください');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

try {
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`[register] ギルド ${GUILD_ID} に ${commands.length} 個のコマンドを登録しました`);
  } else {
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
    console.log(`[register] グローバルに ${commands.length} 個のコマンドを登録しました(反映に最大1時間)`);
  }
} catch (err) {
  console.error('[register] 失敗:', err);
  process.exit(1);
}
