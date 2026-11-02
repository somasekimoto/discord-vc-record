import { defineConfig } from 'vitest/config';

// test: HTTP 回帰(pnpm test)。contract: recorder → Worker の契約テスト(pnpm run test:contract)。
// どちらも Wrangler 子プロセスを起動するので、package.json の scripts で --project を指定して別々に実行する。
export default defineConfig({
  test: {
    pool: 'forks',
    // node:test には既定のタイムアウトが無かった。Wrangler の起動待ちと 40MiB 超のアップロードを打ち切らない長さにする。
    testTimeout: 60_000,
    hookTimeout: 120_000,
    projects: [
      { extends: true, test: { name: 'test', include: ['test/*.test.mts'] } },
      { extends: true, test: { name: 'contract', include: ['test/recorder-contract.mts'] } },
    ],
  },
});
