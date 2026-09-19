#!/usr/bin/env python3
"""Проверяет ядро 0.3.0 через два настоящих PTY и отдельного владельца тестового состояния."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('core_inventory', ROOT / 'scripts/playtest-screen-inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)
live = inventory.base
Terminal, Fixture = inventory.Terminal, live.Fixture
SIZES = [(48, 24), (80, 24)]
PRIVATE_TASK = 'PRIVATE_CORE_TASK_84a9e39d'
PRIVATE_KEY = 'PRIVATE_CORE_KEY_3853b846'


def digest(directory, suffix):
    """Фиксирует проверенные исходники и сборку, не включая личные файлы состояния."""
    value = hashlib.sha256()
    for path in sorted(directory.rglob('*' + suffix)):
        value.update(str(path.relative_to(ROOT)).encode())
        value.update(path.read_bytes())
    return value.hexdigest()


def journals(state):
    """Сверяет исходные журналы до и после диагностики, исключая производные индексы."""
    return {str(path.relative_to(state)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in state.rglob('*.jsonl')}


def eventually(check, description, timeout=12):
    """Ожидает наблюдаемое состояние без фиксированной задержки исполнения модели."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError(description)


class Audit:
    """Сохраняет только результаты текущего изолированного прогона в releases."""
    def __init__(self, output):
        self.output, self.frames, self.checks, self.failures = output, {}, [], []
        self.output.mkdir(parents=True, exist_ok=True)

    def frame(self, terminal, name, text, framed=True):
        """Проверяет видимый кадр, переносы и доступность клавиатурного управления."""
        frame = terminal.wait_screen(
            lambda value: text in inventory.compact(value) and (not framed or
                ('Harness by Ghost_Raven' in inventory.compact(value) and 'Esc' in value
                 and any(line.lstrip().startswith('╰') for line in value.splitlines()))),
            'Не открыт экран: ' + name, timeout=15)
        self.frames[name] = frame
        if framed:
            assert 'Harness by Ghost_Raven' in inventory.compact(frame), frame
            assert 'Esc' in frame, frame
            assert len(frame.splitlines()) <= terminal.rows, frame
            for line in frame.splitlines():
                assert len(line) <= terminal.columns, frame
        return frame

    def passed(self, name):
        """Отмечает только завершённую проверку и сообщает прогресс CI."""
        self.checks.append(name)
        print(name, 'passed', flush=True)

    def save(self, metadata):
        """Записывает кадры отдельно от краткого отчёта, в том числе после отказа."""
        (self.output / 'frames.json').write_text(json.dumps(self.frames, ensure_ascii=False, indent=2) + '\n')
        report = {**metadata, 'checks': self.checks, 'failures': self.failures,
                  'frames': list(self.frames)}
        (self.output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


def command(node, state, workspace, width, arguments, expected, audit, name):
    """Запускает диагностическую команду в PTY и требует штатный код завершения."""
    terminal = Terminal(node, state, workspace, width, 24, arguments)
    try:
        terminal.expect(expected)
        terminal.finish()
        audit.frames[name] = terminal.screen()
        assert expected in terminal.text, terminal.text[-3000:]
    finally:
        terminal.close()


def run_case(node, root, width, audit):
    """Проверяет два окна, обрыв процесса, продолжение, обслуживание и отключение CLI."""
    root.mkdir()
    workspace, state = live.base.base.configure(root, 9)
    config = root / 'config/harness.json'
    # Ключ является синтетическим маркером: модель работает только внутри fixture-процесса.
    profiles = json.loads((root / 'config/profiles.json').read_text())
    profiles['fixture']['apiKeyEnv'] = 'HARNESS_CORE_FIXTURE_KEY'
    (root / 'config/profiles.json').write_text(json.dumps(profiles))
    tools = json.loads((root / 'config/tools.json').read_text())
    tools['mcp'] = []
    (root / 'config/tools.json').write_text(json.dumps(tools))
    previous_key = os.environ.get('HARNESS_CORE_FIXTURE_KEY')
    os.environ['HARNESS_CORE_FIXTURE_KEY'] = PRIVATE_KEY
    fixture = None
    terminals = []
    prefix = str(width) + 'x24/'
    try:
        fixture = Fixture(node, config, state, workspace)
        first = Terminal(node, state, workspace, width, 24)
        terminals.append(first)
        second = Terminal(node, state, workspace, width, 24)
        terminals.append(second)
        audit.frame(first, prefix + 'first-main', 'Чем займёмся?')
        audit.frame(second, prefix + 'second-main', 'Чем займёмся?')
        audit.passed(prefix + 'two-attached-windows')

        alpha = live.start_task(fixture, workspace, 'Первая задача')
        audit.frame(first, prefix + 'first-running', 'В работе: 1')
        audit.frame(second, prefix + 'second-running', 'В работе: 1')
        fixture.request('complete', {'runId': alpha})
        first.open_label('Мои задачи')
        audit.frame(first, prefix + 'catalog-first', 'Первая задача')
        second.open_label('Новая задача')
        second.wait_text('Что нужно сделать?')
        second.send('Возобновляемая задача\n' + PRIVATE_TASK + '\x13')
        audit.frame(second, prefix + 'second-task', 'Ход задачи')
        audit.frame(first, prefix + 'catalog-new-task', 'Возобновляемая задача')
        beta = next(run['runId'] for run in fixture.call('runtime.list') if run['runId'] != alpha)
        audit.passed(prefix + 'task-submitted-in-second-window-updates-first-catalog')
        before_status = fixture.call('runtime.status', {'runId': beta})
        source = state / 'runs' / (beta + '.jsonl')
        confirmed = source.read_bytes()
        assert before_status['status'] == 'running', before_status

        # SIGKILL оставляет настоящий незавершённый запуск; хвост добавляется только после остановки писателя.
        fixture.process.kill()
        fixture.process.wait(timeout=8)
        fixture.close()
        fixture = None
        audit.frame(first, prefix + 'owner-disconnected', 'Нет связи')
        with source.open('ab') as stream:
            stream.write(b'{"PTY_TORN_TAIL":')
        fixture = Fixture(node, config, state, workspace)
        recovered = fixture.call('runtime.status', {'runId': beta})
        assert recovered['status'] == 'paused', recovered
        assert recovered['turns'] == before_status['turns'], recovered
        assert source.read_bytes().startswith(confirmed), 'Восстановление изменило подтверждённую часть журнала'
        assert b'PTY_TORN_TAIL' not in source.read_bytes(), 'Владелец не убрал оборванный хвост'
        audit.frame(first, prefix + 'catalog-recovered', 'Приостановлено')
        audit.frame(second, prefix + 'resume-action', 'Продолжить после паузы')
        audit.passed(prefix + 'crash-recovers-to-pause-without-automatic-model-call')
        audit.passed(prefix + 'owner-repairs-only-torn-tail')

        second.open_label('Продолжить после паузы')
        audit.frame(second, prefix + 'resumed-task', 'Ход задачи')
        eventually(lambda: fixture.call('runtime.status', {'runId': beta})['status'] == 'running',
                   'Кнопка продолжения не возобновила задачу')
        messages = fixture.request('modelMessages', {'runId': beta})
        assert any(PRIVATE_TASK in message['content'] for message in messages), messages
        fixture.request('answer', {'runId': beta, 'text': 'Ответ после восстановления. Полный результат сохранён.'})
        audit.frame(second, prefix + 'answer-after-resume', 'Ответ получен')
        audit.frame(first, prefix + 'catalog-completed', 'Возобновляемая задача')
        audit.passed(prefix + 'explicit-resume-preserves-original-context')
        second.open_label('Прочитать ответ')
        audit.frame(second, prefix + 'full-answer', 'Ответ после восстановления.')
        second.send('\x1b')
        second.wait_text('Что дальше?')
        second.open_label('В главное меню')
        audit.frame(second, prefix + 'main-after-task', 'В работе: 0')
        audit.passed(prefix + 'answer-readable-and-counters-follow-completion')

        before_journals = journals(state)
        export_path = root / 'diagnostic-export.json'
        command(node, state, workspace, width,
                ['doctor', '--config', str(config), '--verify-history', '--export', str(export_path)],
                'Отчёт сохранён:', audit, prefix + 'doctor-verify-export')
        exported = export_path.read_text()
        parsed = json.loads(exported)
        assert parsed.get('history', {}).get('healthy') is True, parsed
        for hidden in [PRIVATE_TASK, PRIVATE_KEY, str(workspace), str(state), str(config),
                       'Возобновляемая задача', 'Ответ после восстановления']:
            assert hidden not in exported, 'Диагностический экспорт содержит закрытые данные: ' + hidden
        assert journals(state) == before_journals, 'Проверка истории изменила исходные журналы'
        audit.passed(prefix + 'doctor-verify-export-is-readonly-and-redacted')
        command(node, state, workspace, width,
                ['doctor', '--config', str(config), '--rebuild-index', '--verify-history'],
                'Перестроено индексов:', audit, prefix + 'doctor-rebuild')
        assert journals(state) == before_journals, 'Перестроение изменило исходные журналы'
        audit.passed(prefix + 'doctor-rebuild-through-existing-owner-keeps-journals')

        first.send('\x1b')
        first.wait_text('Чем займёмся?')
        for index, terminal in enumerate(terminals, 1):
            terminal.open_label('Выход')
            terminal.expect('До следующей задачи!')
            terminal.expect('Сервис продолжает работать')
            terminal.finish()
            frame = terminal.screen()
            audit.frames[prefix + 'farewell-' + str(index)] = frame
            assert 'Harness by Ghost_Raven' in inventory.compact(frame), frame
            assert 'До следующей задачи!' in frame, frame
            assert b'\x1b[?1049l' in terminal.raw and b'\x1b[?25h' in terminal.raw
            assert fixture.process.poll() is None, 'Отключение CLI остановило чужой сервис'
        audit.passed(prefix + 'both-windows-exit-with-logo-and-restored-terminal')
        assert fixture.call('runtime.status', {'runId': beta})['status'] == 'completed'
        audit.passed(prefix + 'owner-and-history-survive-both-cli-exits')
        fixture.close()
        fixture = None
        before_offline = journals(state)
        command(node, state, workspace, width,
                ['doctor', '--config', str(config), '--verify-history', '--rebuild-index'],
                'Перестроено индексов:', audit, prefix + 'doctor-offline')
        assert journals(state) == before_offline, 'Автономный doctor изменил исходные журналы'
        assert not (state / 'daemon.lock').exists(), 'Автономный doctor не освободил блокировку'
        audit.passed(prefix + 'offline-doctor-owns-and-releases-state-lock')
    except Exception:
        for index, terminal in enumerate(terminals, 1):
            try:
                audit.frames[prefix + 'failure-' + str(index)] = terminal.screen()
            except OSError:
                pass
        raise
    finally:
        for terminal in terminals:
            terminal.close()
        if fixture:
            fixture.close()
        if previous_key is None:
            os.environ.pop('HARNESS_CORE_FIXTURE_KEY', None)
        else:
            os.environ['HARNESS_CORE_FIXTURE_KEY'] = previous_key
        assert not (state / 'daemon.lock').exists(), 'Fixture не освободил каталог состояния'


def main():
    """Проверяет обе ширины одной сборки и сохраняет отчёт без изменения документации."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    parser.add_argument('--output', default=str(ROOT / 'releases/core-playtest'))
    args = parser.parse_args()
    node, output = str(Path(args.node).resolve()), Path(args.output).resolve()
    assert output.is_relative_to(ROOT / 'releases'), 'Отчёты разрешены только внутри releases/'
    audit = Audit(output)
    source, built = digest(ROOT / 'src', '.ts'), digest(ROOT / 'dist', '.js')
    manifest = json.loads((ROOT / 'dist/build-manifest.json').read_text())
    metadata = {'node': subprocess.check_output([node, '--version']).decode().strip(),
                'platform': os.uname().sysname, 'sourceDigest': source, 'distDigest': built,
                'buildId': manifest['sources'], 'sizes': SIZES, 'transport': 'isolated in-process provider'}
    with tempfile.TemporaryDirectory(prefix='harness-core-pty-') as directory:
        for width, height in SIZES:
            try:
                run_case(node, Path(directory).resolve() / str(width), width, audit)
            except Exception as error:
                audit.failures.append({'size': [width, height], 'reason': str(error)})
                print(str(width), str(error), flush=True)
            finally:
                audit.save(metadata)
    metadata['distUnchanged'] = built == digest(ROOT / 'dist', '.js')
    metadata['sourceUnchanged'] = source == digest(ROOT / 'src', '.ts')
    audit.save(metadata)
    print(json.dumps({'checks': len(audit.checks), 'frames': len(audit.frames),
                      'failures': len(audit.failures), 'report': str(output / 'report.json')}, ensure_ascii=False))
    if audit.failures or not metadata['distUnchanged'] or not metadata['sourceUnchanged']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
