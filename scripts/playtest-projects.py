#!/usr/bin/env python3
"""Проверяет проекты в двух настоящих PTY без облачных запросов и пользовательских данных."""
import argparse
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('live_projects_base', ROOT / 'scripts/playtest-live-screens.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def run_case(node, root, width, frames, checks):
    root.mkdir()
    workspace, state = base.base.base.configure(root, 9)
    fixture = base.Fixture(node, root / 'config/harness.json', state, workspace)
    terminal = base.Terminal(node, state, workspace, width, 24)
    second = base.Terminal(node, state, workspace, width, 24)
    case = f'{width}x24'

    def capture(name, text):
        frame = terminal.wait_screen(lambda current: text in current and
            'Harness by Ghost_Raven' in current and 'Esc' in current,
            'Не завершилась отрисовка экрана: ' + name)
        frames[f'{case}/{name}'] = frame
        checks.append(f'{case}/{name}')
        return frame

    def detail(project_id):
        return fixture.call('projects.detail', {'projectId': project_id})

    def mutate(method, project_id, **params):
        current = detail(project_id)
        return fixture.call('projects.' + method, {'projectId': project_id,
            'expectedRevision': current['revision'], 'requestKey': str(uuid.uuid4()), **params})

    def wait_status(project_id, status):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            current = detail(project_id)
            if current['status'] == status:
                return current
            terminal.drain(0.1)
        raise AssertionError(json.dumps(current, ensure_ascii=False))

    try:
        terminal.wait_text('Чем займёмся?')
        second.wait_text('Чем займёмся?')
        terminal.open_label('Проекты')
        capture('empty', 'Новый проект')
        created = fixture.call('projects.create', {'title': 'Проект Альфа', 'goal': 'Проверить страницу ошибок',
            'workspace': str(workspace), 'profile': 'fixture', 'requestKey': str(uuid.uuid4())})
        project_id = created['projectId']
        capture('live-created', 'Проект Альфа')
        plan = {'maxCorrections': 2, 'fixBaselineFailures': False, 'stages': [{
            'id': 'inspect', 'title': 'Проверка страницы', 'task': 'Изучи страницу ошибок', 'role': 'coordinator',
            'dependsOn': [], 'expectedResult': 'Страница понятна', 'requiredTools': ['fs.read'],
            'verification': {'kind': 'manual', 'instructions': 'Открыть страницу и прочитать сообщение\n' +
                '\n'.join('Проверка строки ' + str(index) for index in range(35)) + '\nКонтрольная строка проверки'},
        }]}
        mutate('editPlan', project_id, plan=plan)
        terminal.open_label('Проект Альфа')
        capture('detail', 'Обзор')
        terminal.send('\t')
        capture('plan', 'Исправлений каждого этапа: 2')
        second.open_label('Проекты')
        second.open_label('Проект Альфа')
        second.wait_text('Обзор')
        plan['maxCorrections'] = 3
        mutate('editPlan', project_id, plan=plan)
        capture('plan-updated', 'Исправлений каждого этапа: 3')
        second.send('\t')
        assert 'Исправлений каждого этапа: 3' in second.wait_text('Исправлений каждого этапа: 3')
        terminal.send('\r')
        terminal.open_label('Принять план')
        capture('accept-plan-preview', 'Принять план')
        plan['maxCorrections'] = 4
        mutate('editPlan', project_id, plan=plan)
        capture('stale-confirmation', 'Решение больше не требуется')
        terminal.send('\r')
        terminal.wait_text('Что дальше?')
        current = detail(project_id)
        mutate('acceptPlan', project_id, expectedPlanVersion=current['planVersion'])
        current = wait_status(project_id, 'running')
        capture('running', 'В работе')
        terminal.open_label('Приостановить')
        wait_status(project_id, 'paused')
        capture('paused', 'Приостановлен')
        (workspace / 'external-note.txt').write_text('Изменено во время паузы')
        terminal.open_label('Продолжить')
        terminal.wait_text('Продолжить с изменёнными')
        terminal.send('\x1b[F')
        capture('external-changes-preview', 'external-note.txt')
        terminal.send('\x1b[D\r')
        current = wait_status(project_id, 'running')
        fixture.request('answer', {'runId': current['currentRunId'], 'text': 'Страница изучена, проверьте её вручную.'})
        current = wait_status(project_id, 'paused')
        assert current['reasonCode'] == 'MANUAL_CHECK', current
        terminal.open_label('Проверить результат вручную')
        terminal.open_label('Проверка страницы')
        capture('manual-instructions', 'Открыть страницу')
        terminal.send('\x1b[F')
        capture('manual-instructions-full', 'Контрольная строка проверки')
        terminal.send('\r')
        terminal.open_label('Всё работает')
        terminal.wait_text('Что проверено')
        terminal.send('Проверено вручную\r')
        capture('manual-confirmation', 'Зафиксировать')
        terminal.send('\x1b[D\r')
        wait_status(project_id, 'review')
        terminal.open_label('Принять результат')
        capture('accept-result', 'Принять итог')
        terminal.send('\x1b[D\r')
        wait_status(project_id, 'completed')
        capture('completed', 'Принят')
        terminal.open_label('Убрать в архив')
        capture('archived', 'Вернуть из архива')
        terminal.open_label('Удалить навсегда')
        capture('purge-preview', 'Удаление проекта')
        terminal.send('\x1b[D\r')
        terminal.wait_text('Новый проект')
        second.wait_text('Проект удалён')
        checks.append(case + '/purge-invalidates-second-window')
        second.send('\x1b')
        second.wait_text('Новый проект')
        second.send('\x1b')
        second.wait_text('Чем займёмся?')
        second.open_label('Выход')
        second.finish()
        assert fixture.call('system.info')['projectCount'] == 0
        terminal.send('\x1b')
        terminal.wait_text('Чем займёмся?')
        terminal.open_label('Выход')
        terminal.finish()
        checks.append(case + '/both-windows-exit-owner-survives')
    finally:
        terminal.close()
        second.close()
        fixture.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    parser.add_argument('--output')
    args = parser.parse_args()
    frames, checks = {}, []
    manifest = (ROOT / 'dist/build-manifest.json').read_bytes()
    build_digest = hashlib.sha256(manifest).hexdigest()
    try:
        with tempfile.TemporaryDirectory(prefix='harness-projects-pty-') as folder:
            for width in [48, 80]:
                run_case(str(Path(args.node).resolve()), Path(folder).resolve() / str(width), width, frames, checks)
    finally:
        if args.output:
            Path(args.output).write_text(json.dumps({'buildManifestSha256': build_digest,
                'checks': checks, 'frames': frames}, ensure_ascii=False, indent=2) + '\n')
    assert (ROOT / 'dist/build-manifest.json').read_bytes() == manifest, 'Сборка изменилась во время PTY; повторите проверку.'
    print(json.dumps({'checks': len(checks), 'sizes': ['48x24', '80x24'], 'windows': 2, 'provider': 'local fixture'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
