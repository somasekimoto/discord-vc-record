# discord-vc-record

Discord VCの会話を録音・日本語文字起こしし、WebUIで「録音されたサーバーで特定ロールを持つメンバーのみ」が閲覧・ダウンロードできるBot（MVP）。

## アーキテクチャ

| 層 | 技術 | 置き場所 |
|---|---|---|
| 録音Bot（UDP常駐・話者別トラック） | Node.js + `@discordjs/voice` + `@snazzah/davey`（DAVE/E2EE対応） | Fly.io（常駐） |
| STT（録音終了後にまとめて） | プロバイダ抽象化。既定 OpenAI `gpt-4o-transcribe`、`STT_PROVIDER` で切替 | 録音Botから呼ぶ |
| 保管 / DB / WebUI / 認証 | Cloudflare R2 / D1 / Workers・Pages / Discord OAuth2 | Cloudflare |

録音（Discord VCへのUDP常駐受信）はサーバーレスでは不可能なため、録音だけ常駐ホスト、それ以外はエッジ、という構成。

## ディレクトリ

```
recorder/   録音Bot（Fly.io）
web/        WebUI + 認証 + 配信（Cloudflare）
```

## 開発をはじめる前に（秘密情報の誤コミット防止）

```bash
sh scripts/setup-hooks.sh   # gitleaks による pre-commit / pre-push を有効化
# gitleaks 未導入なら: brew install gitleaks
```

実値を含む設定は `*.example` をコピーして使う（`wrangler.toml` / `fly.toml` / `.env` は gitignore 済み）。

## パッケージマネージャは pnpm（サプライチェーン攻撃対策）

**`npm install` は使わない。** 防御設定が `pnpm-workspace.yaml` にあり、npm ではまるごと無効になる。

```bash
corepack enable   # package.json の packageManager 指定の pnpm が自動で使われる
```

`recorder/` と `web/` はそれぞれ独立した pnpm プロジェクト（lockfile も別）。効いている防御は2つ:

| 設定 | 効果 |
|---|---|
| `allowBuilds` | 依存の install/postinstall スクリプトを既定で拒否し、明示許可したものだけ実行する |
| `minimumReleaseAge: 10080` | 公開から7日未満のバージョンを解決しない（単位は**分**。`7` と書くと7分になる） |

依存を追加して `ERR_PNPM_IGNORED_BUILDS` が出たら、そのパッケージがなぜビルドを要るのか確認したうえで `pnpm-workspace.yaml` の `allowBuilds` に追記する（`dangerouslyAllowAllBuilds` は使わない）。**`@discordjs/opus` の許可を外すと録音が壊れる。**

急ぎで7日未満の版が必要なときだけ `pnpm add <pkg> --allow-any-release-age`。

## recorder のセットアップ

```bash
cd recorder
pnpm install
cp .env.example .env   # 値を埋める
pnpm run register      # スラッシュコマンドをDiscordへ登録
pnpm run start         # Bot起動
```

### 必要な環境変数（`recorder/.env`）

| 変数 | 用途 |
|---|---|
| `DISCORD_TOKEN` | Bot トークン |
| `DISCORD_CLIENT_ID` | Application ID（コマンド登録用） |
| `GUILD_ID` | テスト用ギルドID（即時登録／省略でグローバル） |
| `OPENAI_API_KEY` | STT（gpt-4o-transcribe） |
| `STT_PROVIDER` | `openai`（既定）。将来 `local`（faster-whisper） |
| `RECORD_PROMPT_CHANNEL_IDS` | 入室時に録音開始を促すVCのID（カンマ区切りで複数可、任意） |
| `RECORDINGS_RETENTION_DAYS` | ローカル録音データの保持日数（既定 `14`、`0` で自動削除を無効） |

## コマンド

- `/rec start` — 自分が今いるVCの録音を開始
- `/rec stop` — 録音終了 → 文字起こし
- `/rec status` — 録音状況
- `/setup role:<ロール>` — 閲覧を許可するロールを設定（管理者のみ）

`RECORD_PROMPT_CHANNEL_IDS` を設定すると、対象VCに最初の1人が入室したときにVC内チャットへ録音開始を促すメッセージを投稿する（録音中はスキップ、同一VCへの再通知は5分クールダウン）。Botに対象VCへの「メッセージ送信」権限が必要。

このメッセージには「録音を開始」ボタンが付き、`/rec start` を打たずに録音を始められる（開始処理はコマンド経路と共通）。押した人がVCにいない・ボタンとは別のVCにいる・既に録音中の場合は開始せず、本人にだけ見えるメッセージで理由を返す。

- 「最初の1人」判定は voiceStates ベースの best-effort。member 未解決の在室者は人間扱いし、誤通知より通知抑制に倒す
- 設定が env var なのは、recorder が D1 を読むパスを持たない現状での MVP 判断。ギルド管理者がセルフサービスで変えたくなったら `/setup` → D1 への移行を検討

## 録音データのディスク運用

録音データは Fly ボリューム（`fly.toml` の `[mounts]`、10GB）に置く。**ボリュームが満杯になると録音が一切開始できなくなる**（`ENOSPC`）ため、2段構えで自動削除する。

| 対象 | いつ消えるか | 理由 |
|---|---|---|
| `<userId>.pcm` | web へのアップロード成功直後 | wav 生成の中間物。以後どこからも参照しない |
| セッションディレクトリ全体 | `RECORDINGS_RETENTION_DAYS` 経過後 | 正本は R2 側。ローカルは復旧用の控え |

- 1セッションあたり 800MB〜1.2GB 程度を消費する（3人・1時間の実績値）
- アップロードに**失敗した場合は PCM を残す**。wav を作り直せないと `reupload.js` での復旧手段まで失うため
- 保持期間は `reupload.js` で復旧できる期間とのトレードオフ。既定 14 日は「アップロード失敗に気づいて復旧するには十分」という想定
- 録音中のセッションは保持期間を過ぎていても削除しない
- 掃除の失敗は録音・文字起こしを巻き込まない（ログに残して続行する）
- 録音開始時に空き容量を確認し、1.5GB を切っていたら警告を出す。**開始はブロックしない**（会議を録れない方が損失が大きいため、判断はユーザーに委ねる）

満杯になってしまった場合の応急処置（アップロード済みなら PCM は消してよい）:

```bash
flyctl ssh console -C "sh -c 'rm -f /data/recordings/*/*.pcm && df -h /data'"
```

## web のセットアップ（Cloudflare）

web の開発・テストは **Node >=22.18.0**。Worker は Wrangler がバンドルし、`.mts` テストは Node 標準の型ストリッピングで実行する（`tsc` は検査のみ）。

既存の実 `web/wrangler.toml` はこの移行で上書きしない。更新時は変更内容を確認・承認したうえで **`main = "src/index.js"` を `main = "src/index.ts"` に手動変更**し、他の設定値は維持する。新規設定は `web/wrangler.toml.example` を使う。

```bash
cd web
pnpm install
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create <your-bucket>
pnpm exec wrangler d1 create <your-db>          # 出力された database_id を wrangler.toml に設定
pnpm exec wrangler d1 execute <your-db> --remote --file=schema.sql
# secrets:
pnpm exec wrangler secret put SESSION_SECRET    # ランダムな32バイトhex等
pnpm exec wrangler secret put INGEST_SECRET     # recorder と同じ値
pnpm exec wrangler secret put DISCORD_CLIENT_ID
pnpm exec wrangler secret put DISCORD_CLIENT_SECRET
pnpm run deploy                                 # 出力された workers.dev URL を WEB_BASE_URL に設定
```

`wrangler.toml` の `database_id` と `WEB_BASE_URL` は自分の値に置き換える。
Discord 側で OAuth2 リダイレクト URI に `<WEB_BASE_URL>/callback` を登録する。

### web の秘密情報なしのローカル検証

```bash
cd web
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm exec wrangler d1 execute vc-record --config wrangler.ci.toml --local --file=schema.sql
pnpm exec wrangler dev --config wrangler.ci.toml --port 8788 --var INGEST_SECRET:smoke-test-secret
# 別ターミナルの web/ で実行。終了後は上のdevをCtrl-Cで停止:
SMOKE_BIG=1 node test/smoke.mts
pnpm exec wrangler deploy --config wrangler.ci.toml --dry-run
```

`wrangler.ci.toml` は公開ダミー設定で、型生成/ローカル検証専用。本番deployには使用しない。`pnpm run dev` / `deploy` は従来通り実設定を使う。
型生成される `worker-configuration.d.ts` は非追跡、secretは名前だけ `src/env.d.ts` で補足する。`pnpm test` は空きポートと専用の一時D1/R2保存先を自動確保し、終了時に破棄する。テストの境界・既存契約の注意点は [web/TESTING.md](web/TESTING.md) を参照。

## デプロイ

```bash
# recorder (Fly.io)
cd recorder
flyctl apps create <your-app>
flyctl secrets set DISCORD_TOKEN=... OPENAI_API_KEY=... INGEST_SECRET=... WEB_BASE_URL=... --app <your-app>

# 録音/中間ファイル用の永続ボリューム（fly.toml の [mounts] source と一致させる）。
# これが無いと VM 再起動(OOM・再デプロイ)で長尺録音が丸ごと消える。
flyctl volumes create vc_data --region nrt --size 10 --app <your-app>

flyctl deploy --ha=false --app <your-app>
```

> ⚠ recorder は **単一インスタンス必須**（`--ha=false`）。複数だと同じVCを二重録音する。

> ⚠ メモリは **2GB 以上**（`fly.toml` の `[[vm]] memory = "2048mb"`）。1〜2時間の録音は
> stop 後の wav 化 + STT で 512MB を超え、OOM Kill されて文字起こしが生成されない。
> 既存アプリのメモリだけ上げるなら: `flyctl scale memory 2048 --app <your-app>`
