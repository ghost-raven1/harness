#!/bin/sh
cd "$(dirname "$0")" || exit 1
./start.sh "$@"
HARNESS_EXIT=$?
if [ "$HARNESS_EXIT" -ne 0 ] && [ "$HARNESS_EXIT" -ne 130 ]; then
  echo 'Не удалось завершить запуск. Сообщение об ошибке находится выше.'
  printf 'Нажмите Enter, чтобы закрыть окно… '
  read -r HARNESS_ACK
fi
exit "$HARNESS_EXIT"
