# recorder (Discord 録音Bot) — Fly.io 常駐コンテナ
# ネイティブモジュール(@discordjs/opus, @snazzah/davey)のビルドに toolchain が要る。
# 文字起こしの ffmpeg も同梱する。
FROM node:22-bookworm-slim

# ネイティブビルド用ツール + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依存だけ先にインストール（レイヤキャッシュ）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# アプリ本体
COPY src ./src

# 録音の一時ファイル置き場（R2 アップロード後は不要、永続化しない）
ENV RECORDINGS_DIR=/tmp/recordings
RUN mkdir -p /tmp/recordings

# Bot は HTTP を待ち受けない（Gateway 常駐）。
CMD ["node", "src/index.js"]
