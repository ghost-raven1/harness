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

        # Настоящая исходная команда с ask должна быть видна до запуска первого этапа.
        approval_project = fixture.call('projects.create', {
            'title': 'Проверка с разрешением', 'goal': 'Проверить исходное состояние перед работой',
            'workspace': str(workspace), 'profile': 'fixture', 'requestKey': str(uuid.uuid4())})
        approval_id = approval_project['projectId']
        command_args = ['-e', "process.stdout.write('HARNESS_PROJECT_BASELINE_OK')"]
        mutate('editPlan', approval_id, plan={
            'maxCorrections': 2, 'fixBaselineFailures': False, 'stages': [{
                'id': 'approved-stage', 'title': 'Работа после проверки',
                'task': 'Начни только после исходной проверки', 'role': 'coordinator',
                'dependsOn': [], 'expectedResult': 'Работа выполнена', 'requiredTools': [],
                'verification': {'kind': 'commands', 'checks': [{
                    'id': 'baseline', 'title': 'Проверка Node', 'command': node, 'args': command_args,
                }]},
            }]})
        mutate('acceptPlan', approval_id, expectedPlanVersion=detail(approval_id)['planVersion'])
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            current = detail(approval_id)
            if current.get('pendingApprovals') == 1:
                break
            terminal.drain(0.1)
        assert current.get('pendingApprovals') == 1, current
        assert current['reasonCode'] == 'APPROVAL_REQUIRED', current
        assert current['stages'][0]['status'] == 'pending', current
        check_run = current['currentRunId']
        approval = next(item for item in fixture.call('approvals.list') if item['runId'] == check_run)
        assert approval['tool'] == 'process.exec' and approval['args']['args'] == command_args, approval
        terminal.open_label('Проверка с разрешением')
        capture('approval-overview', 'Ждёт разрешения: 1')
        second.open_label('Проверка с разрешением')
        second.wait_text('Ждёт разрешения: 1')
        terminal.send('\r')
        capture('approval-action', 'Рассмотреть разрешения')
        terminal.open_label('Рассмотреть разрешения')
        capture('approval-list', 'process.exec')
        terminal.open_label('process.exec')
        capture('approval-confirmation', 'Точные аргументы операции')
        assert detail(approval_id)['stages'][0]['status'] == 'pending'
        terminal.send('\x1b[D\r')
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            current = detail(approval_id)
            if current['stages'][0]['status'] == 'running':
                break
            terminal.drain(0.1)
        assert current['stages'][0]['status'] == 'running', current
        assert not current.get('pendingApprovals'), current
        assert current['reports'][0]['phase'] == 'baseline' and current['reports'][0]['status'] == 'passed', current
        assert 'HARNESS_PROJECT_BASELINE_OK' in current['reports'][0]['checks'][0]['summary'], current
        assert fixture.call('runtime.status', {'runId': check_run})['status'] == 'completed'
        capture('approval-starts-stage', 'В работе')
        assert 'Рассмотреть разрешения' not in terminal.screen()
        second.wait_text('В работе', ['Ждёт разрешения: 1'])
        mutate('cancel', approval_id)
        wait_status(approval_id, 'cancelled')
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            preview = fixture.call('projects.purgePreview', {'projectId': approval_id})
            if preview['available']:
                break
            terminal.drain(0.1)
        assert preview['available'], preview
        capture('approval-cancelled', 'Остановлен')
        preview = fixture.call('projects.purgePreview', {'projectId': approval_id})
        mutate('purge', approval_id, previewToken=preview['previewToken'])
        terminal.wait_text('Проект удалён')
        second.wait_text('Проект удалён')
        terminal.send('\x1b')
        second.send('\x1b')
        terminal.wait_text('Новый проект')
        second.wait_text('Новый проект')
        checks.append(case + '/approval-project-purged')

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
