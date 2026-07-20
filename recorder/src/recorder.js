/**
 * recorder.js — 録音セッション管理と話者別トラック録音
 *
 * Phase 0 のスパイクで実証した「speaking 検知 → per-user subscribe → opus decode → PCM 追記」
 * パターンを、複数話者・セッション・participants 記録に拡張したもの。
 *
 * Phase 1 ではローカル FS への PCM 保存までを担当する。
 * R2/D1 アップロードと STT は pipeline.js (Phase 2) が録音終了後に処理する。
 */
import { createWriteStream, statSync } from 'node:fs';
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

// ストリームエラー後の自動再購読の初回待ち時間。opus 10 フレーム(20ms×10)分で、
// 瞬間的な復号失敗をやり過ごしつつ、発話中の取りこぼしを最小に抑える値。
// 失敗が続く間(長引く DAVE 再ネゴ等)は指数バックオフで最大値まで伸ばし、
// 購読→即死→再購読のループがログを埋めないようにする。
export const RESUBSCRIBE_DELAY_MS = 200;
export const RESUBSCRIBE_DELAY_MAX_MS = 5_000;

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
   * @param {string} [opts.notifyChannelId] /rec start が打たれたテキストチャンネル(自動停止の通知先)
   * @param {(id:string)=>string} [opts.resolveName] userId -> 表示名
   */
  constructor({ client, guildId, channelId, startedByUserId, baseDir, notifyChannelId, resolveName }) {
    this.client = client;
    this.guildId = guildId;
    this.channelId = channelId;
    this.startedByUserId = startedByUserId;
    this.notifyChannelId = notifyChannelId ?? null;
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
   * 重要: 1ユーザーにつき購読は **同時に1つだけ**。
   * EndBehaviorType.Manual で stop まで開けっ放しにする。
   * AfterSilence で発話ごとに購読を切ると、再購読のたびに先頭が欠け、
   * 会話全体で大量の取りこぼしが起きる(=文字起こしが極端に短くなる)ため。
   *
   * ただしストリームがエラー終了した場合(DAVE 遷移中の復号失敗が opus デコード
   * エラーになる等)は例外で、次の speaking start で再購読して録音を継続する。
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
    const pcmPath = join(this.dir, `${userId}.pcm`);

    // 書き込み済みバイト数を発話区間の根拠として数える。
    // decoder の出力はフレーム単位(サンプル境界)なので bytes は常にフレーム境界に揃う。
    // エラー後の再購読では既存 state を引き継ぐ。PCM は追記(flags:'a')なので、
    // bytes を 0 に戻すと過去の utterances のバイト位置が壊れる。
    let st = this.trackStates.get(userId);
    if (!st) {
      st = { bytes: 0, utterances: [], current: null, streamErrors: 0 };
      this.trackStates.set(userId, st);
    } else {
      // エラー destroy では書き込みストリームの内部バッファ(最大数十ms分)が
      // 未書き込みのまま捨てられ、st.bytes が実ファイルサイズより先行しうる。
      // バイト位置は時系列議事録の唯一の根拠なので、追記を再開する前に
      // 実ファイルサイズへ再同期してズレが以降の全区間へ累積するのを防ぐ。
      try {
        st.bytes = statSync(pcmPath).size;
      } catch {
        st.bytes = 0; // 1 バイトも書かれる前に死んだ場合はファイル未作成
      }
    }
    const out = createWriteStream(pcmPath, { flags: 'a' });
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        st.bytes += chunk.length;
        st.streamErrors = 0; // データが流れた = 復号は回復している
        cb(null, chunk);
      },
    });

    // 後で stop() から明示的に終了できるよう保持
    this.subscriptions.set(userId, opusStream);

    const p = pipeline(opusStream, decoder, counter, out)
      .catch((err) => {
        console.error(`[recorder] stream error user=${userId}: ${err.message}`);
        if (this.status !== 'recording') return; // stop() による destroy は失敗扱いしない
        st.streamErrors += 1;
        // 発話途中で死んだ場合はここで区間を閉じる。開いたままにすると、復旧までの
        // 無記録ギャップ(PCM 0 バイトの時間)が 1 つの発話区間の中に含まれてしまう。
        // 閉じておけば、ギャップは区間と区間の隙間として時系列に現れる。
        if (st.current) {
          st.utterances.push({ ...st.current, endedAt: Date.now(), byteEnd: st.bytes });
          st.current = null;
        }
      })
      .finally(() => {
        this.pendingPipelines.delete(p);
        if (this.subscriptions.get(userId) === opusStream) this.subscriptions.delete(userId);
        // ここを消さないと、一度ストリームが死んだユーザーはセッション終了まで
        // 二度と録音されない(録音開始前から在室していた人の声が丸ごと欠ける原因)。
        const wasActive = this.activeStreams.delete(userId);
        // 発話バーストの途中でエラー終了した場合、speaking start はバースト境界
        // でしか再発火しないため、本人がまだ喋っていれば自前で再購読する。
        // 連続失敗中は指数バックオフ(最大 RESUBSCRIBE_DELAY_MAX_MS)。
        if (wasActive && this.status === 'recording') {
          const delay = Math.min(
            RESUBSCRIBE_DELAY_MS * 2 ** Math.max(0, st.streamErrors - 1),
            RESUBSCRIBE_DELAY_MAX_MS,
          );
          const t = setTimeout(() => {
            if (this.status === 'recording' && !this.activeStreams.has(userId)
              && this.receiver?.speaking.users.has(userId)) {
              console.log(
                `[recorder] resubscribe user=${userId} (still speaking after stream error, fails=${st.streamErrors})`,
              );
              this._onSpeakingStart(userId);
            }
          }, delay);
          t.unref?.();
        }
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

  async start({ guildId, channelId, startedByUserId, notifyChannelId, resolveName }) {
    if (this.byGuild.has(guildId)) {
      throw new Error('このサーバーでは既に録音中です。先に /rec stop してください。');
    }
    const session = new RecordingSession({
      client: this.client,
      guildId,
      channelId,
      startedByUserId,
      baseDir: this.baseDir,
      notifyChannelId,
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
    // await 前に登録を外す。停止経路(自動停止/ボタン/コマンド)が競合したとき、
    // 後着を「進行中の録音なし」で確実に弾き、pipeline の二重実行を防ぐ。
    // トレードオフ: session.stop() が途中で失敗した場合も登録解除済みのため
    // /rec stop でのリトライはできない(PCM はディスクに残るので手動復旧は可能)。
    this.byGuild.delete(guildId);
    const summary = await session.stop();
    const tracks = await session.listTracks();
    return { summary, tracks, session };
  }

  /** どの VC で録音中かに関わらず、ギルド内の voiceStateUpdate を該当セッションへ流す。 */
  routeVoiceState(oldState, newState) {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    const session = this.byGuild.get(guildId);
    session?.handleVoiceStateUpdate(oldState, newState);
  }
}
