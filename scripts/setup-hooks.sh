#!/bin/sh
# リポのフックを有効化する。クローン後に一度実行: sh scripts/setup-hooks.sh
git config core.hooksPath .githooks
echo "✅ git hooks 有効化(core.hooksPath=.githooks)。gitleaks 未導入なら 'brew install gitleaks' を。"
