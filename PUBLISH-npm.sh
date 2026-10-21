#!/usr/bin/env bash
# Публикация пакета на npm.
#
#   ./PUBLISH-npm.sh             # npm publish (запускает prepublishOnly)
#   ./PUBLISH-npm.sh --dry-run   # показать, что уйдёт, ничего не публикуя
#
# Токен (классический Automation или Granular с правом publish на пакет) живёт
# в сторе DSH: ~/.dsh/.credentials.yaml, ключ NPM_TOKEN. Здесь он попадает во
# временный npmrc (0600, удаляется по выходу), поэтому в ~/.npmrc, в .git/config
# и в истории shell он не остаётся.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"
echo "пакет:   $NAME@$VERSION"
echo "git:     $(git rev-parse --abbrev-ref HEAD) $(git rev-parse --short HEAD)$(git diff --quiet || echo ' (грязное дерево)')"

TOKEN="$(python3 - <<'PY'
import yaml, pathlib
p = pathlib.Path.home() / '.dsh' / '.credentials.yaml'
refs = (yaml.safe_load(p.read_text()) or {}).get('refs') or {}
print(refs.get('NPM_TOKEN') or '')
PY
)"
if [ -z "$TOKEN" ]; then
  echo "нет NPM_TOKEN в ~/.dsh/.credentials.yaml" >&2
  exit 1
fi

TMPRC="$(mktemp /tmp/npmrc-XXXXXX)"
chmod 600 "$TMPRC"
cleanup() { rm -f "$TMPRC"; }
trap cleanup EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" >"$TMPRC"

echo "аккаунт: $(npm whoami --userconfig "$TMPRC")"

if [ "${1:-}" = "--dry-run" ]; then
  npm publish --dry-run --userconfig "$TMPRC"
  exit 0
fi

npm publish --userconfig "$TMPRC" "$@"

echo
echo "готово: https://www.npmjs.com/package/$NAME/v/$VERSION"
echo "проверить: npm view $NAME version dist.integrity"
