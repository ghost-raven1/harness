#!/usr/bin/env python3
"""Проверяет настоящий терминал и HTTP API в отдельной временной папке на macOS/Linux."""
import argparse
import hashlib
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
DOWN = '\x1b[B'
UP = '\x1b[A'
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
requests = []
keys_seen = []


def digest(directory, suffix):
    value = hashlib.sha256()
    for path in sorted(directory.rglob('*' + suffix)):
        value.update(str(path.relative_to(ROOT)).encode())
        value.update(path.read_bytes())
    return value.hexdigest()


class Api(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        key = self.headers.get('Authorization')
        keys_seen.append(key)
        if key == 'Bearer wrong-fixture-key':
            self.send_response(401)
            self.end_headers()
            self.wfile.write(b'Unauthorized')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'data': [{'id': 'fixture-model'}]}).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        contents = json.dumps(body['messages'], ensure_ascii=False)
        plan_tool = next((tool['function']['name'] for tool in body.get('tools', [])
                          if tool['function']['description'].startswith('agents.plan:')), None)
        if 'Медленная задача' in contents and not plan_tool:
            time.sleep(20)
        if plan_tool:
            delta = {'tool_calls': [{'index': 0, 'id': 'plan-' + str(len(requests)), 'type': 'function', 'function': {
                'name': plan_tool, 'arguments': json.dumps({'mode': 'direct',
                    'reason': 'Одна небольшая проверка', 'tasks': []}, ensure_ascii=False)
            }}]}
        elif 'Уточни результат' in contents:
            delta = {'content': 'Уточнение выполнено.'}
        elif body.get('tools') and 'Первая проверка' in contents and not any(m.get('tool_call_id') == 'write-1' for m in body['messages']):
            tool = next(t['function']['name'] for t in body['tools'] if t['function']['description'].startswith('fs.write:'))
            delta = {'tool_calls': [{'index': 0, 'id': 'write-1', 'type': 'function', 'function': {
                'name': tool, 'arguments': json.dumps({'path': 'playtest.txt', 'content': 'Проверено в терминале'}, ensure_ascii=False)
            }}]}
        else:
            delta = {'content': 'Файл создан и проверен.'}
        def chunk(delta, finish):
            return {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': 'fixture-model', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for value in [chunk(delta, None), chunk({}, 'tool_calls' if 'tool_calls' in delta else 'stop')]:
                self.wfile.write(('data: ' + json.dumps(value, ensure_ascii=False) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError):
            pass


class Terminal:
    def __init__(self, node, state, workspace, columns=90, arguments=None):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ.update(HOME=str(workspace), TERM='xterm-256color', NO_COLOR='1')
            os.environ.pop('HARNESS_MODEL_API_KEY', None)
            os.chdir(workspace)
            os.execv(node, [node, str(ROOT / 'dist/interfaces/cli.js'), '--state', str(state), *(arguments or [])])
        import fcntl
        import struct
        import termios
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 45, columns, 0, 0))
        self.raw = b''
        self.cursor = 0
        self.stopped = False

    @property
    def text(self):
        return ANSI.sub('', self.raw.decode('utf8', 'replace')).replace('\r', '')

    def expect(self, text, timeout=20):
        until = time.monotonic() + timeout
        while True:
            found = self.text.find(text, self.cursor)
            if found >= 0:
                self.cursor = found + len(text)
                return
            if time.monotonic() > until:
                raise AssertionError('Ожидалось: ' + text + '\nПоследний экран:\n' + self.text[-3500:])
            if select.select([self.fd], [], [], 0.2)[0]:
                try:
                    self.raw += os.read(self.fd, 65536)
                except OSError:
                    raise AssertionError('Терминал закрылся раньше: ' + text + '\n' + self.text[-2000:])

    def send(self, value):
        time.sleep(0.08)
        os.write(self.fd, value.encode())

    def choose(self, steps=0):
        for _ in range(abs(steps)):
            self.send(DOWN if steps > 0 else UP)
        self.send('\r')

    def finish(self):
        until = time.monotonic() + 15
        while time.monotonic() < until:
            # Терминал продолжает читать вывод: иначе финальная перерисовка заполнит буфер PTY.
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    self.raw += os.read(self.fd, 65536)
                except OSError:
                    pass
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.stopped = True
                assert os.waitstatus_to_exitcode(status) == 0, status
                return
            time.sleep(0.1)
        raise AssertionError('Приложение не закрылось')

    def close(self):
        if not self.stopped:
            os.kill(self.pid, signal.SIGTERM)
            until = time.monotonic() + 8
            while time.monotonic() < until:
                if select.select([self.fd], [], [], 0.1)[0]:
                    try:
                        self.raw += os.read(self.fd, 65536)
                    except OSError:
                        pass
                if os.waitpid(self.pid, os.WNOHANG)[0]:
                    break
            else:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
        os.close(self.fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    source, before = digest(ROOT / 'src', '.ts'), digest(ROOT / 'dist', '.js')
    api = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Api)
    threading.Thread(target=api.serve_forever, daemon=True).start()
    screens = []
    with tempfile.TemporaryDirectory(prefix='harness-cli-') as directory:
        root = Path(directory).resolve()
        workspace, state = root / 'Проект с пробелами', root / 'state'
        workspace.mkdir()
        (workspace / 'playtest.txt').write_text('Исходный файл для восстановления')
        terminal = Terminal(str(Path(args.node).resolve()), state, workspace)
        try:
            terminal.expect('Папка для работы:')
            terminal.choose()
            terminal.expect('Какую модель подключим?')
            terminal.choose(4)
            terminal.expect('Подключение к')
            terminal.choose(1)
            terminal.expect('Адрес API из настроек сервера')
            terminal.send('\x01\x0b' + f'http://127.0.0.1:{api.server_port}/v1' + '\r')
            terminal.expect('Сервер требует ключ API?')
            terminal.send('\x1b[D\r')
            terminal.expect('Ключ API для')
            terminal.send('wrong-fixture-key\r')
            terminal.expect('Сохранить ключ в защищённом')
            terminal.choose()
            terminal.expect('Как продолжить?')
            terminal.choose(1)
            terminal.expect('Ключ API для')
            terminal.send('correct-fixture-key\r')
            terminal.expect('Сохранить ключ в защищённом')
            terminal.choose()
            terminal.expect('Выберите модель для задач')
            terminal.choose()
            terminal.expect('Чем займёмся?')
            terminal.choose()
            terminal.expect('Что нужно сделать?')
            terminal.send('Первая проверка: запиши playtest.txt\x13')
            terminal.expect('После: playtest.txt')
            terminal.expect('Разрешить однократное выполнение этой операции?')
            terminal.send('\x1b[D\r')
            terminal.expect('Что дальше?')
            assert (workspace / 'playtest.txt').read_text() == 'Проверено в терминале'
            terminal.choose(2)
            terminal.expect('Ответ сохранён')
            terminal.expect('Что дальше?')
            terminal.choose(4)
            terminal.expect('Какой файл вернуть')
            terminal.choose()
            terminal.expect('Восстановить прежнее содержимое?')
            terminal.send('\x1b[D\r')
            terminal.expect('Исходное состояние файла восстановлено.')
            assert (workspace / 'playtest.txt').read_text() == 'Исходный файл для восстановления'
            terminal.expect('Продолжить')
            terminal.choose()
            terminal.expect('Что дальше?')
            terminal.choose(4)
            terminal.expect('Расход токенов задачи')
            terminal.expect('Провайдер сообщил')
            terminal.expect('Esc — назад')
            terminal.send('\x1b')
            terminal.expect('Что дальше?')
            terminal.choose()
            terminal.expect('Ваш ответ модели или следующий шаг')
            terminal.send('Уточни результат\x13')
            terminal.expect('Уточнение выполнено.')
            terminal.expect('Что дальше?')
            terminal.choose(-1)
            terminal.expect('Чем займёмся?')
            terminal.choose()
            terminal.expect('Что нужно сделать?')
            terminal.send('\x1b')
            terminal.expect('Чем займёмся?')
            terminal.choose(-1)
            terminal.expect('История сохранена.')
            terminal.finish()
            screens.append(terminal.text)
            assert list(workspace.glob('Ответ Harness *.md'))
            records = [json.loads(p.read_text()) for p in (state / 'runs').glob('*.json')]
            assert len(records) == 2
            assert len({r['sessionId'] for r in records}) == 1
            for path in state.rglob('*'):
                if path.is_file():
                    assert b'correct-fixture-key' not in path.read_bytes(), str(path)
            assert not (state / 'daemon.lock').exists()
        finally:
            terminal.close()
        terminal = Terminal(str(Path(args.node).resolve()), state, workspace, columns=48)
        try:
            terminal.expect('Ключ API для')
            terminal.send('correct-fixture-key\r')
            terminal.expect('Сохранить ключ в защищённом')
            terminal.choose()
            terminal.expect('Чем займёмся?')
            terminal.choose(1)
            terminal.expect('Мои задачи · страница')
            terminal.choose(2)
            terminal.expect('Слова из задачи, ответа')
            terminal.send('Уточни\r')
            terminal.expect('Мои задачи · страница')
            terminal.choose()
            terminal.expect('Ход задачи')
            terminal.send('\r')
            terminal.expect('Что дальше?')
            terminal.choose(-1)
            terminal.expect('Чем займёмся?')
            terminal.choose()
            terminal.expect('Сохранённые черновики')
            terminal.choose()
            terminal.expect('Продолжить ввод')
            terminal.choose()
            terminal.expect('Что нужно сделать?')
            terminal.send('Медленная задача\x13')
            terminal.expect('Esc — назад')
            terminal.send('\x03')
            terminal.expect('Отменено')
            terminal.expect('Что дальше?')
            terminal.choose(-1)
            terminal.expect('Чем займёмся?')
            terminal.choose()
            terminal.expect('Что нужно сделать?')
            terminal.send('Медленная задача для выхода\x13')
            terminal.expect('Esc — назад')
            terminal.send('\x1b')
            terminal.expect('Чем займёмся?')
            terminal.choose(-1)
            terminal.expect('Остановить работающие задачи и закрыть')
            terminal.send('\x1b[D\r')
            terminal.expect('История сохранена.')
            terminal.finish()
            screens.append(terminal.text)
            records = [json.loads(p.read_text()) for p in (state / 'runs').glob('*.json')]
            assert any(r['status'] == 'cancelled' for r in records)
            assert not (state / 'daemon.lock').exists()
        finally:
            terminal.close()
    api.shutdown()
    assert 'Bearer wrong-fixture-key' in keys_seen and 'Bearer correct-fixture-key' in keys_seen
    assert all('correct-fixture-key' not in screen and 'wrong-fixture-key' not in screen for screen in screens)
    assert before == digest(ROOT / 'dist', '.js'), 'Сборка изменилась во время проверки'
    report = {'platform': os.uname().sysname,
              'node': subprocess.check_output([node, '--version']).decode().strip(),
              'sourceDigest': source, 'distDigest': before, 'distUnchanged': True,
              'transport': 'localhost HTTP', 'httpRequests': len(requests),
              'checks': ['onboarding', 'wrong-key-retry', 'masked-keys', 'inline-approval', 'file-diff', 'file-restore', 'history-search', 'budget-screen', 'session-only-key-choice',
                         'answer-file', 'session-followup', 'escape-back', 'restart',
                         '48-column-terminal', 'ctrl-c-cancel', 'cancel-on-exit', 'no-secret-on-disk', 'lock-cleanup']}
    (ROOT / 'docs/playtest-cli.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (ROOT / '.harness').mkdir(exist_ok=True)
    (ROOT / '.harness/cli-playtest.txt').write_text('\n\n'.join(screens))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
