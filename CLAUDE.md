# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Discord VC を録音・日本語文字起こしし、ロール保有者だけが WebUI で閲覧できる Bot（MVP）。ドキュメント・コメントは日本語で書く。

## 構成（2つの独立したデプロイ物）

- **`recorder/`** — 録音 Bot（Node.js 22+, Fly.io 常駐）。Discord VC への UDP 常駐受信はサーバーレス不可のため、ここだけ常駐ホスト。
- **`web/`** — WebUI + 認証 + 取り込み（Cloudflare Workers + R2 + D1）。

データフロー: recorder が話者別に PCM 録音 → `/rec stop` で `pipeline.js` が wav 化・STT・時系列マージ・全体ミックス生成（`mix.js`、発話区間を実時刻に配置した `mixed.m4a`）→ `upload.js` が web の `/ingest` へ POST（メタ+transcript）、音声（話者別 wav + `userId=mixed` のミックス）は R2 マルチパート（`/ingest/audio/init|part|complete|abort`）で分割アップロード → web が D1/R2 から配信。

## コマンド

### recorder（`cd recorder`）

```bash
pnpm test                                 # 全テスト（node:test。統合テストは ffmpeg 必須）
node --test test/pipeline-unit.test.mjs   # 単一テストファイル
pnpm run register                         # スラッシュコマンドを Discord へ登録
pnpm run start                            # Bot 起動（.env 必要）
node src/reupload.js <sessionId>          # アップロードだけ失敗したセッションの復旧
```

### web（`cd web`）

```bash
pnpm run dev                              # wrangler dev（ローカル D1/R2 エミュレーション）
pnpm run deploy                           # wrangler deploy
pnpm exec wrangler d1 execute <db> --local --file=schema.sql   # ローカル D1 にスキーマ適用
node test/smoke.mjs                       # 取り込みフロー E2E（wrangler dev :8788 を先に起動。SMOKE_BIG=1 で 105MiB 分割も検証）
```

## アーキテクチャ上の重要な不変条件

- **時系列の根拠は recorder の utterances のみ**。PCM は発話部分だけ連結され無音が潰れているため、STT のタイムスタンプから実時刻は復元できない。`pipeline.js` は recorder が記録した発話区間（実時刻+PCM内バイト位置）で wav を切り出して区間単位で STT する（話者誤帰属も防ぐ）。
- **recorder は単一インスタンス必須**（`flyctl deploy --ha=false`）。複数だと同じ VC を二重録音する。メモリは 2GB 以上（wav 化+STT で 512MB を超え OOM する）。録音データは Fly ボリューム（`fly.toml` の `[mounts]`）に置く。
- **ボリュームが満杯になると録音が開始できなくなる**（`ENOSPC`、stop 後の pipeline 途中でも起きて文字起こしを失う）。`cleanup.js` が2段構えで削除する: アップロード成功直後に中間物の PCM を消し、`RECORDINGS_RETENTION_DAYS`（既定14日、`0` で無効）を過ぎたセッションを丸ごと消す。**アップロード失敗時は PCM を残す**（wav を作り直せないと `reupload.js` での復旧手段まで失うため）。掃除の失敗は録音・文字起こしを巻き込まない。
- **`/ingest/audio/complete` は冪等**。recorder はレスポンス喪失時に complete をリトライするため、完了済みでもオブジェクトが存在すれば 200 を返す。
- **認可は毎リクエスト Discord に問い合わせ**（`web/src/authz.js`）。ギルドの `required_role_id`（D1 `guild_config`、`/setup` で設定）の保有を確認する。
- **STT はプロバイダ抽象化**（`recorder/src/stt/index.js`）。`pipeline.js` は `transcribe()` だけを呼ぶ。プロバイダ追加 = ファイル1枚 + 分岐1行。既定は OpenAI `gpt-4o-transcribe`、`STT_PROVIDER` で切替。
- 入室プロンプト（`join-prompt.js`）の「最初の1人」判定は voiceStates ベースの best-effort。member 未解決の在室者は人間扱いし、誤通知より通知抑制に倒す。プロンプトの「録音を開始」ボタン（`customId` は `recstart:<channelId>`）と `/rec start` は `index.js` の `startSession` を共有する。二重開始の排他は `SessionManager.start` の `byGuild` 登録が担保（後着は throw）。
- 自動停止（`auto-stop.js`）の無人判定も同じく voiceStates ベース。member 未解決の在室者は人間扱いし、会議中の誤停止より停止抑制に倒す。停止経路（自動/ボタン/`/rec stop`）は競合しうるため `index.js` の `stopSessionSafe` で冪等化している。

- **パッケージマネージャは pnpm 固定**（`packageManager` で版も固定、`npm install` は使わない）。サプライチェーン攻撃対策の設定が `pnpm-workspace.yaml` にあり、npm ではその防御が丸ごと無効になるため。recorder / web はそれぞれ独立した pnpm プロジェクト（lockfile も別）で、単一 workspace にはまとめていない — 別々のデプロイ物で依存も交わらず、統合すると web の依存更新が recorder の Docker レイヤキャッシュを壊すため。
- **ビルドスクリプトはホワイトリスト方式**（pnpm 11 の既定で拒否）。`pnpm-workspace.yaml` の `allowBuilds` に書いたパッケージだけが実行を許される。**`@discordjs/opus` の許可を外すと録音が壊れる**（node-gyp のネイティブビルドが必須）。依存追加時に `ERR_PNPM_IGNORED_BUILDS` が出たら、中身を確認したうえで `allowBuilds` に追記する。`dangerouslyAllowAllBuilds` は使わない。Dockerfile は install 前に `pnpm-workspace.yaml` を COPY すること（無いとビルドが拒否され録音不能なイメージができる）。
- **`minimumReleaseAge: 10080`（7日、単位は分）で新しすぎるリリースを掴まない**。汚染パッケージは公開から数時間〜1日で発見・削除されることが多いため猶予を置く。pnpm 11 でもこれは既定で無効なので明示指定が必要（`7` と書くと7分になる）。緊急時は `pnpm add <pkg> --allow-any-release-age` で個別に回避する。

## 秘密情報・設定ファイル

- `wrangler.toml` / `fly.toml` / `.env` は実値を含むため gitignore 済み。`*.example` をコピーして使う。実値は絶対にコミットしない。
- 初回に `sh scripts/setup-hooks.sh` で gitleaks の pre-commit / pre-push を有効化（CI にも gitleaks あり）。
- recorder と web は `INGEST_SECRET`（共有シークレット、Bearer）で認証する。

## デプロイ方針

本番デプロイは **マージ後の main からのみ**。未マージブランチからのデプロイは禁止。

## CI（`.github/workflows/`）

- `recorder-test.yml` — recorder のテスト（ffmpeg をインストールして `pnpm test`）
- `smoke.yml` — web の取り込みフロー E2E（CI 用の最小 `wrangler.toml` を生成してローカルモードで実行）
- `gitleaks.yml` — シークレットスキャン
