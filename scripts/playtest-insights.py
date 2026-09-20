#!/usr/bin/env python3
"""Проверяет специалистов и проектные попытки в двух PTY на настоящем локальном runtime."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('insights_live', ROOT / 'scripts/playtest-live-screens.py')
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


def eventually(check, description):
    """Ожидает сохранённое состояние, не привязываясь к одному времени ответа модели."""
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError(description)


def run_case(node, root, width, frames, checks):
    root.mkdir()
    workspace, state = live.base.base.configure(root, 9)
    config = root / 'config/harness.json'
    manifest = json.loads(config.read_text())
    manifest['coordination'] = 'auto'
    config.write_text(json.dumps(manifest))
    fixture = live.Fixture(node, config, state, workspace)
    terminals = [live.Terminal(node, state, workspace, width, 24) for _ in range(2)]
    first, second = terminals
    prefix = f'{width}x24/'

    def capture(name, text, terminal=first):
        frame = terminal.wait_text(text)
        assert 'Harness by Ghost_Raven' in frame and 'Esc' in frame, frame
        assert len(frame.splitlines()) <= 24, frame
        frames[prefix + name] = frame
        checks.append(prefix + name)
        return frame

    def back(terminal, target):
        terminal.send('\x1b')
        terminal.wait_text(target)

    def project_action(method, project_id, **params):
        view = fixture.call('projects.detail', {'projectId': project_id})
        return fixture.call('projects.' + method, {'projectId': project_id,
            'expectedRevision': view['revision'], 'requestKey': str(uuid.uuid4()), **params})

    try:
        for terminal in terminals:
            terminal.wait_text('Чем займёмся?')
        run_id = live.start_task(fixture, workspace, 'Проверка специалистов')
        status = fixture.request('planRoles', {'runId': run_id, 'tasks': [
            {'role': 'researcher', 'task': 'Изучить доступность каталога', 'context': ''},
            {'role': 'reviewer', 'task': 'Проверить инструкции запуска', 'context': ''},
        ]})
        agents = {item['role']: item for item in status['agents']}
        for role in ['researcher', 'reviewer']:
            fixture.request('modelMessages', {'runId': run_id, 'agentId': agents[role]['id']})
        cli = [node, str(ROOT / 'dist/interfaces/cli.js'), '--state', str(state), '--json']
        summary = json.loads(subprocess.check_output(cli + ['insights', run_id], text=True))
        assert len(summary['agents']) == 3 and summary['completeness'] == 'complete', summary
        assert summary['agentTotal'] == 3 and summary['agentOffset'] == 0, summary
        checks.append(prefix + 'json-command-three-agents')
        page = json.loads(subprocess.check_output(cli + ['insights', run_id, '--offset', '1'], text=True))
        assert page['agentTotal'] == 3 and page['agentOffset'] == 1, page
        assert [agent['id'] for agent in page['agents']] == [agent['id'] for agent in summary['agents'][1:]], page
        checks.append(prefix + 'json-command-agent-offset')
        for terminal in terminals:
            terminal.open_label('Мои задачи')
            terminal.open_label('Проверка специалистов')
            terminal.wait_text('Ход задачи')
            terminal.send('\r')
            terminal.wait_text('Что дальше?')
            terminal.open_label('Работа специалистов')
            terminal.wait_text('Специалисты · 1/1')
        capture('tree-first-window', 'researcher')
        capture('tree-second-window', 'reviewer', second)
        first.open_label('researcher')
        second.open_label('reviewer')
        capture('researcher-task', 'Изучить доступность каталога')
        capture('reviewer-task', 'Проверить инструкции запуска', second)
        before = fixture.request('metrics')['modelRequests']
        first.send('\t')
        capture('separate-usage-sources', 'Время и токены')
        first.send('\x1b[F')
        capture('unknown-usage-is-labelled', 'Без данных о токенах')
        first.send('\t')
        capture('filtered-activity', 'Роль: researcher')
        assert 'Роль: reviewer' not in first.screen()
        recent = fixture.request('metrics')['recent']
        activity = [item for item in recent if item['method'] == 'runtime.activity']
        assert activity and all(item['params']['limit'] == 100 for item in activity), activity
        assert {item['params']['agentId'] for item in activity} == {
            agents['researcher']['id'], agents['reviewer']['id']}, activity
        checks.append(prefix + 'activity-cursors-filter-agents')
        assert fixture.request('metrics')['modelRequests'] == before
        checks.append(prefix + 'screen-polling-does-not-infer')
        fixture.request('answerAgent', {'runId': run_id, 'agentId': agents['researcher']['id'],
                                        'text': 'Каталог доступен. Проверено исследователем.'})
        first.send('\t')
        capture('individual-result', 'Проверено исследователем.')
        capture('second-agent-still-working', 'Проверить инструкции запуска', second)
        fixture.call('runtime.cancel', {'runId': run_id})
        eventually(lambda: fixture.call('runtime.status', {'runId': run_id})['status'] == 'cancelled',
                   'Отмена не завершилась')
        capture('cancel-updates-agent-card', 'Отменено', second)
        for terminal in terminals:
            back(terminal, 'Специалисты · 1/1')
            back(terminal, 'Что дальше?')
            terminal.open_label('В главное меню')
            terminal.wait_text('Чем займёмся?')
        before = fixture.counts('runtime.insights') + fixture.counts('runtime.activity')
        first.drain(1.3)
        second.drain(1.3)
        assert fixture.counts('runtime.insights') + fixture.counts('runtime.activity') == before
        checks.append(prefix + 'leaving-stops-insights-polling')

        project = fixture.call('projects.create', {'title': 'Команда проекта', 'goal': 'Изучить проект',
            'workspace': str(workspace), 'profile': 'fixture', 'requestKey': str(uuid.uuid4())})
        project_id = project['projectId']
        project_action('editPlan', project_id, plan={'maxCorrections': 2, 'fixBaselineFailures': False,
            'stages': [{'id': 'inspect', 'title': 'Изучить папку', 'task': 'Исследовать содержимое',
                'role': 'coordinator', 'dependsOn': [], 'expectedResult': 'Описание содержимого',
                'requiredTools': [], 'verification': {'kind': 'manual', 'instructions': 'Сверить описание'}}]})
        project_action('acceptPlan', project_id, expectedPlanVersion=1)
        eventually(lambda: fixture.call('projects.insights', {'projectId': project_id})['total'] > 0,
                   'Проектный запуск не появился в метриках')
        project_json = json.loads(subprocess.check_output(cli + ['projects', 'insights', project_id], text=True))
        assert project_json['total'] == 1 and project_json['items'][0]['stageId'] == 'inspect', project_json
        checks.append(prefix + 'project-command-attempt')
        for terminal in terminals:
            terminal.open_label('Проекты')
            terminal.open_label('Команда проекта')
            terminal.wait_text('Обзор')
            terminal.send('\r')
            terminal.wait_text('Что дальше?')
            terminal.open_label('Работа специалистов')
            terminal.wait_text('Выберите попытку')
        capture('project-attempt-first-window', 'попытка')
        capture('project-attempt-second-window', 'попытка', second)
        first.open_label('Выполнение этапа')
        first.open_label('coordinator')
        capture('project-specialist-task', 'Исследовать содержимое')
        project_action('pause', project_id)
        eventually(lambda: fixture.call('projects.detail', {'projectId': project_id})['status'] == 'paused',
                   'Проект не приостановился')
        capture('project-pause-live', 'Приостанов', second)
        project_action('cancel', project_id)
        back(first, 'Специалисты · 1/1')
        back(first, 'Выберите попытку')
        for terminal in terminals:
            back(terminal, 'Что дальше?')
            terminal.open_label('К списку проектов')
            terminal.wait_text('Новый проект')
            back(terminal, 'Чем займёмся?')
        before = fixture.counts('projects.insights')
        first.drain(1.3)
        second.drain(1.3)
        assert fixture.counts('projects.insights') == before
        checks.append(prefix + 'leaving-stops-project-polling')
        for terminal in terminals:
            terminal.open_label('Выход')
            terminal.finish()
        checks.append(prefix + 'two-windows-exit')
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
    frames, checks = {}, []
    try:
        with tempfile.TemporaryDirectory(prefix='harness-insights-pty-') as folder:
            for width in [48, 80]:
                run_case(str(Path(args.node).resolve()), Path(folder).resolve() / str(width), width, frames, checks)
    finally:
        if args.output:
            Path(args.output).write_text(json.dumps({'buildManifestSha256': hashlib.sha256(manifest).hexdigest(),
                'checks': checks, 'frames': frames}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    assert manifest == (ROOT / 'dist/build-manifest.json').read_bytes(), 'Сборка изменилась во время PTY'
    print(json.dumps({'checks': len(checks), 'sizes': ['48x24', '80x24'], 'windows': 2}, ensure_ascii=False))


if __name__ == '__main__':
    main()
