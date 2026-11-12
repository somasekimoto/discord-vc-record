/**
 * busy.ts — 録音中・文字起こし中かどうかをファイルに書き出す。
 *
 * 自動デプロイ(.github/workflows/deploy.yml → scripts/wait-recorder-idle.sh)は再起動の前に
 * このファイルを読み、sessions と pipelines が両方 0 になるまで待つ。再起動すると録音が止まり、
 * 文字起こし途中の pipeline も失われるため。ファイルが無いとき(この仕組みを持たない旧版)は
 * スクリプト側が録音ファイルの開き具合と更新時刻で代わりに判定する。
 * 書き込みは一時ファイル + rename で行い、読み手が途中の内容を見ないようにする。
 */
import { renameSync, writeFileSync } from 'node:fs';

export const DEFAULT_BUSY_FILE = '/tmp/recorder-busy.json';

export interface BusyState {
  sessions: number;
  pipelines: number;
  updatedAt: string;
}

export class BusyTracker {
  declare path: string;
  declare countSessions: () => number;
  declare pipelines: number;
  declare now: () => Date;

  constructor({ path, countSessions, now }: { path: string; countSessions: () => number; now?: () => Date }) {
    this.path = path;
    this.countSessions = countSessions;
    this.pipelines = 0;
    this.now = now ?? (() => new Date());
  }

  state(): BusyState {
    return { sessions: this.countSessions(), pipelines: this.pipelines, updatedAt: this.now().toISOString() };
  }

  /** 書き出しの失敗は録音を止めない(ログだけ)。 */
  write() {
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.state()));
      renameSync(tmp, this.path);
    } catch (err) {
      console.error('[busy] failed to write state:', err);
    }
  }

  /**
   * pipeline を「これから走る」として先に数える。録音停止の直後に呼び、停止から
   * pipeline 開始までの間(Discord への返信など)にデプロイが割り込まないようにする。
   * run() されないまま放置された予約は unclaimedMs 後に自動で解除する(返信の失敗などで
   * pipeline に辿り着かなかった場合に、デプロイを永遠に待たせないため)。
   */
  reserve(unclaimedMs = 5 * 60 * 1000): PipelineReservation {
    this.pipelines += 1;
    this.write();
    let done = false;
    const release = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.pipelines -= 1;
      this.write();
    };
    const timer = setTimeout(release, unclaimedMs);
    timer.unref?.();
    return {
      release,
      run: async <T>(fn: () => Promise<T>): Promise<T> => {
        clearTimeout(timer);
        try {
          return await fn();
        } finally {
          release();
        }
      },
    };
  }

  /** 予約なしで pipeline を数えて実行する。 */
  async trackPipeline<T>(run: () => Promise<T>): Promise<T> {
    return this.reserve().run(run);
  }
}

export interface PipelineReservation {
  /** pipeline を実行し、成功・失敗どちらでも終了時に数を戻す。 */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** pipeline を走らせないと決まったときに数を戻す(2回目以降は何もしない)。 */
  release(): void;
}
