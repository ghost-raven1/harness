#!/usr/bin/env python3
"""Проходит учебный сценарий в настоящем PTY: от принятия плана до экспорта и удаления временных данных."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


live = module('demo_live_screens', 'playtest-live-screens.py')
cli = module('demo_cli', 'playtest-cli.py')


class DemoTerminal(live.Terminal):
    def __init__(self, node, root, width):
        previous = os.environ.get('TMPDIR')
        os.environ['TMPDIR'] = str(root / 'tmp')
        (root / 'tmp').mkdir()
        try:
            cli.Terminal.__init__(self, node, root / 'ordinary-state', root, width, ['demo'])
        finally:
            if previous is None:
                os.environ.pop('TMPDIR', None)
            else:
                os.environ['TMPDIR'] = previous
        self.columns, self.rows = width, 45
        self.resize(width, 24)


def run_case(node, root, width, frames, checks):
    root.mkdir()
    terminal = DemoTerminal(node, root, width)
    prefix = f'{width}x24/'

    def capture(name, text):
        frame = terminal.wait_text(text)
        assert 'ДЕМО' in frame, frame
        frames[prefix + name] = frame
        checks.append(prefix + name)

    try:
        capture('temporary-notice', 'Данные временные')
        demo = next((root / 'tmp').glob('harness-demo-*'))
        terminal.open_label('Начать учебный проект')
        # Поддерживает уже открытую первую сборку с выбором сохранённого черновика.
        terminal.drain(0.5)
        if 'Продолжить сообщение' in terminal.screen():
            terminal.open_label('Исправить расчёт')
            terminal.open_label('Продолжить ввод')
        capture('parameters', 'Проверьте параметры')
        terminal.open_label('Подготовить план')
        terminal.wait_text('Передать эту цель модели?')
        terminal.send('\x1b[D\r')
        terminal.wait_text('Обзор')
        terminal.send('\r')
        terminal.open_label('Принять план')
        capture('plan', 'Перед принятием плана')
        terminal.send('\r')
        terminal.wait_text('Принять план и начать')
        terminal.send('\x1b[D\r')
        capture('verified', 'Принять результат')
        assert (demo / 'workspace/price.js').read_text() == 'export const total = (price, quantity) => price * quantity;\n'
        snapshots = list((demo / 'state/project-records').glob('*.jsonl'))
        assert snapshots, 'Нет сохранённого проекта'
        project = json.loads(snapshots[0].read_text().splitlines()[-1])['state']
        assert [report['status'] for report in project['reports']] == ['failed', 'failed', 'passed', 'passed']
        checks.append(prefix + 'real-failure-and-correction')
        terminal.open_label('Изменения файлов')
        capture('intervals', 'Какой промежуток сравнить?')
        terminal.open_label('Весь проект')
        terminal.open_label('price.js')
        capture('diff', 'price * quantity')
        terminal.send('\t')
        capture('before', 'price + quantity')
        terminal.send('\t')
        capture('after', 'price * quantity')
        terminal.send('\x1b')
        terminal.wait_text('Выберите файл для сравнения')
        terminal.send('\x1b')
        terminal.wait_text('Какой промежуток сравнить?')
        terminal.send('\x1b')
        terminal.wait_text('Что дальше?')
        terminal.open_label('Принять результат')
        capture('review', 'Приёмка проекта')
        terminal.send('\r')
        terminal.wait_text('Принять проверенный')
        terminal.send('\x1b[D\r')
        capture('accepted', 'Принят')
        terminal.open_label('Экспорт результата')
        terminal.open_label('Включить построчные')
        terminal.open_label('Предпросмотр')
        capture('export-preview', 'Предпросмотр экспорта')
        terminal.send('\r')
        terminal.wait_text('Создать показанный файл?')
        terminal.send('\x1b[D\r')
        capture('export-created', 'Отчёт сохранён')
        exports = list((demo / 'state/exports/projects').rglob('*.md'))
        assert len(exports) == 1
        assert 'price * quantity' in exports[0].read_text()
        terminal.send('\x1b')
        terminal.wait_text('Что дальше?')
        terminal.open_label('К списку проектов')
        terminal.wait_text('Начнём?')
        terminal.open_label('Выйти из демо')
        terminal.finish()
        assert not demo.exists(), 'Учебные данные остались после выхода'
        assert not (root / 'ordinary-state').exists(), 'Демо затронуло обычное состояние'
        assert 'Временные данные удалены' in terminal.text
        checks.append(prefix + 'clean-exit')
    finally:
        terminal.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    parser.add_argument('--output', default='releases/project-playtest/demo-frames.json')
    args = parser.parse_args()
    frames, checks = {}, []
    try:
        with tempfile.TemporaryDirectory(prefix='harness-demo-pty-', dir='/tmp') as temporary:
            for width in [48, 80]:
                run_case(str(Path(args.node).resolve()), Path(temporary) / str(width), width, frames, checks)
    finally:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({'frames': frames, 'checks': checks}, ensure_ascii=False, indent=2))
    print(json.dumps({'passed': len(checks), 'output': args.output}, ensure_ascii=False))


if __name__ == '__main__':
    main()
