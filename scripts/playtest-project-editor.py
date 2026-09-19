#!/usr/bin/env python3
"""Проводит новичка через формы проекта в двух настоящих терминалах без редактирования JSON."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('project_editor_base', ROOT / 'scripts/playtest-live-screens.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def run_case(node, root, width, frames, checks):
    root.mkdir()
    workspace, state = base.base.base.configure(root, 9)
    fixture = base.Fixture(node, root / 'config/harness.json', state, workspace)
    terminal = base.Terminal(node, state, workspace, width, 24)
    second = base.Terminal(node, state, workspace, width, 24)
    prefix = f'{width}x24/'

    def capture(name, text):
        frames[prefix + name] = terminal.wait_text(text)
        checks.append(prefix + name)

    def detail(project_id):
        return fixture.call('projects.detail', {'projectId': project_id})

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
        terminal.open_label('Новый проект')
        terminal.wait_text('Какого результата')
        terminal.send('Новичок проверяет проект\x13')
        capture('parameters', 'Проверьте параметры')
        terminal.open_label('Сохранить черновик')
        terminal.wait_text('Новый проект')
        assert fixture.call('projects.list')['total'] == 0
        assert fixture.counts('projects.plan') == 0
        checks.append(prefix + 'cancel-before-model')
        terminal.open_label('Новый проект')
        terminal.open_label('Новичок проверяет')
        terminal.open_label('Продолжить ввод')
        capture('restored-parameters', 'Проверьте параметры')
        terminal.open_label('Выбрать модель')
        terminal.open_label('fixture')
        terminal.open_label('Подготовить план')
        capture('planning-confirmation', 'Передать эту цель модели?')
        terminal.send('\x1b[D\r')
        terminal.wait_text('Обзор')
        created = fixture.call('projects.list')['items'][0]
        project_id = created['projectId']
        current = wait_status(project_id, 'planning')
        # JSON является ответом тестового провайдера, человек вводит только обычный текст в формы.
        plan = {'maxCorrections': 2, 'fixBaselineFailures': False, 'stages': [{
            'id': 'inspect', 'title': 'Проверка страницы', 'task': 'Изучить страницу',
            'role': 'coordinator', 'dependsOn': [], 'expectedResult': 'Понятная страница',
            'requiredTools': ['fs.read'],
            'verification': {'kind': 'manual', 'instructions': 'Прочитать страницу'},
        }]}
        fixture.request('answer', {'runId': current['currentRunId'], 'text': json.dumps(plan)})
        wait_status(project_id, 'ready')
        terminal.send('\r')
        terminal.open_label('Редактировать план')
        capture('editor', 'Измените план')
        terminal.open_label('Проверка страницы')
        terminal.open_label('Задача специалисту')
        terminal.wait_text('Задача специалисту')
        terminal.send(' и проверить доступность\x13')
        terminal.open_label('К плану')
        terminal.open_label('Копировать этап')
        terminal.open_label('Проверка страницы')
        capture('copy-stage', 'копия')
        terminal.open_label('Удалить незавершённый')
        terminal.open_label('копия')
        terminal.open_label('Проверить черновик')
        capture('validation', 'Проверка пройдена')
        second.open_label('Проекты')
        second.open_label('Новичок проверяет')
        second.wait_text('Обзор')
        second.send('\r')
        second.open_label('Редактировать план')
        second.open_label('Новое сообщение')
        second.open_label('Предел исправлений')
        second.wait_text('Предел исправлений от 0 до 10')
        second.drain(0.3)
        second.send('\x7f3\x13')
        second.open_label('Сохранить новую версию')
        second.wait_text('Создать одну новую версию?')
        second.send('\x1b[D\r')
        second.wait_text('Что дальше?')
        capture('stale-preserves-input', 'Ваш ввод')
        terminal.open_label('Сравнить с актуальным')
        capture('compare-stale', 'Сравнение')
        terminal.send('\x1b[F')
        capture('literal-task-diff', 'доступность')
        terminal.send('\x1b')
        terminal.wait_text('Измените план')
        terminal.open_label('Оставить черновик')
        terminal.wait_text('Что дальше?')
        terminal.open_label('Принять план')
        capture('compare-before-accept', 'Перед принятием плана')
        terminal.send('\r')
        terminal.wait_text('Принять план и начать')
        terminal.send('\x1b[D\r')
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            current = detail(project_id)
            stage = next((stage for stage in current['stages'] if stage['status'] == 'running' and stage.get('runId')), None)
            if stage:
                break
            terminal.drain(0.1)
        assert stage, current
        fixture.request('answer', {'runId': stage['runId'], 'text': 'Страница прочитана. Результат сохранён.'})
        wait_status(project_id, 'paused')
        terminal.open_label('Проверить результат вручную')
        terminal.open_label('Проверка страницы')
        terminal.wait_text('Прочитать страницу')
        terminal.send('\r')
        terminal.open_label('Всё работает')
        terminal.wait_text('Что проверено')
        terminal.send('Страница понятна\r')
        terminal.wait_text('Зафиксировать')
        terminal.send('\x1b[D\r')
        wait_status(project_id, 'review')
        terminal.open_label('Принять результат')
        capture('expected-received-confirmed', 'Приёмка проекта')
        terminal.send('\r')
        terminal.wait_text('Принять проверенный')
        terminal.send('\x1b[D\r')
        wait_status(project_id, 'completed')
        terminal.open_label('Экспорт результата')
        terminal.open_label('Предпросмотр')
        capture('export-composition', 'Предпросмотр экспорта')
        terminal.send('\r')
        terminal.wait_text('Создать показанный файл?')
        terminal.send('\x1b[D\r')
        capture('export-saved', 'Отчёт сохранён')
        exported = list((state / 'exports/projects' / project_id).glob('*.md'))
        assert len(exported) == 1, exported
        assert not list(workspace.glob('*.md'))
        checks.append(prefix + 'export-outside-workspace')
        terminal.send('\x1b')
        terminal.wait_text('Что дальше?')
        terminal.open_label('К списку проектов')
        terminal.wait_text('Новый проект')
        terminal.send('\x1b')
        terminal.wait_text('Чем займёмся?')
        terminal.open_label('Выход')
        terminal.finish()
        second.open_label('К списку проектов')
        second.wait_text('Новый проект')
        second.send('\x1b')
        second.wait_text('Чем займёмся?')
        second.open_label('Выход')
        second.finish()
        checks.append(prefix + 'novice-two-windows-exit')
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
    try:
        with tempfile.TemporaryDirectory(prefix='harness-project-editor-pty-') as folder:
            for width in [48, 80]:
                run_case(str(Path(args.node).resolve()), Path(folder) / str(width), width, frames, checks)
    finally:
        if args.output:
            Path(args.output).write_text(json.dumps({'buildManifestSha256': hashlib.sha256(manifest).hexdigest(), 'checks': checks, 'frames': frames}, ensure_ascii=False, indent=2) + '\n')
    assert manifest == (ROOT / 'dist/build-manifest.json').read_bytes(), 'Сборка изменилась во время PTY'
    print(json.dumps({'checks': len(checks), 'sizes': ['48x24', '80x24'], 'windows': 2, 'provider': 'local fixture'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
