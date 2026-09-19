#!/usr/bin/env python3
"""Проверяет содержимое экрана PTY через pyte; тестовый API не расходует облачные токены."""
import argparse
import fcntl
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import shutil
import struct
import tempfile
import termios
import threading
import time
import pyte

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('cli_playtest', ROOT / 'scripts/playtest-cli.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
advance = threading.Event()
finish = threading.Event()


class Api(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()

        def send(delta, done=None):
            chunk = {'id': 'stream', 'object': 'chat.completion.chunk', 'created': 1,
                     'model': 'fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': done}]}
            self.wfile.write(('data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\n').encode())
            self.wfile.flush()
        try:
            send({'reasoning_content': 'Публичное пояснение: проверяю файл.'})
            send({'content': '\n'.join('Строка %03d' % i for i in range(100)) + '\n'})
            if not advance.wait(40):
                return
            send({'content': '\n'.join('Строка %03d' % i for i in range(100, 130)) + '\n'})
            if not finish.wait(40):
                return
            send({'content': 'Работа завершена.'})
            send({}, 'stop')
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError):
            pass


class Terminal(base.Terminal):
    def drain(self, duration=0.4):
        until = time.monotonic() + duration
        while time.monotonic() < until:
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    self.raw += os.read(self.fd, 65536)
                except OSError:
                    break

    def resize(self, columns, rows=24):
        self.columns, self.rows = columns, rows
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        self.drain()

    def screen(self):
        self.drain()
        screen = pyte.Screen(self.columns, self.rows)
        pyte.Stream(screen).feed(self.raw.decode('utf8', 'replace'))
        return '\n'.join(line.rstrip() for line in screen.display)

    def visible(self, text, absent=()):
        deadline = time.monotonic() + 5
        while True:
            screen = self.screen()
            if text in screen and not any(old in screen for old in absent):
                return screen
            if time.monotonic() >= deadline:
                break
        assert text in screen, 'Нет ' + text + '\n' + screen
        for old in absent:
            assert old not in screen, 'Остался прошлый экран: ' + old + '\n' + screen
        return screen

    def select_label(self, label):
        self.send('\x1b[H')
        for _ in range(30):
            selected = next((line for line in self.screen().splitlines()
                             if re.match(r'^\s*│?\s*● ', line)), '')
            if label in selected:
                return
            self.send('\x1b[B')
        raise AssertionError('Пункт не найден: ' + label + '\n' + self.screen())

    def open_label(self, label):
        self.select_label(label)
        self.send('\r')


def configure(root, port):
    workspace, state, config = root / 'Проект', root / 'state', root / 'config'
    workspace.mkdir()
    state.mkdir(mode=0o700)
    shutil.copytree(ROOT / 'config', config)
    manifest = json.loads((config / 'harness.json').read_text())
    manifest.update(workspaces=[str(workspace)], defaultProfile='fixture', coordination='manual')
    (config / 'harness.json').write_text(json.dumps(manifest))
    (config / 'profiles.json').write_text(json.dumps({'fixture': {
        'provider': 'openai-compatible', 'model': 'fixture', 'baseUrl': f'http://127.0.0.1:{port}/v1',
        'contextTokens': 32000, 'outputTokens': 3000, 'timeoutMs': 90000, 'retries': 0}}))
    (config / 'learning.json').write_text(json.dumps({'enabled': False, 'cases': []}))
    (state / 'desktop.json').write_text(json.dumps({'configFile': str(config / 'harness.json'),
                                                  'workspace': str(workspace), 'profile': 'fixture'}))
    return workspace, state


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    api = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Api)
    threading.Thread(target=api.serve_forever, daemon=True).start()
    screens = {}
    with tempfile.TemporaryDirectory(prefix='harness-screen-') as directory:
        workspace, state = configure(Path(directory).resolve(), api.server_port)
        terminal = Terminal(str(Path(args.node).resolve()), state, workspace)
        terminal.columns, terminal.rows = 90, 45
        try:
            terminal.expect('Чем займёмся?')
            terminal.open_label('Как пользоваться')
            terminal.expect('Продолжить')
            screens['help'] = terminal.visible('Как пользоваться', ['Чем займёмся?'])
            terminal.choose()
            terminal.expect('Чем займёмся?')
            terminal.visible('Главное меню', ['Примеры:', 'Продолжить'])
            terminal.open_label('Настройки')
            terminal.expect('Расход токенов')
            terminal.open_label('Расход токенов')
            terminal.expect('Оценка Harness')
            terminal.visible('Расход токенов', ['Чем займёмся?', 'Подключить другую модель', 'Квота'])
            terminal.send('\x1b')
            terminal.expect('Чем займёмся?')
            screens['main'] = terminal.visible('Главное меню', ['Оценка Harness', 'Сегодня (UTC):'])
            terminal.open_label('Новая задача')
            terminal.expect('Что нужно сделать?')
            terminal.send('Проверка живого экрана\x13')
            terminal.expect('Строка 099')
            terminal.visible('Строка 099', ['Чем займёмся?', 'Что нужно сделать?'])
            terminal.send('\t\t')
            terminal.drain()
            screens['reasoning'] = terminal.visible('Публичное пояснение', ['Строка 099'])
            terminal.send('\t')
            terminal.send('\x1b[5~\x1b[5~')
            before = terminal.visible('Ответ')
            rows_before = re.findall(r'Строка\s+(\d{3})', before)
            assert rows_before, 'Прокрутка не показала строки ответа:\n' + before
            assert '099' not in rows_before, 'Прокрутка осталась у конца ответа:\n' + before
            advance.set()
            terminal.drain(0.7)
            after = terminal.screen()
            assert re.findall(r'Строка\s+(\d{3})', after) == rows_before, after
            terminal.send('\x1b[F')
            terminal.expect('Строка 129')
            terminal.resize(48)
            screens['narrow'] = terminal.visible('Esc — назад')
            assert 'Enter — действия' in screens['narrow']
            terminal.send('\x1b')
            terminal.expect('Чем займёмся?')
            terminal.visible('Главное меню', ['Строка 129', 'Публичное пояснение'])
            terminal.open_label('Мои задачи')
            terminal.expect('Мои задачи · страница')
            terminal.choose()
            terminal.expect('Строка 129')
            terminal.send('\t\t')
            terminal.visible('Публичное пояснение')
            finish.set()
            terminal.drain(0.7)
            terminal.send('\r')
            terminal.expect('Что дальше?')
            terminal.visible('Что дальше?', ['Публичное пояснение', 'Строка 129'])
            terminal.open_label('Убрать из списка')
            terminal.expect('Убрать эту задачу из списка?')
            terminal.choose()
            terminal.expect('Что дальше?')
            records = [json.loads(path.read_text()) for path in (state / 'runs').glob('*.json')]
            assert len(records) == 1 and not records[0].get('deletedAt')
            terminal.open_label('Убрать из списка')
            terminal.expect('Убрать эту задачу из списка?')
            terminal.send('\x1b[D\r')
            terminal.expect('Продолжить')
            screens['delete-feedback'] = terminal.visible('Задача убрана из списка.', ['Состояние задачи', 'Что дальше?'])
            terminal.choose()
            terminal.expect('Чем займёмся?')
            terminal.open_label('Мои задачи')
            terminal.expect('Мои задачи · страница')
            screens['deleted'] = terminal.visible('Найти задачу или ответ', ['Проверка живого экрана'])
            terminal.choose(-1)
            terminal.expect('Чем займёмся?')
            terminal.open_label('Выход')
            terminal.expect('История сохранена.')
            until = time.monotonic() + 5
            while b'\x1b[?1049l' not in terminal.raw and time.monotonic() < until:
                terminal.drain(0.1)
            terminal.finish()
            terminal.drain()
            assert b'\x1b[?1049h' in terminal.raw and b'\x1b[?1049l' in terminal.raw, repr(terminal.raw[-700:])
            record = json.loads(next((state / 'runs').glob('*.json')).read_text())
            assert record['deletedAt'] and record['status'] == 'completed'
            assert 'Работа завершена.' in record['result']
            assert list((state / 'output').glob('*.jsonl'))
            assert not (state / 'daemon.lock').exists()
        finally:
            advance.set()
            finish.set()
            terminal.close()
    api.shutdown()
    report = {'platform': os.uname().sysname, 'checks': ['page-replacement', 'help-back', 'budget-back',
              'live-text', 'live-reasoning', 'tab-filter', 'scroll-anchor', '48x24-resize', 'escape-back',
              'reopen-history', 'delete-cancel', 'delete-confirm', 'delete-feedback', 'audit-retained', 'alternate-buffer-exit']}
    (ROOT / 'docs/playtest-task-screen.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (ROOT / '.harness').mkdir(exist_ok=True)
    (ROOT / '.harness/task-screen-playtest.json').write_text(json.dumps(screens, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
