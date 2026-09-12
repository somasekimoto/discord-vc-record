# web の型とローカル回帰テスト

## 実行

Node >=22.18.0 と、packageManagerで固定したpnpmを使う。実secret/Cloudflareアカウント不要のfresh checkout/worktreeで検証できる。

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm exec wrangler deploy --config wrangler.ci.toml --dry-run
```

`pnpm test` は `node:test` が空きポートにWrangler子プロセスを起動し、実行ごとの `TEST_RUN_ID` をreadinessで照合してからHTTP回帰を実行する。D1スキーマは `schema.sql` から専用の一時保存先へ適用し、R2も同じ保存先を使う。終了時にプロセスグループを停止して自分の一時ディレクトリだけを破棄する。既存 `.wrangler/state` や並列実行中のfixtureには触れない。smokeは別途指定したローカルdevの保存先を使う。

追加の取り込み検証:

```sh
pnpm exec wrangler d1 execute vc-record --config wrangler.ci.toml --local --file=schema.sql
pnpm exec wrangler dev --config wrangler.ci.toml --port 8788 --var INGEST_SECRET:smoke-test-secret
# 別ターミナル:
SMOKE_BIG=1 node test/smoke.mts
```

105MiBを40MiB + 40MiB + 25MiBに分割する元のsmokeを維持している。テスト相手を変える場合は `SMOKE_BASE_URL` を指定できるが、実サービスには向けない。

## 型の分離

- `wrangler.ci.toml`: 型生成とローカル検証専用の公開ダミー設定。本番deployには使わない。binding名、compatibility_date/flagsはexampleと揃える。
- `worker-configuration.d.ts`: `generate-types` で毎回生成。非追跡。公開varsはliteralではなくstringとして生成し、CIのURLに本番の型を固定しない。
- `src/env.d.ts`: 生成できないsecretの名前だけを補足。値は持たない。
- `tsconfig.json`: Worker全ソースとテスト用Workerをstrict検査。DOM/Node globalsは含めない。
- `tsconfig.test.json`: HTTPテスト、smoke、helperをNode 22の型で独立してstrict検査。Workerの型をimportしない。
- `nodejs_compat` は従来通り維持。ただし現在のWorkerソースにはNode組み込みAPIのimportがないため、Worker側に `@types/node` を重ねない。生成Worker globalsとNode 22.20.1のBlob/URL/Event/Stream等の宣言は衝突する。`skipLibCheck` で隠さず、認証テストもworkerd内で実行して分離する。
- Node標準で消去できる構文だけを使い、emit/tsx/ts-nodeは導入しない。

## テストの境界

`test/worker.ts` は **テスト専用エントリ**。Wrangler CLIのentry引数で回帰テスト時だけ指定する。実設定、example、CI設定、deploy scriptのmainはいずれも `src/index.ts`。テスト専用の `/__test/*` 経路とDiscord stubは本番bundleに入らない。

Discordへのfetchだけをstubにし、予期しない外部リクエストは拒否する。OAuth requestの形、署名/期限切れ/改ざん、scope/state/cookie、上流エラー、role判定とキャッシュを確認する。Request/Crypto/Response/D1/R2は本物のローカルworkerd実装を使い、Node版をWorker版へcastしたfakeは使わない。

一覧/詳細/HTML escape、md/json/話者wav/mixed音声のDL body/Content-Type/Content-Disposition、nullable音声キーをHTTPで検査する。complete後のD1行をSELECTしてキーを直接照合し、再ingest前後でその行が変わらずDLできることも検査する。

## 互換性のため維持した未検証境界

`src/boundaries.ts` の `legacyPayload` は、名前で限定した既存JSON契約への **唯一の型assertion** であり、runtime validationではない。req.json/JSON.parse/fetch.jsonの結果はunknownで受け、この一箇所を通す。

- ingest metaのsessionId/guildId、audioのsessionId/userId/parts等は従来のチェックをそのまま使う。
- その他のmetaフィールド、configのtruthy判定、audioのtruthy uploadId、署名後payloadの形は従来未検証。新しい入力拒否やHTTPコード変更をこの移行では追加しない。
- Discord responseには `discord-api-types/v10` の公式型をtype-onlyで使う。上流JSONのruntime schema検証は追加していない。
- D1のSELECT genericも保存データのruntime validationではない。投影・nullable列は `types.ts` で分ける。

認可キャッシュは既存通りuserId:guildId単位で5分。許可/拒否をキャッシュし、429はキャッシュしない。キャッシュ中にtoken/role設定が変わっても古い判定を使う。拒否ページはHTTP 200、OAuth stateは従来通り戻り先でありCSRF対策ではない。これらの仕様変更は別件とする。

既存の実 `wrangler.toml` は自動更新しない。承認後にmainだけ `src/index.ts` へ手動更新し、実binding/vars/secretは保持する。
