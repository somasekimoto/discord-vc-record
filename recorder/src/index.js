/**
 * index.js — 録音Bot エントリポイント。
 *
 * Discord Gateway に接続し、スラッシュコマンド(/record, /setup)を処理する。
 * 録音は SessionManager(recorder.js)へ委譲。
 * /record stop 後の文字起こし・保管は pipeline.js(Phase 2)へ委譲する。
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import { SessionManager } from './recorder.js';
import { process as runPipeline } from './pipeline.js';
import { JoinPromptNotifier, parsePromptChannelIds } from './join-prompt.js';
import { AutoStopController, parseEmptyDelayMs } from './auto-stop.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECORDINGS_DIR = process.env.RECORDINGS_DIR ?? join(__dirname, '..', 'recordings');

const { DISCORD_TOKEN } = process.env;
if (!DISCORD_TOKEN) {
  console.error('[bot] DISCORD_TOKEN を .env に設定してください');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const sessions = new SessionManager({ client, baseDir: RECORDINGS_DIR });

// 指定 VC への入室時に /rec start を促す(未設定なら無効)
const promptChannelIds = parsePromptChannelIds(process.env.RECORD_PROMPT_CHANNEL_IDS);
const joinPrompt = promptChannelIds.length
  ? new JoinPromptNotifier({ channelIds: promptChannelIds, sessions })
  : null;
if (joinPrompt) {
  console.log(`[bot] join prompt enabled for channels: ${promptChannelIds.join(', ')}`);
}

// VC が無人になったら猶予付きで自動停止(AUTO_STOP_EMPTY_SEC=0 で無効)
const autoStopDelayMs = parseEmptyDelayMs(process.env.AUTO_STOP_EMPTY_SEC);
const autoStop = autoStopDelayMs > 0
  ? new AutoStopController({
      sessions,
      emptyDelayMs: autoStopDelayMs,
      fetchChannel: (channelId) => client.channels.fetch(channelId),
      getGuild: (guildId) => client.guilds.cache.get(guildId),
      stop: (guildId) => autoStopSession(guildId),
    })
  : null;
if (autoStop) {
  console.log(`[bot] auto-stop enabled: empty VC for ${autoStopDelayMs / 1000}s`);
}

client.once('clientReady', () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
});

// VC への参加/退出を録音中セッションへ流す(participants の根拠)
client.on('voiceStateUpdate', (oldState, newState) => {
  sessions.routeVoiceState(oldState, newState);
  joinPrompt?.handleVoiceState(oldState, newState).catch((err) => {
    console.error('[bot] join prompt error:', err);
  });
  autoStop?.handleVoiceState(oldState, newState).catch((err) => {
    console.error('[bot] auto-stop error:', err);
  });
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith('autostop:')) {
    try {
      await autoStop?.handleButton(interaction);
    } catch (err) {
      console.error('[bot] auto-stop button error:', err);
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'rec') {
      await handleRecord(interaction);
    } else if (interaction.commandName === 'setup') {
      await handleSetup(interaction);
    }
  } catch (err) {
    console.error('[bot] interaction error:', err);
    const msg = `エラー: ${err.message ?? err}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg).catch(() => {});
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

async function handleRecord(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (sub === 'start') {
    // コマンドを打った人が今いる VC を録音対象にする
    const member = interaction.member;
    const voiceChannelId = member?.voice?.channelId;
    if (!voiceChannelId) {
      await interaction.reply({
        content: '先にVCに参加してから /rec start を実行してください。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const guild = client.guilds.cache.get(guildId);
    const resolveName = (id) => guild?.members?.cache.get(id)?.displayName ?? id;

    const session = await sessions.start({
      guildId,
      channelId: voiceChannelId,
      startedByUserId: interaction.user.id,
      notifyChannelId: interaction.channelId, // 自動停止の通知先(このコマンドを打ったチャンネル)
      resolveName,
    });

    await interaction.editReply(
      `🔴 録音を開始しました（セッション: \`${session.id}\`）\n` +
        `このVCの会話を話者ごとに記録します。終了するには \`/rec stop\` を実行してください。`,
    );
    return;
  }

  if (sub === 'status') {
    const session = sessions.get(guildId);
    if (!session) {
      await interaction.reply({ content: '現在このサーバーで録音は行われていません。', flags: MessageFlags.Ephemeral });
    } else {
      const mins = ((Date.now() - session.startedAt) / 60000).toFixed(1);
      await interaction.reply({
        content: `🔴 録音中（${mins}分経過、参加者 ${session.participants.size}名）`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (sub === 'stop') {
    await interaction.deferReply();
    const stopped = await stopSessionSafe(guildId);
    if (!stopped) {
      // 自動停止と /rec stop が競合した場合もここに来る
      await interaction.editReply('現在このサーバーで録音は行われていません。');
      return;
    }
    await autoStop?.notifySessionEnded(guildId); // 出ているボタン付きメッセージを片付ける
    const { summary, tracks } = stopped;
    await interaction.editReply(formatStopReport(tracks));
    if (tracks.length > 0) announcePipelineResult(summary, tracks, interaction.channel);
    return;
  }
}

/**
 * 録音停止を冪等に行う。進行中の録音がなければ null。
 * 自動停止・ボタン・/rec stop が競合しても二重停止でエラーにしない。
 */
async function stopSessionSafe(guildId) {
  if (!sessions.get(guildId)) return null;
  try {
    return await sessions.stop(guildId);
  } catch (err) {
    // 競合の後着はここに来る。純粋な停止失敗でも録音データはディスクに残り
    // reupload.js で復旧できるため、呼び出し元へは「停止済み」として扱わせる。
    console.error(`[bot] stop error (guild=${guildId}):`, err.message);
    return null;
  }
}

/** 無人検知による自動停止(AutoStopController から呼ばれる)。通知は /rec start のチャンネルへ。 */
async function autoStopSession(guildId) {
  const notifyChannelId = sessions.get(guildId)?.notifyChannelId;
  const stopped = await stopSessionSafe(guildId);
  if (!stopped) return;
  console.log(`[bot] auto-stopped session for guild ${guildId}`);
  const { summary, tracks } = stopped;
  const channel = notifyChannelId
    ? await client.channels.fetch(notifyChannelId).catch(() => null)
    : null;
  await channel?.send(formatStopReport(tracks)).catch(() => {});
  if (tracks.length > 0) announcePipelineResult(summary, tracks, channel);
}

function formatStopReport(tracks) {
  if (tracks.length === 0) return '⏹ 録音を終了しました。ただし音声が記録されませんでした。';
  const trackLines = tracks.map((t) => `・${t.displayName}: ${t.durationSec}秒`).join('\n');
  return (
    `⏹ 録音を終了しました（${tracks.length}トラック）\n${trackLines}\n\n` +
    `📝 文字起こし中です… 完了したらこのチャンネルに投稿します。`
  );
}

/**
 * 録音終了後にまとめて: wav 化 → STT → 議事録生成 → 保存。
 * 時間がかかるので非同期で進め、完了後にチャンネルへ投稿する。
 */
function announcePipelineResult(summary, tracks, channel) {
  runPipeline(summary, tracks)
    .then(async ({ minutes, files, upload }) => {
      const speakerCount = minutes.speakers.length;
      const link = upload?.uploaded
        ? `🔗 ${upload.viewUrl}\n（閲覧には対象ロールでのDiscordログインが必要です）`
        : `（WebUIアップロード未実行: ${upload?.reason ?? '設定なし'}。ローカル保存: \`${files.mdPath}\`）`;
      await channel
        ?.send(
          `✅ 文字起こしが完了しました（話者 ${speakerCount}名）\n` +
            `セッション \`${summary.id}\`\n${link}`,
        )
        .catch(() => {});
      console.log('[bot] transcript ready:', files.mdPath, '| uploaded:', upload?.uploaded);
    })
    .catch(async (err) => {
      console.error('[bot] pipeline error:', err);
      await channel?.send(`⚠ 文字起こしに失敗しました: ${err.message}`).catch(() => {});
    });
}

async function handleSetup(interaction) {
  const role = interaction.options.getRole('role');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const base = process.env.WEB_BASE_URL;
  const secret = process.env.INGEST_SECRET;
  if (!base || !secret) {
    await interaction.editReply('⚠ WEB_BASE_URL/INGEST_SECRET が未設定のため保存できません。');
    return;
  }
  const res = await fetch(`${base}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ guildId: interaction.guildId, requiredRoleId: role.id }),
  });
  if (!res.ok) {
    await interaction.editReply(`⚠ ロール設定の保存に失敗しました: ${res.status}`);
    return;
  }
  await interaction.editReply(
    `✅ 閲覧許可ロールを **${role.name}** に設定しました。\n` +
      `このロールを持つメンバーがWebUIで文字起こしを閲覧できます。`,
  );
  console.log(`[bot] setup: guild=${interaction.guildId} requiredRole=${role.id} (${role.name})`);
}

// グレースフルシャットダウン: 録音中なら停止して書き込みを確定
async function shutdown() {
  console.log('\n[bot] shutting down...');
  for (const guildId of [...sessions.byGuild.keys()]) {
    try {
      await sessions.stop(guildId);
      console.log(`[bot] stopped session for guild ${guildId}`);
    } catch (err) {
      console.error(`[bot] error stopping ${guildId}:`, err.message);
    }
  }
  await client.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

client.login(DISCORD_TOKEN);
