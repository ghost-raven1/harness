#!/usr/bin/env python3
"""Проверяет обновление открытых страниц через второго клиента изолированного сервиса."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import socket
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('readability_playtest', ROOT / 'scripts/playtest-readability.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
BRAND = 'Harness by Ghost_Raven'
SIZES = [(48, 24), (90, 30)]
LAYOUT_FAILURES = []
LESSON_ALPHA = '11111111-1111-4111-8111-111111111111'
LESSON_BETA = '22222222-2222-4222-8222-222222222222'
LESSON_GAMMA = '33333333-3333-4333-8333-333333333333'


class Fixture:
    def __init__(self, node, config, state, workspace):
        self.error_path = state / 'fixture-errors.log'
        self.errors = self.error_path.open('w')
        environment = dict(os.environ, HOME=str(workspace))
        environment.pop('HARNESS_MODEL_API_KEY', None)
        self.process = subprocess.Popen([node, str(ROOT / 'scripts/fixtures/live-screens-service.mjs'),
                                         str(ROOT), str(config), str(state)], stdout=subprocess.PIPE,
                                        stderr=self.errors, env=environment, text=True)
        if not select.select([self.process.stdout], [], [], 15)[0]:
            self.close()
            raise AssertionError('Fixture-сервис не запустился: ' + self.error_path.read_text())
        line = self.process.stdout.readline()
        assert line, self.error_path.read_text()
        self.address = json.loads(line)['controlAddress']

    def request(self, method, params=None):
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(10)
            connection.connect(self.address)
            connection.sendall((json.dumps({'jsonrpc': '2.0', 'id': str(uuid.uuid4()),
                                            'method': method, 'params': params or {}}) + '\n').encode())
            buffer = b''
            while b'\n' not in buffer:
                part = connection.recv(65536)
                assert part, 'Fixture закрыл соединение без ответа'
                buffer += part
        result = json.loads(buffer.split(b'\n', 1)[0])
        assert not result.get('error'), result
        return result['result']

    def call(self, method, args=None):
        return self.request('call', {'method': method, 'args': args or {}})

    def counts(self, method):
        return self.request('metrics')['counts'].get(method, 0)

    def close(self):
        if self.process.poll() is None:
            try:
                if hasattr(self, 'address'):
                    self.request('close')
                else:
                    self.process.terminate()
                self.process.wait(timeout=8)
            except (OSError, AssertionError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait()
        self.errors.close()


class Terminal(base.Terminal):
    def wait_screen(self, predicate, description, timeout=8):
        until = time.monotonic() + timeout
        last = ''
        while time.monotonic() < until:
            last = self.screen()
            if predicate(last):
                return last
        raise AssertionError(description + '\n' + last)

    def wait_text(self, text, absent=()):
        return self.wait_screen(lambda frame: text in frame and not any(old in frame for old in absent),
                                'Не обновился экран: ' + text)

    def selected(self):
        return next((line for line in self.screen().splitlines()
                     if re.match(r'^\s*│?\s*● ', line)), '')

    def select_label(self, label):
        self.send('\x1b[H')
        for _ in range(30):
            if label in self.selected():
                return
            self.send('\x1b[B')
        raise AssertionError('Пункт не найден: ' + label + '\n' + self.screen())

    def open_label(self, label):
        self.select_label(label)
        self.send('\r')


def start_task(fixture, workspace, title):
    return fixture.call('runtime.run', {'message': title, 'workspace': str(workspace),
                                       'profile': 'fixture', 'requestKey': str(uuid.uuid4())})['runId']


def lesson(id, title, text=None):
    return {'id': id, 'title': title, 'text': text or ('Учебный вывод: ' + title)}


def no_polling(terminal, fixture, method):
    terminal.drain(0.6)
    before = fixture.counts(method)
    terminal.drain(2.3)
    after = fixture.counts(method)
    assert after == before, f'{method} продолжает опрашиваться после ухода: {before} → {after}'


def run_case(node, root, width, height, frames, checks):
    root.mkdir()
    workspace, state = base.base.configure(root, 9)
    fixture = Fixture(node, root / 'config/harness.json', state, workspace)
    terminal = Terminal(node, state, workspace, width, height)
    case = str(width) + 'x' + str(height)

    def capture(name, text=None, absent=()):
        frame = terminal.wait_text(text, absent) if text else terminal.screen()
        frames[case + '/' + name] = frame
        if BRAND not in frame:
            LAYOUT_FAILURES.append({'check': case + '/' + name + '/brand', 'frame': frame})
        return frame

    def passed(name):
        checks.append(case + '/' + name)

    try:
        terminal.wait_text('Чем займёмся?')
        alpha = start_task(fixture, workspace, 'Альфа')
        capture('main-running', 'В работе: 1')
        passed('dashboard-updates-without-keys')
        terminal.open_label('Мои задачи')
        capture('history-alpha', 'Альфа')
        terminal.select_label('Альфа')
        beta = start_task(fixture, workspace, 'Бета')
        capture('history-new-run', 'Бета')
        assert 'Альфа' in terminal.selected(), terminal.screen()
        passed('history-updates-without-keys')
        passed('selection-survives-reorder')
        terminal.send('\r')
        terminal.wait_text('Альфа')
        terminal.wait_text('Ход задачи')
        terminal.send('\r')
        terminal.wait_text('Что дальше?')
        fixture.request('complete', {'runId': alpha})
        capture('actions-completed', 'Сохранить ответ', ['Вернуться к выполнению задачи'])
        assert 'Ответ получен' in terminal.screen()
        passed('task-actions-follow-status')
        terminal.send('\r')
        terminal.wait_text('Список изменился · выберите пункт')
        assert not terminal.selected(), 'Исчезнувшее действие заменилось другим без выбора пользователя'
        passed('removed-action-requires-new-selection')
        terminal.open_label('В главное меню')
        terminal.wait_text('Чем займёмся?')
        no_polling(terminal, fixture, 'runtime.status')
        passed('leaving-actions-stops-polling')

        terminal.open_label('Мои задачи')
        terminal.wait_text('Бета')
        terminal.open_label('Найти задачу или ответ')
        terminal.wait_text('Слова из задачи')
        terminal.send('Альфа')
        start_task(fixture, workspace, 'Гамма')
        fixture.request('complete', {'runId': beta})
        no_polling(terminal, fixture, 'runtime.history')
        capture('search-input-preserved', 'Альфа')
        terminal.send('\r')
        # Активная Гамма закреплена вне поиска; завершённая Бета должна исчезнуть из результата.
        search_results = capture('search-results', 'Альфа', ['Бета'])
        assert 'Нет совпадений' not in search_results, 'Найденная задача ошибочно названа пустым результатом:\n' + search_results
        passed('search-result-heading-agrees-with-items')
        if not re.search(r'поиск\s*:\s*Альфа', search_results, re.IGNORECASE):
            LAYOUT_FAILURES.append({'check': case + '/search-query-visible', 'frame': search_results})
        history_requests = [request for request in fixture.request('metrics')['recent']
                            if request['method'] == 'runtime.history']
        assert history_requests[-1]['params']['query'] == 'Альфа'
        passed('search-input-not-reset')
        passed('search-suspends-polling')
        terminal.open_label('В главное меню')
        terminal.wait_text('Чем займёмся?')
        no_polling(terminal, fixture, 'runtime.history')
        passed('leaving-history-stops-polling')

        terminal.open_label('Настройки')
        terminal.wait_text('Расход токенов')
        terminal.open_label('Расход токенов')
        terminal.wait_text('Оценка Harness')
        budget = fixture.call('budget.status')
        extra = start_task(fixture, workspace, 'Учёт нового запроса')
        fixture.request('complete', {'runId': extra})
        current = fixture.call('budget.status')
        assert current['daily']['reportedTasks'] > budget['daily']['reportedTasks']
        capture('budget-updated', 'Задачи: ' + str(current['daily']['reportedTasks']))
        passed('budget-updates-without-keys')
        terminal.send('\x1b')
        terminal.wait_text('Чем займёмся?')
        no_polling(terminal, fixture, 'budget.status')
        passed('leaving-budget-stops-polling')

        lessons = [lesson(LESSON_ALPHA, 'Урок Альфа'), lesson(LESSON_BETA, 'Урок Бета')]
        fixture.request('learning', {'runId': alpha, 'lessons': lessons, 'version': 'live-v2',
                                     'jobs': [{'status': 'queued', 'candidateId': LESSON_ALPHA}]})
        capture('main-learning-version', 'live-v2')
        passed('dashboard-learning-updates')
        terminal.open_label('База знаний')
        terminal.wait_text('Урок Бета')
        terminal.select_label('Урок Альфа')
        lessons.append(lesson(LESSON_GAMMA, 'Урок Гамма'))
        fixture.request('learning', {'runId': alpha, 'lessons': lessons, 'version': 'live-v3',
                                     'jobs': [{'status': 'queued'}, {'status': 'queued'}]})
        capture('knowledge-reordered', 'Урок Гамма')
        assert 'live-v3' in terminal.screen()
        assert 'Урок Альфа' in terminal.selected()
        passed('knowledge-updates-without-keys')
        passed('knowledge-selection-survives-reorder')
        terminal.send('\r')
        terminal.wait_text('Учебный вывод: Урок Альфа')
        lessons[0] = lesson(LESSON_ALPHA, 'Урок Альфа', 'Уточнение после проверки')
        fixture.request('learning', {'runId': alpha, 'lessons': lessons})
        capture('lesson-refreshed', 'Уточнение после проверки')
        passed('lesson-reader-updates')
        terminal.send('\x1b')
        terminal.wait_text('Урок Гамма')
        no_polling(terminal, fixture, 'learning.inspect')
        passed('leaving-lesson-stops-polling')
        terminal.open_label('Вся очередь обучения')
        terminal.wait_text('Ожидает обработки')
        fixture.request('learning', {'runId': alpha, 'jobs': [{'status': 'done'}]})
        capture('queue-updated', 'Обработано', ['Ожидает обработки'])
        passed('queue-reader-updates')
        terminal.send('\x1b')
        terminal.wait_text('Урок Гамма')
        terminal.open_label('Версии и откаты')
        terminal.wait_text('live-v3')
        fixture.request('learning', {'runId': alpha, 'version': 'live-v4'})
        capture('releases-updated', 'live-v4')
        passed('release-reader-updates')
        terminal.send('\x1b')
        terminal.wait_text('Урок Гамма')
        terminal.open_label('Назад')
        terminal.wait_text('Чем займёмся?')

        terminal.open_label('Мои задачи')
        terminal.wait_text('Гамма')
        terminal.select_label('Бета')
        fixture.request('connection', {'available': False})
        capture('disconnected', 'Нет связи')
        start_task(fixture, workspace, 'Дельта')
        fixture.request('connection', {'available': True})
        capture('reconnected', 'Дельта', ['Нет связи'])
        assert 'Бета' in terminal.selected(), terminal.screen()
        passed('connection-loss-visible')
        passed('reconnect-preserves-selection')
        terminal.send('\x1b')
        terminal.wait_text('Чем займёмся?')
        no_polling(terminal, fixture, 'runtime.history')
        passed('escape-leaves-live-catalogue')
        terminal.open_label('Выход')
        terminal.expect('Сервис продолжает работать')
        terminal.finish()
        assert fixture.process.poll() is None
        passed('attached-exit-keeps-owner')
    finally:
        terminal.close()
        fixture.close()
        assert not (state / 'daemon.lock').exists(), 'Fixture не освободил состояние'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    frames, checks = {}, []
    try:
        with tempfile.TemporaryDirectory(prefix='harness-live-pages-') as directory:
            for width, height in SIZES:
                run_case(node, Path(directory).resolve() / (str(width) + 'x' + str(height)),
                         width, height, frames, checks)
    finally:
        (ROOT / '.harness').mkdir(exist_ok=True)
        (ROOT / '.harness/live-screens-frames.json').write_text(json.dumps(frames, ensure_ascii=False, indent=2) + '\n')
        (ROOT / '.harness/live-screens-failures.json').write_text(json.dumps(LAYOUT_FAILURES, ensure_ascii=False, indent=2) + '\n')
    assert not LAYOUT_FAILURES, json.dumps(LAYOUT_FAILURES, ensure_ascii=False, indent=2)
    digest = hashlib.sha256()
    for path in sorted((ROOT / 'src').rglob('*.ts')):
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(path.read_bytes())
    report = {'platform': os.uname().sysname, 'node': subprocess.check_output([node, '--version']).decode().strip(),
              'sourceDigest': digest.hexdigest(), 'modelTransport': 'in-process fixture',
              'knowledgeUpdates': 'fixture-owned store', 'checks': checks, 'frames': list(frames)}
    (ROOT / 'docs/playtest-live-screens.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'checks': len(checks), 'frames': len(frames), 'sourceDigest': digest.hexdigest()}, indent=2))


if __name__ == '__main__':
    main()
