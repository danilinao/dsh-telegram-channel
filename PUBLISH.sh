#!/usr/bin/env bash
# Публикация форка в собственный репозиторий на GitHub.
#
#   ./PUBLISH.sh                 # push master + теги в origin
#   ./PUBLISH.sh --dry-run       # только показать, что уйдёт
#
# Токен берётся из стора DSH (~/.dsh/.credentials.yaml, ключ GITHUB_TOKEN) и
# передаётся git через GIT_ASKPASS, поэтому в .git/config, в истории shell и в
# командной строке он не остаётся. Нужен токен с правом записи в репозиторий
# (fine-grained: Contents: read/write; классический: scope repo).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

REMOTE="${REMOTE:-origin}"
URL="$(git remote get-url "$REMOTE")"
echo "репозиторий: $URL"
echo "ветка:       $(git rev-parse --abbrev-ref HEAD)"
echo "коммиты:"
git log --oneline -3 | sed 's/^/  /'
echo "теги:        $(git tag -l 'ru-*' | tr '\n' ' ')"

if [ "${1:-}" = "--dry-run" ]; then
  echo "(dry-run) git push --dry-run $REMOTE HEAD --tags"
  GIT_TERMINAL_PROMPT=0 git push --dry-run "$REMOTE" HEAD --tags || true
  exit 0
fi

TOKEN="$(python3 - <<'PY'
import yaml, pathlib
p = pathlib.Path.home() / '.dsh' / '.credentials.yaml'
refs = (yaml.safe_load(p.read_text()) or {}).get('refs') or {}
print(refs.get('GITHUB_TOKEN') or '')
PY
)"
if [ -z "$TOKEN" ]; then
  echo "нет GITHUB_TOKEN в ~/.dsh/.credentials.yaml" >&2
  exit 1
fi

ASKPASS="$(mktemp /tmp/git-askpass-XXXXXX.sh)"
chmod 700 "$ASKPASS"
cleanup() { rm -f "$ASKPASS"; }
trap cleanup EXIT

# Имя пользователя уходит в URL без секрета, пароль отдаёт askpass.
cat >"$ASKPASS" <<'SH'
#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) printf '%s\n' "$GITHUB_TOKEN" ;;
esac
SH

git remote set-url "$REMOTE" "$(echo "$URL" | sed 's#https://[^@/]*@#https://#')"
GITHUB_TOKEN="$TOKEN" GIT_ASKPASS="$ASKPASS" GIT_TERMINAL_PROMPT=0 \
  git push "$REMOTE" HEAD --tags

echo "готово: $(git remote get-url "$REMOTE")"
