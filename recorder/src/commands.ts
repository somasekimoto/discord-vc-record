/**
 * commands.js — スラッシュコマンド定義(JSON)。
 * register-commands.js が Discord へ登録し、index.js が実行を処理する。
 */
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('rec')
    .setDescription('VCの録音と文字起こしを制御します')
    .addSubcommand((sub) =>
      sub.setName('start').setDescription('あなたが今いるVCの録音を開始します'),
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('録音を終了し、文字起こしを開始します'),
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('このサーバーの録音状況を表示します'),
    ),

  // 閲覧に必要なロールを設定。管理者のみ。
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('文字起こしの閲覧を許可するロールを設定します(管理者のみ)')
    .addRoleOption((opt) =>
      opt.setName('role').setDescription('閲覧を許可するロール').setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());
