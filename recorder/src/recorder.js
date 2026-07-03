/**
 * recorder.js — 録音セッション管理と話者別トラック録音
 *
 * Phase 0 のスパイクで実証した「speaking 検知 → per-user subscribe → opus decode → PCM 追記」
 * パターンを、複数話者・セッション・participants 記録に拡張したもの。
 *
 * Phase 1 ではローカル FS への PCM 保存までを担当する。
 * R2/D1 アップロードと STT は pipeline.js (Phase 2) が録音終了後に処理する。
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
  VoiceReceiver,
} from '@discordjs/voice';
import prism from 'prism-media';

// 48kHz / stereo / 16bit。Discord の opus 出力に合わせる(spike で確認済み)。
export const PCM_FORMAT = { sampleRate: 48000, channels: 2, bitsPerSample: 16 };

/**
 * 1 つの録音セッション。1 つの VC につき最大 1 つ。
 */
export class RecordingSession {
  /**
   * @param {object} opts
   * @param {import('discord.js').Client} opts.client
   * @param {string} opts.guildId
   * @param {string} opts.channelId       録音対象の VC
   * @param {string} opts.startedByUserId  /record start を打った人
   * @param {string} opts.baseDir          録音ファイルの保存先ルート (例: ./recordings)
   * @param {(id:string)=>string} [opts.resolveName] userId -> 表示名
   */
  constructor({ client, guildId, channelId, startedByUserId, baseDir, resolveName }) {
    this.client = client;
    this.guildId = guildId;
    this.channelId = channelId;
    this.startedByUserId = startedByUserId;
    this.resolveName = resolveName ?? ((id) => id);

    // sessionId はファイル名/URL に使うので衝突しにくい値にする。
    // Date.now 相当はランタイム側で渡らないため、startedAt は start() で記録する。
    this.id = `${guildId}-${channelId}-${process.hrtime.bigint().toString(36)}`;
    this.dir = join(baseDir, this.id);

    /** @type {VoiceConnection|null} */
    this.connection = null;
    /** @type {VoiceReceiver|null} */
    this.receiver = null;

    this.channelName = null; // start() で VC 名を記録
    this.startedAt = null;
    this.endedAt = null;
    this.status = 'idle'; // idle | recording | stopping | stopped | failed

    // userId -> 録音中フラグ(同一ユーザーの二重 subscribe 防止)
    this.activeStreams = new Set();
    // userId -> 購読中の opus stream(stop 時に明示終了する)
    this.subscriptions = new Map();
    // userId -> { userId, displayName, joinedAt, leftAt }
    this.participants = new Map();
    // 進行中のストリーム pipeline の完了 Promise 群(stop 時に待つ)
    this.pendingPipelines = new Set();
    // userId -> { bytes, utterances, current }
    // PCM には発話部分だけが連結されて無音が潰れるため、ファイル内位置と実時刻の
    // 対応はここで記録しないと復元できない。utterances が時系列議事録の根拠になる。
    this.trackStates = new Map();
  }

  /** VC に接続して録音を開始する。 */
  async start() {
    await mkdir(this.dir, { recursive: true });
    this.startedAt = Date.now();
    this.status = 'recording';

    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error(`guild ${this.guildId} not found in cache`);

    this.connection = joinVoiceChannel({
      channelId: this.channelId,
      guildId: this.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // 受信するため deaf にしない
      selfMute: true,
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      this.status = 'failed';
      this.connection.destroy();
      throw new Error(`voice connection not ready (DAVE negotiation?): ${err.message}`);
    }

    // 切断時の自動再接続。Discord 側の移動等で一時切断しても録音を継続させる。
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // 再接続中: そのまま待つ
      } catch {
        // 復帰できなければ録音を終える
        if (this.status === 'recording') this.connection.destroy();
      }
    });

    this.receiver = this.connection.receiver;

    // 既に VC にいる人を participant として記録(start 時点のスナップショット)
    const channel = guild.channels.cache.get(this.channelId);
    this.channelName = channel?.name ?? null;
    if (channel?.members) {
      for (const [memberId, member] of channel.members) {
        if (member.user?.bot) continue;
        this._markJoined(memberId, member.displayName ?? member.user.username);
      }
    }

    this.receiver.speaking.on('start', (userId) => this._onSpeakingStart(userId));
    this.receiver.speaking.on('end', (userId) => this._onSpeakingEnd(userId));
    return this.id;
  }

  /**
   * 話し始めたユーザーを per-user トラックへ録音する。
   *
   * 重要: 1ユーザーにつき購読は **セッション中1回だけ**。
   * EndBehaviorType.Manual で stop まで開けっ放しにする。
   * AfterSilence で発話ごとに購読を切ると、再購読のたびに先頭が欠け、
   * 会話全体で大量の取りこぼしが起きる(=文字起こしが極端に短くなる)ため。
   */
  _onSpeakingStart(userId) {
    if (this.status !== 'recording') return;
    if (!this.activeStreams.has(userId)) {
      this.activeStreams.add(userId);
      this._subscribe(userId);
    }

    // 発話区間を開く(時系列議事録のための実時刻と PCM 内位置)。
    // speaking start は同一発話中にも再発火しうるので、開いている間は無視する。
    const st = this.trackStates.get(userId);
    if (st && !st.current) {
      st.current = { startedAt: Date.now(), byteStart: st.bytes };
    }
  }

  _onSpeakingEnd(userId) {
    const st = this.trackStates.get(userId);
    if (!st?.current) return;
    // byteEnd 時点で decoder 内に未 flush の残り(高々数フレーム=数十ms)がありうるが、
    // pipeline 側が切り出し時に前後パディングするので実用上問題ない。
    st.utterances.push({ ...st.current, endedAt: Date.now(), byteEnd: st.bytes });
    st.current = null;
  }

  _subscribe(userId) {
    // 喋った=参加者。スナップショットに無ければ途中参加として記録。
    if (!this.participants.has(userId)) {
      this._markJoined(userId, this.resolveName(userId));
    }

    const opusStream = this.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual }, // stop() まで終了しない
    });
    const decoder = new prism.opus.Decoder({
      rate: PCM_FORMAT.sampleRate,
      channels: PCM_FORMAT.channels,
      frameSize: 960,
    });
    const out = createWriteStream(join(this.dir, `${userId}.pcm`), { flags: 'a' });

    // 書き込み済みバイト数を発話区間の根拠として数える。
    // decoder の出力はフレーム単位(サンプル境界)なので bytes は常にフレーム境界に揃う。
    const st = { bytes: 0, utterances: [], current: null };
    this.trackStates.set(userId, st);
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        st.bytes += chunk.length;
        cb(null, chunk);
      },
    });

    // 後で stop() から明示的に終了できるよう保持
    this.subscriptions.set(userId, opusStream);

    const p = pipeline(opusStream, decoder, counter, out)
      .catch((err) => {
        console.error(`[recorder] stream error user=${userId}: ${err.message}`);
      })
      .finally(() => {
        this.pendingPipelines.delete(p);
        this.subscriptions.delete(userId);
      });
    this.pendingPipelines.add(p);
  }

  _markJoined(userId, displayName) {
    this.participants.set(userId, {
      userId,
      displayName,
      joinedAt: Date.now(),
      leftAt: null,
    });
  }

  /** voiceStateUpdate から呼ばれる: 対象 VC への参加/退出を記録。 */
  handleVoiceStateUpdate(oldState, newState) {
    if (this.status !== 'recording') return;
    const userId = newState.id;
    if (newState.member?.user?.bot) return;

    const joinedThis = newState.channelId === this.channelId;
    const wasThis = oldState.channelId === this.channelId;

    if (joinedThis && !wasThis) {
      const name = newState.member?.displayName ?? userId;
      if (!this.participants.has(userId)) this._markJoined(userId, name);
      else this.participants.get(userId).leftAt = null; // 再入室
    } else if (!joinedThis && wasThis) {
      const p = this.participants.get(userId);
      if (p && p.leftAt == null) p.leftAt = Date.now();
    }
  }

  /** 録音を終了し、全ストリームの書き込み完了を待つ。トラック情報を返す。 */
  async stop() {
    if (this.status !== 'recording') return this._summary();
    this.status = 'stopping';
    this.endedAt = Date.now();

    // まだ VC にいる参加者の leftAt を確定
    for (const p of this.participants.values()) {
      if (p.leftAt == null) p.leftAt = this.endedAt;
    }

    // Manual 購読は自動終了しないので、ここで明示的に閉じてストリームを flush させる。
    for (const stream of this.subscriptions.values()) {
      stream.destroy();
    }

    // 進行中のストリーム書き込み完了を待つ
    await Promise.allSettled([...this.pendingPipelines]);

    // 発話中のまま stop された区間を確定する(bytes は flush 完了後の最終値)
    for (const st of this.trackStates.values()) {
      if (st.current) {
        st.utterances.push({ ...st.current, endedAt: this.endedAt, byteEnd: st.bytes });
        st.current = null;
      }
    }

    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    this.status = 'stopped';
    return this._summary();
  }

  /** 録音されたトラックファイル一覧(空でないもの)を集める。 */
  async listTracks() {
    let files = [];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const tracks = [];
    for (const f of files) {
      if (!f.endsWith('.pcm')) continue;
      const userId = f.replace(/\.pcm$/, '');
      const full = join(this.dir, f);
      const { size } = await stat(full);
      if (size === 0) continue; // 無音/未取得は除外
      const durationSec = size / (PCM_FORMAT.sampleRate * PCM_FORMAT.channels * (PCM_FORMAT.bitsPerSample / 8));
      tracks.push({
        userId,
        displayName: this.participants.get(userId)?.displayName ?? userId,
        pcmPath: full,
        bytes: size,
        durationSec: Math.round(durationSec),
        // 発話区間(実時刻+PCM内バイト位置)。pipeline が時系列議事録の構築に使う
        utterances: this.trackStates.get(userId)?.utterances ?? [],
      });
    }
    return tracks;
  }

  _summary() {
    return {
      id: this.id,
      guildId: this.guildId,
      channelId: this.channelId,
      channelName: this.channelName,
      startedByUserId: this.startedByUserId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      dir: this.dir,
      participants: [...this.participants.values()],
    };
  }
}

/**
 * ギルド×チャンネル単位でセッションを管理するレジストリ。
 * MVP では「1 ギルドにつき同時 1 セッション」を基本とする。
 */
export class SessionManager {
  constructor({ client, baseDir }) {
    this.client = client;
    this.baseDir = baseDir;
    /** @type {Map<string, RecordingSession>} guildId -> session */
    this.byGuild = new Map();
  }

  get(guildId) {
    return this.byGuild.get(guildId);
  }

  async start({ guildId, channelId, startedByUserId, resolveName }) {
    if (this.byGuild.has(guildId)) {
      throw new Error('このサーバーでは既に録音中です。先に /rec stop してください。');
    }
    const session = new RecordingSession({
      client: this.client,
      guildId,
      channelId,
      startedByUserId,
      baseDir: this.baseDir,
      resolveName,
    });
    this.byGuild.set(guildId, session);
    try {
      await session.start();
    } catch (err) {
      this.byGuild.delete(guildId);
      throw err;
    }
    return session;
  }

  async stop(guildId) {
    const session = this.byGuild.get(guildId);
    if (!session) throw new Error('このサーバーで進行中の録音はありません。');
    const summary = await session.stop();
    const tracks = await session.listTracks();
    this.byGuild.delete(guildId);
    return { summary, tracks, session };
  }

  /** どの VC で録音中かに関わらず、ギルド内の voiceStateUpdate を該当セッションへ流す。 */
  routeVoiceState(oldState, newState) {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    const session = this.byGuild.get(guildId);
    session?.handleVoiceStateUpdate(oldState, newState);
  }
}
