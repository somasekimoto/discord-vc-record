# recorder (Discord 録音Bot) — Fly.io 常駐コンテナ
# ネイティブモジュール(@discordjs/opus, @snazzah/davey)のビルドに toolchain が要る。
# 文字起こしの ffmpeg も同梱する。
FROM node:22-bookworm-slim

# ネイティブビルド用ツール + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# pnpm は package.json の packageManager 指定に従って corepack が用意する。
RUN corepack enable

# 依存だけ先にインストール（レイヤキャッシュ）。
# pnpm-workspace.yaml には allowBuilds（ビルド許可リスト）が入っており、
# これが無いと @discordjs/opus のネイティブビルドが拒否されて録音が壊れる。必ず一緒にコピーする。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# アプリ本体
COPY src ./src

# 録音/中間ファイル置き場。本番では fly.toml の [mounts] で永続ボリュームを
# /data にマウントし RECORDINGS_DIR=/data/recordings を渡す(VM再起動で揮発させない)。
# 下記はボリューム未マウント時のフォールバック既定値。
ENV RECORDINGS_DIR=/data/recordings
RUN mkdir -p /data/recordings

# Bot は HTTP を待ち受けない（Gateway 常駐）。
CMD ["node", "src/index.js"]
