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

## recorder のセットアップ

```bash
cd recorder
npm install
cp .env.example .env   # 値を埋める
npm run register       # スラッシュコマンドをDiscordへ登録
npm run start          # Bot起動
```

### 必要な環境変数（`recorder/.env`）

| 変数 | 用途 |
|---|---|
| `DISCORD_TOKEN` | Bot トークン |
| `DISCORD_CLIENT_ID` | Application ID（コマンド登録用） |
| `GUILD_ID` | テスト用ギルドID（即時登録／省略でグローバル） |
| `OPENAI_API_KEY` | STT（gpt-4o-transcribe） |
| `STT_PROVIDER` | `openai`（既定）。将来 `local`（faster-whisper） |

## コマンド

- `/rec start` — 自分が今いるVCの録音を開始
- `/rec stop` — 録音終了 → 文字起こし
- `/rec status` — 録音状況
- `/setup role:<ロール>` — 閲覧を許可するロールを設定（管理者のみ）

## web のセットアップ（Cloudflare）

```bash
cd web
npm install
npx wrangler login
npx wrangler r2 bucket create <your-bucket>
npx wrangler d1 create <your-db>          # 出力された database_id を wrangler.toml に設定
npx wrangler d1 execute <your-db> --remote --file=schema.sql
# secrets:
npx wrangler secret put SESSION_SECRET    # ランダムな32バイトhex等
npx wrangler secret put INGEST_SECRET     # recorder と同じ値
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npm run deploy                            # 出力された workers.dev URL を WEB_BASE_URL に設定
```

`wrangler.toml` の `database_id` と `WEB_BASE_URL` は自分の値に置き換える。
Discord 側で OAuth2 リダイレクト URI に `<WEB_BASE_URL>/callback` を登録する。

## デプロイ

```bash
# recorder (Fly.io)
cd recorder
flyctl apps create <your-app>
flyctl secrets set DISCORD_TOKEN=... OPENAI_API_KEY=... INGEST_SECRET=... WEB_BASE_URL=... --app <your-app>
flyctl deploy --ha=false --app <your-app>
```

> ⚠ recorder は **単一インスタンス必須**（`--ha=false`）。複数だと同じVCを二重録音する。
