#!/usr/bin/env python3
"""Проверяет учёт без квот и продолжение паузы в настоящем PTY с временными данными."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('inventory', ROOT / 'scripts/playtest-screen-inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)
base = inventory.base


def wait_until(probe, description):
    until = time.monotonic() + 8
    while time.monotonic() < until:
        if probe():
            return
        time.sleep(0.05)
    raise AssertionError(description)


def run_case(node, root, width, audit, checks):
    root.mkdir()
    workspace, state = base.base.base.configure(root, 9)
    config = root / 'config/harness.json'
    manifest = json.loads(config.read_text())
    manifest.setdefault('limits', {}).update(runTokens=1, dailyTokens=1)
    config.write_text(json.dumps(manifest))
    (config.parent / 'learning.json').write_text(json.dumps(
        {'enabled': True, 'dailyTokens': 1, 'cases': []}))
    fixture = base.Fixture(node, config, state, workspace)
    fixture.call('learning.pause')
    terminal = inventory.Terminal(node, state, workspace, width, 24)
    prefix = str(width) + 'x24/'

    def passed(name):
        checks.append(prefix + name)

    def capture(name, text, usage=False):
        frame = audit.capture(terminal, prefix + name, text, True)
        if usage:
            assert not re.search(r'квот|лимит|добавить|80\s*%|\d+\s*/\s*\d+', frame, re.I), frame
        return frame

    def leave_reader(destination='Чем займёмся?'):
        terminal.send('\x1b')
        terminal.wait_text(destination)

    def open_actions(title):
        terminal.open_label('Мои задачи')
        terminal.wait_text(title)
        terminal.open_label(title)
        terminal.wait_text('Ход задачи')
        terminal.send('\r')
        terminal.wait_text('Что дальше?')

    def budget(run_id):
        value = fixture.call('budget.status', {'runId': run_id})
        assert value['runLimit'] is None and value['dailyLimit'] is None, value
        assert value['warning'] is False, value
        return value

    try:
        capture('main', 'Чем займёмся?')
        first = base.start_task(fixture, workspace, 'Учёт первого запроса')
        wait_until(lambda: budget(first)['runReserved'] > 1, 'Запрос не учтён при старом лимите 1')
        assert fixture.call('runtime.status', {'runId': first})['status'] == 'running'
        terminal.open_label('Настройки')
        terminal.open_label('Расход токенов')
        capture('usage-before-result', 'Провайдер сообщил', True)
        before = budget(first)
        fixture.request('complete', {'runId': first})
        assert fixture.call('runtime.status', {'runId': first})['status'] == 'completed'
        after = budget(first)
        assert after['daily']['reportedTasks'] == before['daily']['reportedTasks'] + 15
        capture('usage-live-result', 'Задачи: 15', True)
        terminal.send('\x1b[F')
        capture('usage-estimate', 'Оценка Harness', True)
        passed('legacy-one-token-limits-do-not-stop-task')
        passed('provider-usage-updates-without-keypress')
        passed('daily-usage-has-no-quota-controls')
        leave_reader()

        open_actions('Учёт первого запроса')
        terminal.open_label('Расход токенов задачи')
        capture('task-usage', 'Всего: 15', True)
        leave_reader('Что дальше?')
        terminal.open_label('В главное меню')
        terminal.wait_text('Чем займёмся?')
        passed('task-usage-has-no-denominator')

        terminal.open_label('Настройки')
        terminal.open_label('Самообучение')
        capture('learning-before', 'Токены сегодня (UTC): 0', True)
        # Число задаёт доверенный владелец fixture; модель и настройки квот его не меняют.
        fixture.request('learning', {'tokens': 4321})
        capture('learning-live', 'Токены сегодня (UTC): 4321', True)
        learning = fixture.call('learning.status')
        assert learning['dailyLimit'] is None and learning['daily']['tokens'] == 4321
        passed('learning-usage-updates-without-quota')
        terminal.open_label('Назад')
        terminal.wait_text('Чем займёмся?')

        paused = base.start_task(fixture, workspace, 'Работа после паузы')
        fixture.request('write', {'runId': paused})
        written = workspace / 'Однократная запись.txt'
        wait_until(lambda: written.exists(), 'Настоящая запись файла не выполнена')
        fixture.request('inventory', {'kind': 'run', 'runId': paused, 'status': 'paused',
                                      'legacyQuota': True})
        record_path = state / 'runs' / (paused + '.json')
        record = json.loads(record_path.read_text())
        writes = [item for item in record['invocations'].values() if item['call']['name'] == 'fs.write']
        assert len(writes) == 1 and writes[0]['status'] == 'succeeded', writes
        original_invocation = writes[0]['id']
        original_time = written.stat().st_mtime_ns
        ledger = budget(paused)
        terminal.open_label('Выход')
        terminal.expect('Сервис продолжает работать')
        terminal.finish()
        terminal.close()
        terminal = None
        fixture.close()

        fixture = base.Fixture(node, config, state, workspace)
        assert budget(paused) == ledger, 'Перезапуск изменил сохранённый учёт'
        assert fixture.call('learning.status')['daily']['tokens'] == 4321
        assert fixture.call('runtime.status', {'runId': paused})['status'] == 'paused'
        terminal = inventory.Terminal(node, state, workspace, width, 24)
        terminal.wait_text('Чем займёмся?')
        open_actions('Работа после паузы')
        capture('paused-after-restart', 'Продолжить после паузы')
        capture('legacy-pause-explained', 'Прежняя квота отключена.')
        terminal.open_label('Продолжить после паузы')
        capture('resumed', 'Ход задачи')
        assert fixture.call('runtime.status', {'runId': paused})['status'] == 'running'
        fixture.request('complete', {'runId': paused})
        capture('resumed-completed', 'Что дальше?')
        assert fixture.call('runtime.status', {'runId': paused})['status'] == 'completed'
        record = json.loads(record_path.read_text())
        writes = [item for item in record['invocations'].values() if item['call']['name'] == 'fs.write']
        assert len(writes) == 1 and writes[0]['id'] == original_invocation, writes
        assert written.read_text() == 'Записано один раз.' and written.stat().st_mtime_ns == original_time
        events = [json.loads(line) for line in (state / 'runs' / (paused + '.jsonl')).read_text().splitlines()]
        assert sum(event['type'] == 'run.resumed' for event in events) == 1, events
        assert sum(event['type'] == 'tool.started' for event in events) == 1, events
        assert budget(paused)['daily']['reportedTasks'] == ledger['daily']['reportedTasks'] + 15
        passed('usage-and-learning-survive-restart')
        passed('paused-task-resumes-through-runtime-resume')
        passed('completed-mutation-is-not-repeated')
        terminal.open_label('В главное меню')
        terminal.wait_text('Чем займёмся?')
        terminal.open_label('Выход')
        terminal.expect('Сервис продолжает работать')
        terminal.finish()
    except Exception:
        if terminal:
            audit.frames[prefix + 'failure'] = terminal.screen()
        raise
    finally:
        if terminal:
            terminal.close()
        fixture.close()
        audit.save_frames()
        assert not (state / 'daemon.lock').exists(), 'Fixture не освободил состояние'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    audit, checks = inventory.Audit('no-quota'), []
    before = inventory.digest(ROOT / 'dist', '.js')
    with tempfile.TemporaryDirectory(prefix='harness-no-quota-') as directory:
        for width in [48, 80]:
            try:
                run_case(node, Path(directory).resolve() / str(width), width, audit, checks)
            except Exception as error:
                audit.failures.append({'width': width, 'reason': str(error)})
                print(width, str(error), flush=True)
    report = {'node': subprocess.check_output([node, '--version']).decode().strip(),
              'distDigest': before, 'distUnchanged': before == inventory.digest(ROOT / 'dist', '.js'),
              'checks': checks, 'coverage': audit.coverage, 'failures': audit.failures}
    (ROOT / 'docs/playtest-no-quota.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'checks': len(checks), 'screens': len(audit.coverage), 'failures': audit.failures}, ensure_ascii=False))
    if audit.failures or not report['distUnchanged']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
