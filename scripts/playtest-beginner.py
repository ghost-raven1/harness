#!/usr/bin/env python3
"""Проверяет понятность меню и управление задачами в настоящем PTY с временными данными."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('live_pages', ROOT / 'scripts/playtest-live-screens.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
BRAND = 'Harness by Ghost_Raven'
SIZES = [(80, 24), (48, 24)]


def compact(frame):
    return ' '.join(frame.replace('│', ' ').split())


def source_digest():
    digest = hashlib.sha256()
    for path in sorted((ROOT / 'src').rglob('*.ts')):
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def run_case(node, root, width, height, frames, checks):
    root.mkdir()
    workspace, state = base.base.base.configure(root, 9)
    project_file = workspace / 'Сохранить.txt'
    project_file.write_text('Файл проекта должен пережить удаление истории.\n')
    fixture = base.Fixture(node, root / 'config/harness.json', state, workspace)
    terminal = base.Terminal(node, state, workspace, width, height)
    case = str(width) + 'x' + str(height)

    def capture(name, text):
        frame = terminal.wait_text(text)
        frames[case + '/' + name] = frame
        assert BRAND in frame, 'Пропал логотип: ' + name + '\n' + frame
        return frame

    def passed(name):
        checks.append(case + '/' + name)

    def return_to_main():
        terminal.send('\x1b')
        terminal.wait_text('Чем займёмся?')

    def open_actions(title):
        terminal.open_label('Мои задачи')
        terminal.wait_text(title)
        terminal.open_label(title)
        terminal.wait_text('Ход задачи')
        terminal.send('\r')
        terminal.wait_text('Что дальше?')

    try:
        main = capture('main', 'Чем займёмся?')
        assert 'baseline' not in main, main
        assert 'Обновляется автоматически' not in main, main
        assert all(key in main for key in ['↑↓', 'Enter', 'Esc']), main
        assert '● Новая задача' in main, main
        assert 'опишите, что нужно сделать' in compact(main), main
        passed('main-no-technical-noise')
        passed('main-controls-and-selection-visible')
        if width >= 80:
            for hint in ['опишите, что нужно сделать', 'ответы, продолжение и разрешения',
                         'уроки, доказательства и проверки']:
                assert hint in compact(main), 'Обрезана помещающаяся подсказка: ' + hint + '\n' + main
            option_lines = '\n'.join(line for line in main.splitlines() if re.search(r'[●○] ', line))
            assert '…' not in option_lines, option_lines
            passed('main-complete-hints-without-ellipsis')
        for label in ['Мои задачи', 'База знаний', 'Выход']:
            terminal.select_label(label)
            frame = capture('selected-' + label, label)
            assert label in terminal.selected(), frame
            assert all(key in frame for key in ['↑↓', 'Enter', 'Esc']), frame
            hint = {'Мои задачи': 'ответы, продолжение и разрешения',
                    'База знаний': 'уроки, доказательства и проверки'}.get(label)
            if hint:
                assert hint in compact(frame), 'Не видна подсказка выбранного пункта:\n' + frame
        passed('all-menu-selections-keep-controls-visible')

        terminal.open_label('Мои задачи')
        empty_start = capture('empty-task-list', 'Пока нет задач')
        assert '● Новая задача' in empty_start, empty_start
        terminal.open_label('Новая задача')
        terminal.wait_text('Что нужно сделать?')
        terminal.send('\x1b')
        capture('empty-task-cancel', 'Мои задачи · страница')
        assert fixture.call('runtime.list') == []
        passed('empty-list-offers-first-task')
        passed('cancel-first-task-returns-to-list-without-run')
        return_to_main()

        title = 'Проверить проект'
        run_id = base.start_task(fixture, workspace, title)
        fixture.call('runtime.cancel', {'runId': run_id})
        before = fixture.call('runtime.status', {'runId': run_id})
        assert before['status'] == 'cancelled', before
        open_actions(title)
        actions = capture('cancelled-actions', 'Продолжить задачу')
        assert 'К списку задач' in compact(actions), actions
        passed('cancelled-task-has-explicit-continuation')
        terminal.open_label('Продолжить задачу')
        continuation = capture('continue-prompt', 'С чего продолжить?')
        assert 'Продолжи исходную задачу.' in compact(continuation), continuation
        passed('continuation-prepares-user-message')
        terminal.send('\x1b')
        capture('continue-cancel', 'Что дальше?')
        assert len(fixture.call('runtime.list')) == 1
        assert fixture.call('runtime.status', {'runId': run_id})['status'] == 'cancelled'
        passed('escape-continuation-does-not-start-work')
        terminal.open_label('Продолжить задачу')
        terminal.wait_text('Сохранённые черновики')
        terminal.open_label('Продолжи исходную')
        terminal.open_label('Продолжить ввод')
        terminal.wait_text('С чего продолжить?')
        terminal.send('\x13')
        capture('continued-task', 'Ход задачи')
        runs = fixture.call('runtime.list')
        new_run = next(run for run in runs if run['runId'] != run_id)
        current = fixture.call('runtime.status', {'runId': new_run['runId']})
        assert current['status'] == 'running', current
        assert current['sessionId'] == before['sessionId'], current
        assert current['workspace'] == before['workspace'], current
        assert current['profile'] == before['profile'], current
        assert fixture.call('runtime.status', {'runId': run_id})['status'] == 'cancelled'
        passed('continuation-preserves-session-workspace-profile')
        terminal.send('\x1b')
        capture('viewer-back-to-list', 'Мои задачи · страница')
        passed('escape-task-returns-to-task-list')
        fixture.call('runtime.cancel', {'runId': new_run['runId']})
        return_to_main()

        run_ids = {run_id, new_run['runId']}
        before_paths = [state / 'runs' / (identity + ending)
                        for identity in run_ids for ending in ['.json', '.jsonl']]
        assert all(path.exists() for path in before_paths), before_paths
        open_actions(title)
        terminal.open_label('Удалить навсегда')
        confirmation = capture('purge-confirmation', 'Удалить эту переписку навсегда?')
        assert 'Этапов задачи: 2' in compact(confirmation), confirmation
        assert '● Оставить' in confirmation, confirmation
        assert all(key in confirmation for key in ['Enter', 'Esc']), confirmation
        passed('purge-explains-scope-and-defaults-to-keep')
        terminal.send('\x1b[F')
        explanation = capture('purge-consequences', 'Файлы проекта')
        assert 'сохранённые вами ответы останутся' in compact(explanation), explanation
        passed('purge-consequences-are-readable')
        terminal.send('\r')
        terminal.wait_text('Что дальше?')
        assert all(path.exists() for path in before_paths), before_paths
        assert len(fixture.call('runtime.list')) == 2
        passed('purge-refusal-preserves-all-stages')
        terminal.open_label('Удалить навсегда')
        terminal.wait_text('Удалить эту переписку навсегда?')
        terminal.send('\x1b[D\r')
        capture('purge-completed', 'Переписка удалена')
        terminal.wait_text('Продолжить')
        terminal.send('\r')
        empty = capture('purged-list', 'Мои задачи · страница')
        assert title not in empty, empty
        assert fixture.call('runtime.list') == []
        assert not any(path.exists() for path in before_paths), before_paths
        all_history = fixture.call('runtime.history', {'includeDeleted': True})
        assert not all_history['items'] and not all_history['active'], all_history
        passed('purge-removes-every-stage-from-disk-and-history')
        terminal.open_label('Показать убранные задачи')
        hidden = capture('purged-hidden-list', 'Мои задачи · страница')
        assert title not in hidden, hidden
        passed('purged-task-is-absent-from-hidden-list')
        assert project_file.read_text() == 'Файл проекта должен пережить удаление истории.\n'
        passed('purge-preserves-project-files')
        return_to_main()
        terminal.open_label('Выход')
        terminal.expect('Сервис продолжает работать')
        terminal.finish()
        assert fixture.process.poll() is None
        passed('exit-keeps-independent-service')
    finally:
        terminal.close()
        fixture.close()
        assert not (state / 'daemon.lock').exists(), 'Тестовый сервис не освободил состояние'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    frames, checks = {}, []
    initial_digest = source_digest()
    try:
        with tempfile.TemporaryDirectory(prefix='harness-beginner-') as directory:
            for width, height in SIZES:
                run_case(node, Path(directory).resolve() / (str(width) + 'x' + str(height)),
                         width, height, frames, checks)
    finally:
        (ROOT / '.harness').mkdir(exist_ok=True)
        (ROOT / '.harness/beginner-frames.json').write_text(json.dumps(frames, ensure_ascii=False, indent=2) + '\n')
    assert initial_digest == source_digest(), 'Исходники изменились во время плейтеста; проверьте свежую сборку'
    report = {'platform': os.uname().sysname,
              'node': subprocess.check_output([node, '--version']).decode().strip(),
              'sourceDigest': initial_digest, 'modelTransport': 'in-process fixture',
              'checks': checks, 'frames': list(frames)}
    (ROOT / 'docs/playtest-beginner.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'checks': len(checks), 'frames': len(frames), 'sourceDigest': initial_digest}, indent=2))


if __name__ == '__main__':
    main()
