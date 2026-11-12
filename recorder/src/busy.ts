/**
 * busy.ts — 録音中・文字起こし中かどうかをファイルに書き出す。
 *
 * 自動デプロイ(.github/workflows/deploy.yml)は再起動の前にこのファイルを読み、
 * sessions と pipelines が両方 0 になるまで待つ。再起動すると録音が止まり、
 * 文字起こし途中の pipeline も失われるため。
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

  /** 書き出しの失敗は録音を止めない(ログだけ)。デプロイ側はファイルが古い/無い場合も待つ。 */
  write() {
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.state()));
      renameSync(tmp, this.path);
    } catch (err) {
      console.error('[busy] failed to write state:', err);
    }
  }

  /** pipeline の実行中を数える。成功・失敗どちらでも終了時に減らす。 */
  async trackPipeline<T>(run: () => Promise<T>): Promise<T> {
    this.pipelines += 1;
    this.write();
    try {
      return await run();
    } finally {
      this.pipelines -= 1;
      this.write();
    }
  }
}
