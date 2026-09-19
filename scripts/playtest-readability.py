#!/usr/bin/env python3
"""Проверяет и сохраняет читаемость настоящего экрана CLI при трёх размерах терминала."""
import argparse
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('screen_playtest', ROOT / 'scripts/playtest-task-screen.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
BRAND = 'Harness by Ghost_Raven'
SIZES = [(48, 24), (90, 30), (120, 40)]


class Controls:
    def __init__(self):
        self.listed = threading.Event()
        self.stream = threading.Event()
        self.advance = threading.Event()
        self.finish = threading.Event()

    def release(self):
        self.stream.set()
        self.advance.set()
        self.finish.set()


class Api(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        controls = self.server.controls
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.request_count += 1
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()

        def send(delta, reason=None):
            chunk = {'id': 'readability', 'object': 'chat.completion.chunk', 'created': 1,
                     'model': 'fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
            self.wfile.write(('data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\n').encode())
            self.wfile.flush()

        try:
            if not any(message['role'] == 'tool' for message in body['messages']):
                tool = next(tool['function']['name'] for tool in body['tools']
                            if tool['function']['description'].startswith('fs.list:'))
                send({'tool_calls': [{'index': 0, 'id': 'readability-list', 'type': 'function',
                                     'function': {'name': tool, 'arguments': '{"path":"."}'}}]})
                send({}, 'tool_calls')
            else:
                controls.listed.set()
                if not controls.stream.wait(90):
                    return
                send({'reasoning_content': 'Публичное пояснение: проверяю состав проекта.'})
                send({'content': '\n'.join('Строка %03d' % index for index in range(100)) + '\n'})
                if not controls.advance.wait(90):
                    return
                send({'content': '\n'.join('Строка %03d' % index for index in range(100, 130)) + '\n'})
                if not controls.finish.wait(90):
                    return
                send({'content': 'Проверка завершена.'})
                send({}, 'stop')
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class Terminal(base.Terminal):
    def __init__(self, node, state, workspace, width, height):
        super().__init__(node, state, workspace, width)
        self.columns, self.rows = width, 45
        self.resize(width, height)

    def until(self, event, timeout=20):
        deadline = time.monotonic() + timeout
        while not event.is_set() and time.monotonic() < deadline:
            self.drain(0.1)
        assert event.is_set(), 'Сервис не передал результат просмотра папки модели:\n' + self.text[-3000:]

    def close(self):
        if not self.stopped:
            os.kill(self.pid, signal.SIGTERM)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                self.drain(0.1)
                pid, _ = os.waitpid(self.pid, os.WNOHANG)
                if pid:
                    self.stopped = True
                    break
            if not self.stopped:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
                self.stopped = True
        os.close(self.fd)


class Review:
    def __init__(self):
        self.checks = []
        self.failures = []
        self.frames = {}

    def check(self, name, condition, frame):
        self.checks.append(name)
        if not condition:
            self.failures.append({'check': name, 'frame': frame})

    def frame(self, name, terminal, section, workspace, status='В работе'):
        selected = {'Ход задачи': 'Все', 'Журнал': 'Журнал', 'Пояснения модели': 'Мысли', 'Ответ': 'Ответ'}[section]
        deadline = time.monotonic() + 8
        while True:
            frame = terminal.screen()
            if ('[' + selected + ']') in frame and status in frame and 'Управление' in frame:
                break
            if time.monotonic() >= deadline:
                break
        self.frames[name] = frame
        lines = frame.splitlines()
        position = lambda label: next((index for index, line in enumerate(lines)
                                       if label in line and '─' in line), -1)
        task, content, controls = position('Задача'), position(section), position('Управление')
        self.check(name + '/regions', 0 <= task < content < controls, frame)
        framed = [line for line in lines if line.lstrip().startswith('│')]
        self.check(name + '/frame-edges', len(framed) >= 4
                   and sum(bool(re.search('─{4,}', line)) for line in lines) >= 4
                   and all(line.rstrip().endswith('│') for line in framed), frame)
        self.check(name + '/active-tab', '[' + selected + ']' in frame, frame)
        self.check(name + '/identity', BRAND in frame and 'Папка:' in frame and workspace.name in frame, frame)
        self.check(name + '/status', status in frame, frame)
        self.check(name + '/navigation', all(key in frame for key in ['Tab', 'Esc', 'Enter', 'End']), frame)
        self.check(name + '/no-menu-residue', 'Чем займёмся?' not in frame and 'Что нужно сделать?' not in frame, frame)
        self.check(name + '/no-raw-json', not any(token in frame for token in ['"directory":', '"symlink":', '[{"name"']), frame)
        return frame


def markers(frame):
    return re.findall(r'Строка\s+(\d{3})', frame)


def run_case(node, api, root, width, height, review):
    controls = Controls()
    api.controls = controls
    root.mkdir()
    workspace, state = base.configure(root, api.server_port)
    for index in range(7):
        (workspace / ('каталог_%02d_с_проверочными_файлами' % index)).mkdir()
    for index in range(3):
        (workspace / ('пример_%02d.txt' % index)).write_text('Проверочные данные')
    case = str(width) + 'x' + str(height)
    terminal = Terminal(node, state, workspace, width, height)
    try:
        terminal.expect('Чем займёмся?')
        terminal.open_label('Новая задача')
        terminal.expect('Что нужно сделать?')
        terminal.send('Проверка читаемости ' + case + '\x13')
        terminal.until(controls.listed)
        terminal.drain(0.7)
        directory = review.frame(case + '/directory', terminal, 'Ход задачи', workspace)
        review.check(case + '/directory-context', 'Просмотр папки' in directory, directory)
        controls.stream.set()
        terminal.expect('Строка 099')
        all_events = review.frame(case + '/all-events', terminal, 'Ход задачи', workspace)
        review.check(case + '/cropped-answer-context', 'продолжение' in all_events.lower()
                     and 'coordinator' in all_events and 'Ответ' in all_events, all_events)

        terminal.send('\t\t')
        reasoning = review.frame(case + '/reasoning', terminal, 'Пояснения модели', workspace)
        review.check(case + '/reasoning-separated', 'Публичное пояснение' in reasoning and not markers(reasoning), reasoning)
        terminal.send('\t')
        answer = review.frame(case + '/answer', terminal, 'Ответ', workspace)
        review.check(case + '/answer-has-author', 'coordinator' in answer and bool(markers(answer)), answer)
        terminal.send('\x1b[5~\x1b[5~')
        before = review.frame(case + '/history-before', terminal, 'Ответ', workspace)
        rows_before = markers(before)
        review.check(case + '/history-has-visible-content', bool(rows_before) and '099' not in rows_before, before)
        review.check(case + '/history-has-context', 'продолжение' in before.lower() and 'coordinator' in before, before)
        controls.advance.set()
        terminal.drain(0.8)
        after = review.frame(case + '/history-after', terminal, 'Ответ', workspace)
        review.check(case + '/scroll-anchor', bool(rows_before) and markers(after) == rows_before, after)
        terminal.send('\x1b[F')
        terminal.expect('Строка 129')
        tail = review.frame(case + '/tail', terminal, 'Ответ', workspace)
        review.check(case + '/end-follows-stream', '129' in markers(tail), tail)

        terminal.send('\x1b')
        terminal.expect('Чем займёмся?')
        terminal.open_label('Мои задачи')
        terminal.expect('Мои задачи · страница')
        terminal.choose()
        terminal.expect('Строка 129')
        reopened = review.frame(case + '/reopened', terminal, 'Ход задачи', workspace)
        review.check(case + '/reopen-context', 'продолжение' in reopened.lower() and 'coordinator' in reopened, reopened)
        controls.finish.set()
        terminal.expect('Ответ получен')
        terminal.drain(0.8)
        review.frame(case + '/completed', terminal, 'Ход задачи', workspace, 'Ответ получен')
        terminal.send('\t\t\t')
        completed_answer = review.frame(case + '/completed-answer', terminal, 'Ответ', workspace, 'Ответ получен')
        review.check(case + '/completed-answer-preserves-context', 'Последний ответ модели' in completed_answer
                     and 'Проверка завершена.' in completed_answer, completed_answer)
        terminal.send('\x1b')
        terminal.expect('Мои задачи · страница')
        terminal.send('\x1b')
        terminal.expect('Чем займёмся?')
        terminal.open_label('Выход')
        terminal.expect('История сохранена.')
        terminal.finish()
        assert not (state / 'daemon.lock').exists(), 'Не освобождена блокировка сервиса'
    finally:
        controls.release()
        terminal.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    api = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Api)
    api.daemon_threads = True
    api.request_count = 0
    threading.Thread(target=api.serve_forever, daemon=True).start()
    review = Review()
    try:
        with tempfile.TemporaryDirectory(prefix='harness-readability-') as directory:
            for width, height in SIZES:
                run_case(node, api, Path(directory).resolve() / (str(width) + 'x' + str(height)),
                         width, height, review)
    finally:
        api.shutdown()
        api.server_close()
        (ROOT / '.harness').mkdir(exist_ok=True)
        (ROOT / '.harness/readability-frames.json').write_text(json.dumps(review.frames, ensure_ascii=False, indent=2) + '\n')
        (ROOT / '.harness/readability-failures.json').write_text(json.dumps(review.failures, ensure_ascii=False, indent=2) + '\n')
    assert not review.failures, json.dumps(review.failures, ensure_ascii=False, indent=2)
    digest = hashlib.sha256()
    for path in sorted((ROOT / 'src').rglob('*.ts')):
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(path.read_bytes())
    report = {'platform': os.uname().sysname, 'node': subprocess.check_output([node, '--version']).decode().strip(),
              'sourceDigest': digest.hexdigest(), 'httpRequests': api.request_count,
              'checks': review.checks, 'frames': list(review.frames)}
    (ROOT / 'docs/playtest-readability.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'checks': len(review.checks), 'frames': len(review.frames),
                      'httpRequests': api.request_count, 'sourceDigest': digest.hexdigest()}, indent=2))


if __name__ == '__main__':
    main()
