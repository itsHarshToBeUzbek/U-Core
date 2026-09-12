#!/bin/sh
# Прогон всего набора. Гонять целиком, а не только то, что относится к правке:
# связи в этом проекте неочевидные — тест приёмки уже падал из-за изменения
# в popup.js.
#
#   sh tests/run-all.sh
#
# Для сквозных нужен playwright и Chromium. Если браузер лежит не там, где
# его ищет playwright, путь передаётся через CHROME_PATH.

set -e
cd "$(dirname "$0")/.."

fail=0

echo "── под Node ──────────────────────────────────────────"
for t in tests/test-parse.mjs tests/test-names.mjs tests/test-names-llm.mjs; do
  node "$t" || fail=1
done

echo
echo "── в настоящем Chromium ──────────────────────────────"
if python3 -c "import playwright" 2>/dev/null; then
  if command -v xvfb-run >/dev/null 2>&1; then
    xvfb-run -a python3 tests/test-pages.py || fail=1
  else
    python3 tests/test-pages.py || fail=1
  fi
else
  echo "Страницы расширения: ПРОПУЩЕНО (нет playwright)"
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "Всё прошло."
else
  echo "Есть упавшие или пропущенные наборы."
fi
exit "$fail"
