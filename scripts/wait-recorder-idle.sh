#!/usr/bin/env bash
# 自動デプロイ用: recorder が録音中・文字起こし中でなくなるまで待つ。
#   使い方: wait-recorder-idle.sh <fly-app> [最大待ち秒数=10800]
#   必要: flyctl、GNU timeout、FLY_API_TOKEN(アプリ限定のデプロイトークン)
#
# 判定は recorder が書き出す /tmp/recorder-busy.json(src/busy.ts)。
# このファイルを書かない旧版が動いている場合(この仕組みを入れた最初のデプロイ)は、
# 録音ディレクトリのファイルを開いているプロセスがあるか、直近 15 分に書き込みがあれば busy とみなす。
set -euo pipefail

app="${1:?fly app name}"
max="${2:-10800}"
interval=60
deadline=$(( $(date +%s) + max ))

probe() {
  # shellcheck disable=SC2016 # remote shell expands these, not this one
  timeout 90 flyctl ssh console -a "$app" -q -C 'sh -c '"'"'
    if [ -f /tmp/recorder-busy.json ]; then cat /tmp/recorder-busy.json
    else
      d="${RECORDINGS_DIR:-/data/recordings}"
      open=$(ls -l /proc/[0-9]*/fd 2>/dev/null | grep -c -- "-> $d/" || true)
      recent=$(find "$d" -newermt "-15 minutes" 2>/dev/null | wc -l)
      echo "{\"legacy\":true,\"open\":$open,\"recent\":$recent}"
    fi
  '"'"''
}

while :; do
  # flyctl のエラー(認証失敗・アプリ名違いなど)は隠さずログに出す。
  if out=$(probe); then
    line=$(printf '%s\n' "$out" | grep '^{' | tail -1 || true)
    if [ -n "$line" ] && echo "$line" | jq -e '
        if .legacy then (.open == 0 and .recent == 0) else (.sessions == 0 and .pipelines == 0) end' >/dev/null; then
      echo "idle: $line"
      exit 0
    fi
    echo "busy: ${line:-<no state in output>}"
  else
    echo "probe failed (see flyctl output above)"
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "recorder stayed busy for ${max}s; not deploying" >&2
    exit 1
  fi
  sleep "$interval"
done
