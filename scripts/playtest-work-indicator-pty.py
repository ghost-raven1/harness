#!/usr/bin/env python3
"""Проверяет живой индикатор в двух PTY с управляемой моделью и настоящим инструментом."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('work_indicator_live', ROOT / 'scripts/playtest-live-screens.py')
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)
SPINNER = re.compile(r'[\u2800-\u28ff]')


def eventually(check, description, timeout=12):
    """Ожидает наблюдаемое состояние; ожидание модели управляется отдельно от часов теста."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError(description)


def alive(pid):
    """Завершение дочерней команды подтверждается ОС, а не только состоянием запуска."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def run_case(node, root, width, frames, checks, observations):
    root.mkdir()
    workspace, state = live.base.base.configure(root, 9)
    (root / 'config/policy.json').write_text(json.dumps({
        'default': 'deny', 'rules': [{'tool': '*', 'decision': 'allow'}],
    }))
    fixture = live.Fixture(node, root / 'config/harness.json', state, workspace)
    terminals = [live.Terminal(node, state, workspace, width, 24) for _ in range(2)]
    first, second = terminals
    case = f'{width}x24'

    def capture(name, label, terminal=first):
        frame = terminal.wait_text(label)
        assert 'Harness by Ghost_Raven' in frame and 'Esc' in frame, frame
        frames[f'{case}/{name}'] = frame
        checks.append(f'{case}/{name}')
        return frame

    def count():
        return fixture.request('metrics')['modelRequests']

    def animation(name, targets, timed=False):
        """Сравнивает видимые кадры, а не количество перерисовок терминального буфера."""
        before = count()
        samples = [[] for _ in targets]
        until = time.monotonic() + 3.2
        while time.monotonic() < until:
            for index, (terminal, label) in enumerate(targets):
                frame = terminal.wait_screen(
                    lambda value: any(label in line and SPINNER.search(line) for line in value.splitlines()),
                    'Индикатор не появился: ' + label)
                line = next(line for line in frame.splitlines() if label in line and SPINNER.search(line))
                samples[index].append(line)
        assert count() == before, 'Анимация вызвала новый запрос к модели'
        for index, lines in enumerate(samples):
            assert len({SPINNER.search(line).group() for line in lines}) > 1, lines
            if timed:
                seconds = [int(m.group(1)) * 60 + int(m.group(2)) for line in lines
                           for m in [re.search(r' · (\d+):(\d{2})', line)] if m]
                assert seconds and max(seconds) > min(seconds), lines
            observations[f'{case}/{name}/window-{index + 1}'] = lines
        checks.append(f'{case}/{name}')

    def to_main(terminal):
        terminal.send('\x1b')
        terminal.wait_text('Мои задачи · страница')
        terminal.send('\x1b')
        terminal.wait_text('Чем займёмся?')

    def project_action(method, project_id, **params):
        view = fixture.call('projects.detail', {'projectId': project_id})
        return fixture.call('projects.' + method, {'projectId': project_id,
            'expectedRevision': view['revision'], 'requestKey': str(uuid.uuid4()), **params})

    try:
        for terminal in terminals:
            terminal.wait_text('Чем займёмся?')
        fixture.call('iterations.configure', {'limit': 1})
        task = live.start_task(fixture, workspace, 'Медленный ответ')
        eventually(lambda: count() == 1, 'Модель не получила исходный запрос')
        animation('dashboard-animation', [(first, 'Harness выполняет задачи')])
        for terminal in terminals:
            terminal.open_label('Мои задачи')
            terminal.wait_text('Медленный ответ')
        animation('catalog-animation', [(first, 'Задачи выполняются')])
        for terminal in terminals:
            terminal.open_label('Медленный ответ')
            terminal.wait_text('Ожидаю ответ модели')
        animation('before-first-token-two-windows', [
            (first, 'Ожидаю ответ модели'), (second, 'Ожидаю ответ модели'),
        ], timed=True)
        assert count() == 1
        fixture.request('stream', {'runId': task, 'text': 'Публичный ответ поступает частями.'})
        capture('stream-first-window', 'Получаю ответ модели')
        capture('stream-second-window', 'Получаю ответ модели', second)
        assert count() == 1
        fixture.request('slowCommand', {'runId': task})
        eventually(lambda: (workspace / 'tool-started').exists(), 'Проверочная команда не запущена')
        tool_pid = int((workspace / 'tool-started').read_text())
        assert alive(tool_pid)
        animation('real-tool-two-windows', [
            (first, 'Выполняю команду'), (second, 'Выполняю команду'),
        ], timed=True)
        (workspace / 'tool-release').write_text('завершить')
        eventually(lambda: fixture.call('runtime.status', {'runId': task})['status'] == 'paused',
                   'Задача не встала на паузу после одного шага')
        for index, terminal in enumerate(terminals):
            frame = capture(f'paused-{index + 1}', 'Работа приостановлена', terminal)
            assert not SPINNER.search(frame), frame
        assert count() == 1
        eventually(lambda: not alive(tool_pid), 'Процесс инструмента остался после завершения')
        checks.append(case + '/tool-process-reaped')
        fixture.call('runtime.resume', {'runId': task})
        eventually(lambda: count() == 2, 'Продолжение не создало следующий запрос')
        capture('resumed', 'Ожидаю ответ модели')
        fixture.request('answer', {'runId': task, 'text': 'Проверка индикатора завершена.'})
        eventually(lambda: fixture.call('runtime.status', {'runId': task})['status'] == 'completed',
                   'Задача не завершилась')
        for index, terminal in enumerate(terminals):
            terminal.send('\t\t\t')
            frame = capture(f'completed-{index + 1}', 'Проверка индикатора завершена.', terminal)
            assert not SPINNER.search(frame), frame
            to_main(terminal)
        before = fixture.counts('runtime.task')
        first.drain(1.3)
        second.drain(1.3)
        assert fixture.counts('runtime.task') == before, 'Покинутые экраны продолжают читать задачу'
        assert all('Чем займёмся?' in terminal.screen() for terminal in terminals)
        checks.append(case + '/navigation-stops-task-screen')

        # Проектный reader и меню используют другие владельцы анимации, чем экран задачи.
        fixture.call('iterations.configure', {'limit': 64})
        project = fixture.call('projects.create', {
            'title': 'Живой проект', 'goal': 'Проверить ожидание этапа',
            'workspace': str(workspace), 'profile': 'fixture', 'requestKey': str(uuid.uuid4()),
        })
        project_id = project['projectId']
        project_action('editPlan', project_id, plan={
            'maxCorrections': 2, 'fixBaselineFailures': False, 'stages': [{
                'id': 'inspect', 'title': 'Проверить индикатор', 'task': 'Жди завершения проверки',
                'role': 'coordinator', 'dependsOn': [], 'expectedResult': 'Индикатор работает',
                'requiredTools': [], 'verification': {'kind': 'manual', 'instructions': 'Проверьте экран'},
            }],
        })
        project_action('acceptPlan', project_id, expectedPlanVersion=1)
        eventually(lambda: count() == 3, 'Проектный этап не обратился к модели')
        for terminal in terminals:
            terminal.open_label('Проекты')
            terminal.open_label('Живой проект')
            terminal.wait_text('Обзор')
        second.send('\r')
        second.wait_text('Что дальше?')
        animation('project-reader-and-actions', [(first, 'Выполняю проект'), (second, 'Выполняю проект')])
        project_action('pause', project_id)
        eventually(lambda: fixture.call('projects.detail', {'projectId': project_id})['status'] == 'paused',
                   'Проект не остановился на безопасной границе')
        for index, terminal in enumerate(terminals):
            frame = capture(f'project-paused-{index + 1}', 'Приостановлен', terminal)
            assert 'Ⅱ' in frame and not SPINNER.search(frame), frame
        project_action('cancel', project_id)
        for terminal in terminals:
            terminal.send('\x1b')
            terminal.wait_text('Новый проект')
            terminal.send('\x1b')
            terminal.wait_text('Чем займёмся?')
        before = fixture.counts('projects.detail')
        first.drain(1.3)
        second.drain(1.3)
        assert fixture.counts('projects.detail') == before, 'Покинутые проектные экраны продолжают опрос'
        checks.append(case + '/navigation-stops-project-screens')
        for terminal in terminals:
            terminal.open_label('Выход')
            terminal.finish()
            assert not alive(terminal.pid)
        assert count() == 3
        checks.append(case + '/both-clients-exit-without-live-timers')
        fixture.request('close')
        fixture.process.wait(timeout=8)
        assert fixture.process.returncode == 0
        assert not alive(fixture.process.pid)
        checks.append(case + '/owner-exits-cleanly')
    finally:
        for terminal in terminals:
            terminal.close()
        fixture.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    parser.add_argument('--output')
    args = parser.parse_args()
    manifest = (ROOT / 'dist/build-manifest.json').read_bytes()
    frames, checks, observations = {}, [], {}
    try:
        with tempfile.TemporaryDirectory(prefix='harness-work-indicator-pty-') as folder:
            for width in [48, 80]:
                run_case(str(Path(args.node).resolve()), Path(folder).resolve() / str(width),
                         width, frames, checks, observations)
    finally:
        if args.output:
            Path(args.output).write_text(json.dumps({
                'buildManifestSha256': hashlib.sha256(manifest).hexdigest(),
                'checks': checks, 'frames': frames, 'animationSamples': observations,
            }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    assert (ROOT / 'dist/build-manifest.json').read_bytes() == manifest, 'Сборка изменилась во время PTY.'
    print(json.dumps({'checks': len(checks), 'sizes': ['48x24', '80x24'],
                      'windows': 2, 'provider': 'local fixture'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
