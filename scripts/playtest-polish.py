#!/usr/bin/env python3
"""Проверяет видимые страницы и завершение CLI в изолированном PTY без облачной модели."""
import argparse
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import threading
import time

import pyte

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('task_screen_playtest', ROOT / 'scripts/playtest-task-screen.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
BRAND = 'Harness by Ghost_Raven'
requests = []
layout_failures = []
release = threading.Event()


class Api(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()

        def send(delta, reason=None):
            chunk = {'id': 'polish', 'object': 'chat.completion.chunk', 'created': 1,
                     'model': 'fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
            self.wfile.write(('data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\n').encode())
            self.wfile.flush()

        try:
            if not any(message['role'] == 'tool' for message in body['messages']):
                tool = next(tool['function']['name'] for tool in body['tools']
                            if tool['function']['description'].startswith('fs.list:'))
                send({'tool_calls': [{'index': 0, 'id': 'list-polish', 'type': 'function',
                                     'function': {'name': tool, 'arguments': '{"path":"."}'}}]})
                send({}, 'tool_calls')
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()
            else:
                # Задача остаётся активной для проверки отмены: итоговый текст не выдаётся.
                release.wait(90)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Terminal(base.Terminal):
    def __init__(self, node, state, workspace, columns=90, rows=45):
        super().__init__(node, state, workspace, columns)
        self.columns, self.rows = columns, 45
        if rows != 45:
            self.resize(columns, rows)

    def visible(self, text, absent=()):
        screen = self.screen()
        if text not in screen or any(old in screen for old in absent):
            layout_failures.append({'expected': text, 'absent': list(absent), 'screen': screen})
        return screen

    def visible_wrapped(self, text, absent=()):
        screen = self.screen()
        compact = ' '.join(screen.replace('│', ' ').split())
        if text not in compact or any(old in compact for old in absent):
            layout_failures.append({'expected': text, 'absent': list(absent), 'screen': screen})
        return screen

    def visible_path(self, path):
        screen = self.screen()
        # Рамка и жёсткий перенос не меняют видимые символы длинного пути.
        compact = ''.join(screen.replace('│', '').split())
        if ''.join(str(path).split()) not in compact:
            layout_failures.append({'expected': str(path), 'absent': [], 'screen': screen})
        return screen

    def wait_exit(self, expected=0):
        until = time.monotonic() + 15
        while time.monotonic() < until:
            self.drain(0.1)
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.stopped = True
                assert os.waitstatus_to_exitcode(status) == expected, (status, self.text[-2000:])
                self.drain()
                return
        raise AssertionError('CLI не завершился:\n' + self.screen())

    def farewell(self, expected, title='До следующей задачи!'):
        self.wait_exit(expected)
        before, separator, after = self.raw.rpartition(b'\x1b[?1049l')
        assert separator, 'Не восстановлен основной буфер'
        assert before.rfind(b'\x1b[?25h') > before.rfind(b'\x1b[?25l'), 'Перед выходом курсор остался скрытым'
        assert b'\x1b[?25l' not in after, 'Прощание скрыло курсор'
        assert b'\x1b[?1049h' not in after, 'После выхода снова открыт отдельный экран'
        screen = pyte.Screen(self.columns, self.rows)
        pyte.Stream(screen).feed(after.decode('utf8', 'replace'))
        visible = '\n'.join(line.rstrip() for line in screen.display)
        assert BRAND in visible, visible
        assert title in visible, visible
        assert 'Чем займёмся?' not in visible and 'Что дальше?' not in visible, visible
        assert not screen.cursor.hidden, 'После прощания курсор не виден'
        return visible


def socket_path(node, state):
    source = "import {socketPath} from './dist/interfaces/ipc.js'; process.stdout.write(socketPath(process.argv[1]));"
    return Path(subprocess.check_output([node, '--input-type=module', '-e', source, str(state)], cwd=ROOT).decode())


def assert_released(state, address):
    assert not (state / 'daemon.lock').exists(), 'Осталась блокировка сервиса'
    assert not address.exists(), 'Остался сокет закрытого сервиса'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    api = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Api)
    api.daemon_threads = True
    threading.Thread(target=api.serve_forever, daemon=True).start()
    screens, checks = {}, []
    try:
        with tempfile.TemporaryDirectory(prefix='harness-polish-') as directory:
            workspace, state = base.configure(Path(directory).resolve(), api.server_port)
            for index in range(6):
                (workspace / ('folder-%02d' % index)).mkdir()
            for index in range(3):
                (workspace / ('file-%02d.txt' % index)).write_text('Данные проверочного проекта')
            address = socket_path(node, state)
            terminal = Terminal(node, state, workspace)
            try:
                terminal.expect('Чем займёмся?')
                screens['main-90x45'] = terminal.visible(BRAND)
                terminal.open_label('Как пользоваться')
                terminal.expect('Продолжить')
                screens['help-90x45'] = terminal.visible('Как пользоваться', ['Чем займёмся?'])
                terminal.choose()
                terminal.expect('Чем займёмся?')
                terminal.resize(48, 24)
                terminal.open_label('Настройки')
                terminal.expect('Расход токенов')
                screens['settings-48x24'] = terminal.visible(BRAND, ['Чем займёмся?'])
                terminal.visible('Настройки')
                terminal.visible('Esc — назад')
                terminal.select_label('← Назад')
                screens['settings-back-48x24'] = terminal.visible('← Назад')
                terminal.select_label('Подключить другую модель')
                terminal.open_label('Расход токенов')
                terminal.expect('Оценка Harness')
                screens['budget-48x24'] = terminal.visible('Расход токенов', ['Чем займёмся?', 'Квота'])
                terminal.visible(BRAND)
                terminal.visible('Esc — назад')
                terminal.send('\x1b')
                terminal.expect('Чем займёмся?')
                terminal.open_label('Настройки')
                terminal.expect('Расход токенов')
                terminal.open_label('Где находятся настройки и история')
                terminal.expect('Продолжить')
                screens['data-files-48x24'] = terminal.visible('Ваши данные', ['Оценка Harness'])
                terminal.visible(BRAND)
                terminal.visible('← Назад')
                terminal.choose()
                terminal.expect('Чем займёмся?')
                terminal.open_label('Настройки')
                terminal.expect('Расход токенов')
                terminal.choose(-1)
                terminal.expect('Чем займёмся?')
                terminal.open_label('Как пользоваться')
                terminal.expect('Продолжить')
                screens['help-48x24'] = terminal.visible(BRAND, ['Чем займёмся?'])
                terminal.visible('Как пользоваться')
                terminal.visible('Продолжить')
                terminal.choose()
                terminal.expect('Чем займёмся?')
                checks.extend(['brand-main', 'help-replaces-main', 'settings-48x24', 'settings-back-reachable', 'budget-48x24',
                               'data-files-48x24', 'help-48x24'])

                terminal.resize(90, 45)
                terminal.open_label('Новая задача')
                terminal.expect('Что нужно сделать?')
                terminal.visible('Рабочая папка этой задачи')
                terminal.visible_path(workspace)
                terminal.send('Проверка каталога\x13')
                terminal.expect('Найдено: папок 6, файлов 3.')
                screens['directory-90x45'] = terminal.visible('Просмотр папки · готово', ['"directory":', '"symlink":', '[{"name"'])
                terminal.visible(BRAND)
                terminal.visible(workspace.name)
                terminal.visible('… ещё 4')
                terminal.resize(48, 24)
                screens['directory-48x24'] = terminal.visible(BRAND)
                terminal.visible('Папка:')
                terminal.visible(workspace.name)
                terminal.visible('Enter — действия')
                terminal.send('\x03')
                terminal.expect('Что дальше?')
                screens['task-actions-48x24'] = terminal.visible('Что дальше?')
                terminal.visible(BRAND)
                terminal.visible('← В главное меню')
                terminal.visible(workspace.name)
                terminal.open_label('Расход токенов задачи')
                terminal.expect('Оценка Harness')
                screens['task-budget-48x24'] = terminal.visible(
                    'Расход токенов задачи', ['Добавить квоту', 'Квота задачи:'])
                terminal.visible(BRAND)
                terminal.visible('Esc — назад')
                terminal.send('\x1b')
                terminal.expect('Что дальше?')
                terminal.open_label('Журнал, мысли и полный ответ')
                terminal.expect('Ход задачи')
                terminal.send('\t\t\t')
                screens['cancelled-answer-48x24'] = terminal.visible_wrapped(
                    'Итогового ответа нет.', ['Ожидаю новые события', 'Обновляется автоматически'])
                terminal.visible_wrapped('Нажмите Enter и выберите «Продолжить задачу».')
                terminal.visible(BRAND)
                terminal.visible(workspace.name)
                terminal.visible('Отменено')
                terminal.send('\t\t\t')
                screens['cancelled-reasoning-48x24'] = terminal.visible_wrapped(
                    'В этой задаче модель не передала пояснения.', ['Ожидаю новые события'])
                terminal.resize(90, 45)
                terminal.send('\t\t')
                screens['cancelled-log-90x45'] = terminal.visible('Просмотр папки · готово', ['"directory":', '"symlink":'])
                terminal.send('\x1b')
                terminal.expect('Что дальше?')
                terminal.open_label('В главное меню')
                terminal.expect('Чем займёмся?')
                terminal.visible('Главное меню', ['Просмотр папки', 'Итогового ответа нет.'])
                checks.extend(['workspace-before-run', 'directory-summary', 'directory-summary-truncated',
                               'task-brand-and-workspace-90x45', 'task-brand-and-workspace-48x24',
                               'task-actions-48x24', 'task-budget-48x24', 'cancelled-budget-no-extension', 'cancelled-answer',
                               'cancelled-reasoning', 'cancelled-log', 'back-clears-task'])

                # Второй рабочий стол закрывается, сохраняя сервис первого окна.
                for exit_name in ['attached-exit', 'attached-escape-exit']:
                    attached = Terminal(node, state, workspace, 48, 24)
                    try:
                        attached.expect('Чем займёмся?')
                        if exit_name == 'attached-escape-exit':
                            attached.send('\x1b')
                        else:
                            attached.open_label('Выход')
                        screens[exit_name] = attached.farewell(0)
                        assert 'Сервис продолжает работать' in screens[exit_name], screens[exit_name]
                        assert int((state / 'daemon.lock').read_text()) == terminal.pid
                        assert address.exists()
                        os.kill(terminal.pid, 0)
                    finally:
                        attached.close()
                    checks.append(exit_name + '-keeps-service')

                terminal.open_label('Выход')
                screens['owner-exit'] = terminal.farewell(0)
                assert 'История сохранена. Сервис остановлен.' in screens['owner-exit'], screens['owner-exit']
                assert_released(state, address)
                record = json.loads(next((state / 'runs').glob('*.json')).read_text())
                assert record['status'] == 'cancelled'
                checks.extend(['farewell-main-buffer', 'farewell-brand', 'visible-cursor-on-exit', 'owner-service-cleanup'])
            finally:
                release.set()
                terminal.close()

            # Повторный запуск проверяет восстановление истории и выход по сигналу.
            terminal = Terminal(node, state, workspace, 48, 24)
            try:
                terminal.expect('Чем займёмся?')
                terminal.open_label('Мои задачи')
                terminal.expect('Мои задачи · страница')
                terminal.visible('Проверка каталога')
                terminal.choose(-1)
                terminal.expect('Чем займёмся?')
                os.kill(terminal.pid, signal.SIGTERM)
                screens['signal-exit'] = terminal.farewell(130)
                assert_released(state, address)
                checks.extend(['restart-after-exit', 'signal-farewell', 'signal-service-cleanup'])
            finally:
                terminal.close()

            # Отмена первой настройки не должна обещать сохранение ещё не созданной истории.
            empty_state = state.parent / 'new-state'
            empty_state.mkdir(mode=0o700)
            terminal = Terminal(node, empty_state, workspace, 48, 24)
            try:
                terminal.expect('Папка для работы:')
                terminal.send('\x1b')
                terminal.expect('Закрыть приложение?')
                screens['onboarding-confirm'] = terminal.visible(
                    'Завершение настройки', ['Выбрать эту папку', 'Папка для работы:'])
                terminal.visible(BRAND)
                checks.append('onboarding-confirm-replaces-picker')
                terminal.send('\x1b[D\r')
                screens['onboarding-exit'] = terminal.farewell(0, 'Настройка отложена')
                assert 'История сохранена' not in screens['onboarding-exit']
                assert_released(empty_state, socket_path(node, empty_state))
                checks.append('onboarding-exit')
            finally:
                terminal.close()
    finally:
        release.set()
        api.shutdown()
        api.server_close()
        if 'address' in locals():
            address.unlink(missing_ok=True)
        (ROOT / '.harness').mkdir(exist_ok=True)
        (ROOT / '.harness/polish-playtest.json').write_text(json.dumps(screens, ensure_ascii=False, indent=2) + '\n')
        (ROOT / '.harness/polish-layout-failures.json').write_text(json.dumps(layout_failures, ensure_ascii=False, indent=2) + '\n')

    assert not layout_failures, json.dumps(layout_failures, ensure_ascii=False, indent=2)
    digest = hashlib.sha256()
    for path in sorted((ROOT / 'src').rglob('*.ts')):
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(path.read_bytes())
    report = {'platform': os.uname().sysname, 'node': subprocess.check_output([node, '--version']).decode().strip(),
              'sourceDigest': digest.hexdigest(), 'httpRequests': len(requests),
              'terminalSizes': ['90x45', '48x24'], 'checks': checks}
    (ROOT / 'docs/playtest-polish.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
