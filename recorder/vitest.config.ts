import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.mts'],
    // ネイティブ Opus(@discordjs/opus) と ffmpeg / node の子プロセスを使うため、worker_threads ではなく子プロセスで分離する。
    pool: 'forks',
    // node:test には既定のタイムアウトが無かった。ffmpeg や子プロセスを待つ統合テストを打ち切らない長さにする。
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
