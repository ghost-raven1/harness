#!/usr/bin/env python3
"""Проверяет сохранённые сравнения в двух настоящих PTY без облака и пользовательского состояния."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('diff_live_base', ROOT / 'scripts/playtest-live-screens.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def run_case(node, root, width, frames, checks):
    root.mkdir()
    workspace, state = base.base.base.configure(root, 9)
    (workspace / 'notes.txt').write_text('Прежняя строка\nДо изменения\n', encoding='utf-8')
    (workspace / 'long.txt').write_text('Прежний длинный текст\n' + 'я' * 20000 + '\nBEFORE_END', encoding='utf-8')
    fixture = base.Fixture(node, root / 'config/harness.json', state, workspace)
    first = base.Terminal(node, state, workspace, width, 24)
    second = base.Terminal(node, state, workspace, width, 24)
    case = f'{width}x24'

    def capture(name, marker, terminal=first):
        frame = terminal.wait_text(marker)
        assert 'Esc' in frame and 'Harness by Ghost_Raven' in frame, frame
        frames[f'{case}/{name}'] = frame
        checks.append(f'{case}/{name}')
        return frame

    def detail(project_id):
        return fixture.call('projects.detail', {'projectId': project_id})

    def mutate(method, project_id, **params):
        view = detail(project_id)
        return fixture.call('projects.' + method, {'projectId': project_id,
            'expectedRevision': view['revision'], 'requestKey': str(uuid.uuid4()), **params})

    def wait_status(project_id, status):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            view = detail(project_id)
            if view['status'] == status:
                return view
            first.drain(0.1)
        raise AssertionError(json.dumps(view, ensure_ascii=False))

    def open_changes(terminal, project_title):
        terminal.wait_text('Чем займёмся?')
        terminal.open_label('Проекты')
        terminal.open_label(project_title)
        terminal.wait_text('Обзор')
        terminal.send('\r')
        terminal.open_label('Изменения файлов')
        terminal.open_label('Работа этапа')
        terminal.wait_text('Выберите файл')

    try:
        assert 'projects-diff-v1' in fixture.call('system.info')['capabilities']
        project = fixture.call('projects.create', {'title': 'Проверка сравнения', 'goal': 'Изменить два текстовых файла',
            'workspace': str(workspace), 'profile': 'fixture', 'requestKey': str(uuid.uuid4()), 'captureEnabled': True})
        project_id = project['projectId']
        mutate('editPlan', project_id, plan={'maxCorrections': 2, 'fixBaselineFailures': False, 'stages': [{
            'id': 'implement', 'title': 'Обновление текстов', 'task': 'Обновить заметки', 'role': 'coordinator',
            'dependsOn': [], 'expectedResult': 'Новые строки доступны', 'requiredTools': [],
            'verification': {'kind': 'manual', 'instructions': 'Прочитайте обновлённые заметки'},
        }]})
        current = detail(project_id)
        mutate('acceptPlan', project_id, expectedPlanVersion=current['planVersion'])
        running = wait_status(project_id, 'running')
        (workspace / 'notes.txt').write_text('Новая строка\nПосле изменения\n', encoding='utf-8')
        (workspace / 'long.txt').write_text('Новый длинный текст\n' + 'ю' * 20000 + '\nAFTER_END', encoding='utf-8')
        fixture.request('answer', {'runId': running['currentRunId'], 'text': 'Тексты обновлены. Проверьте сохранённые изменения.'})
        wait_status(project_id, 'paused')
        open_changes(first, 'Проверка сравнения')
        capture('files', 'notes.txt')
        first.open_label('notes.txt')
        capture('diff', 'Новая строка')
        first.send('\t')
        capture('before', 'Прежняя строка')
        first.send('\t')
        capture('after', 'После изменения')
        open_changes(second, 'Проверка сравнения')
        second.open_label('notes.txt')
        second.send('\t\t')
        capture('second-window-after', 'После изменения', second)
        (workspace / 'notes.txt').write_text('ВНЕШНЯЯ НОВАЯ ПРАВКА', encoding='utf-8')
        first.drain(1.3)
        second.drain(1.3)
        assert 'После изменения' in first.screen() and 'ВНЕШНЯЯ НОВАЯ ПРАВКА' not in first.screen()
        assert 'После изменения' in second.screen() and 'ВНЕШНЯЯ НОВАЯ ПРАВКА' not in second.screen()
        checks.append(case + '/immutable-saved-points-two-windows')
        first.send('\x1b')
        first.wait_text('Выберите файл')
        first.open_label('long.txt')
        first.wait_text('Enter — страницы')
        first.send('\r')
        first.open_label('Следующая страница · После')
        first.send('\t\t\x1b[F')
        capture('full-after-page', 'AFTER_END')
        first.send('\x1b')
        first.wait_text('Выберите файл')
        first.send('\x1b')
        first.wait_text('Какой промежуток')
        first.send('\x1b')
        first.wait_text('Что дальше?')
        first.open_label('Сохранять содержимое')
        capture('capture-confirmation', 'Отключить сохранение')
        first.send('\x1b[D\r')
        first.wait_text('Что дальше?')
        assert detail(project_id)['capture']['enabled'] is False
        checks.append(case + '/future-capture-disabled-with-confirmation')
        # Чтение второго окна не зависит от последующего выключения новых снимков.
        assert 'После изменения' in second.screen()
        mutate('cancel', project_id)
        wait_status(project_id, 'cancelled')
        preview = fixture.call('projects.purgePreview', {'projectId': project_id})
        assert preview['available'], preview
        mutate('purge', project_id, previewToken=preview['previewToken'])
        capture('removed-while-reading', 'Проект удалён', second)
        first.wait_text('Проект удалён')
        for terminal in [first, second]:
            terminal.send('\x1b')
            terminal.wait_text('Новый проект')
            terminal.send('\x1b')
            terminal.wait_text('Чем займёмся?')
            terminal.open_label('Выход')
            terminal.finish()
        checks.append(case + '/both-windows-exit')
    finally:
        first.close()
        second.close()
        fixture.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    parser.add_argument('--output')
    args = parser.parse_args()
    manifest = (ROOT / 'dist/build-manifest.json').read_bytes()
    frames, checks = {}, []
    try:
        with tempfile.TemporaryDirectory(prefix='harness-diff-pty-') as folder:
            for width in [48, 80]:
                run_case(str(Path(args.node).resolve()), Path(folder).resolve() / str(width), width, frames, checks)
    finally:
        if args.output:
            Path(args.output).write_text(json.dumps({'buildManifestSha256': hashlib.sha256(manifest).hexdigest(),
                'checks': checks, 'frames': frames}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    assert (ROOT / 'dist/build-manifest.json').read_bytes() == manifest, 'Сборка изменилась во время PTY.'
    print(json.dumps({'checks': len(checks), 'sizes': ['48x24', '80x24'], 'windows': 2,
        'provider': 'local fixture'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
