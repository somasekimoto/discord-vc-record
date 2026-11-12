#!/usr/bin/env bash
# 自動デプロイ用: recorder が録音中・文字起こし中でなくなるまで待つ。
#   使い方: wait-recorder-idle.sh <fly-app> [最大待ち秒数=10800]
#   必要: flyctl と FLY_API_TOKEN(アプリ限定のデプロイトークン)
#
# 判定は recorder が書き出す /tmp/recorder-busy.json(src/busy.ts)。
# このファイルを書かない旧版が動いている場合(この仕組みを入れた最初のデプロイ)は、
# 録音ディレクトリに直近 15 分の書き込みがあるかで代わりに判定する。
set -euo pipefail

app="${1:?fly app name}"
max="${2:-10800}"
interval=60
deadline=$(( $(date +%s) + max ))

probe() {
  # shellcheck disable=SC2016 # remote shell expands these, not this one
  flyctl ssh console -a "$app" -q -C 'sh -c '"'"'
    if [ -f /tmp/recorder-busy.json ]; then cat /tmp/recorder-busy.json
    else n=$(find "${RECORDINGS_DIR:-/data/recordings}" -newermt "-15 minutes" 2>/dev/null | wc -l); echo "{\"legacy\":true,\"recent\":$n}"; fi
  '"'"''
}

while :; do
  if out=$(probe 2>/dev/null); then
    line=$(printf '%s\n' "$out" | grep '^{' | tail -1)
    if [ -n "$line" ] && echo "$line" | jq -e '
        if .legacy then .recent == 0 else (.sessions == 0 and .pipelines == 0) end' >/dev/null; then
      echo "idle: $line"
      exit 0
    fi
    echo "busy: ${line:-<no state>}"
  else
    echo "probe failed (machine unreachable?)"
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "recorder stayed busy for ${max}s; not deploying" >&2
    exit 1
  fi
  sleep "$interval"
done
