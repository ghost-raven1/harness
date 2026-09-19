#!/usr/bin/env python3
"""Открывает редкие экраны CLI и сохраняет карту покрытия без пользовательских данных."""
import argparse
import codecs
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import pyte

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('live_pages', ROOT / 'scripts/playtest-live-screens.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
maintenance_spec = importlib.util.spec_from_file_location(
    'inventory_maintenance', ROOT / 'scripts/fixtures/screen-inventory-maintenance.py')
maintenance = importlib.util.module_from_spec(maintenance_spec)
maintenance_spec.loader.exec_module(maintenance)
diagnostics, reset_data, external_reset = maintenance.diagnostics, maintenance.reset_data, maintenance.external_reset
commands_spec = importlib.util.spec_from_file_location(
    'inventory_commands', ROOT / 'scripts/fixtures/screen-inventory-commands.py')
command_pages = importlib.util.module_from_spec(commands_spec)
commands_spec.loader.exec_module(command_pages)
commands = command_pages.commands
BRAND = 'Harness by Ghost_Raven'


def compact(frame):
    return ' '.join(frame.replace('│', ' ').split())


def digest(directory, suffix):
    value = hashlib.sha256()
    for path in sorted(directory.rglob('*' + suffix)):
        value.update(str(path.relative_to(ROOT)).encode())
        value.update(path.read_bytes())
    return value.hexdigest()


class Audit:
    def __init__(self, name='screen-inventory'):
        self.frames, self.failures, self.coverage = {}, [], {}
        self.name = name

    def capture(self, terminal, name, text, controls=False, absent=()):
        def ready(value):
            brand = BRAND in value or ('Harness' in value and 'by Ghost_Raven' in value)
            return text in compact(value) and brand and (not controls or 'Esc' in value)
        try:
            frame = terminal.wait_screen(ready, 'Не открыт экран ' + name)
        except AssertionError:
            frame = terminal.screen()
            if text not in compact(frame):
                raise
        self.frames[name] = frame
        has_brand = BRAND in frame or ('Harness' in frame and 'by Ghost_Raven' in frame)
        missing = ([] if has_brand else [BRAND]) + (['Esc'] if controls and 'Esc' not in frame else [])
        missing += ['Остался предыдущий экран: ' + item for item in absent if item in frame]
        self.coverage[name] = {'status': 'failed' if missing else 'passed', 'text': text}
        if missing:
            self.failures.append({'screen': name, 'reason': 'Не видно: ' + ', '.join(missing)})
        self.save_frames()
        print(name, self.coverage[name]['status'], flush=True)
        return frame

    def save_frames(self):
        (ROOT / ('.harness/' + self.name + '-frames.json')).write_text(
            json.dumps(self.frames, ensure_ascii=False, indent=2) + '\n')


class Terminal(base.Terminal):
    def __init__(self, node, state, workspace, width, height, arguments=None):
        if arguments is None:
            super().__init__(node, state, workspace, width, height)
        else:
            base.base.base.base.Terminal.__init__(self, node, state, workspace, width, arguments)
            self.columns, self.rows = width, 45
            self.resize(width, height)

    def screen(self):
        self.drain(0.1)
        size = (self.columns, self.rows)
        if getattr(self, '_size', None) != size:
            self._size, self._offset = size, 0
            self._screen = pyte.Screen(*size)
            self._stream = pyte.Stream(self._screen)
            self._decoder = codecs.getincrementaldecoder('utf8')('replace')
        self._stream.feed(self._decoder.decode(self.raw[self._offset:]))
        self._offset = len(self.raw)
        return '\n'.join(line.rstrip() for line in self._screen.display)

    def selected(self):
        lines, selected = self.screen().splitlines(), []
        for line in lines:
            if re.match(r'^\s*│?\s*● ', line):
                selected = [line]
            elif selected:
                if re.match(r'^\s*│?\s*[○●] ', line) or not line.strip(' │'):
                    break
                selected.append(line)
        return compact('\n'.join(selected))


class Session:
    def __init__(self, node, root, width, audit, owned=False, broken=False):
        root.mkdir()
        self.workspace, self.state = base.base.base.configure(root, 9)
        config = root / 'config'
        manifest = json.loads((config / 'harness.json').read_text())
        second = root / 'Вторая папка'
        second.mkdir()
        manifest['workspaces'].append(str(second))
        (config / 'harness.json').write_text(json.dumps(manifest))
        profiles = json.loads((config / 'profiles.json').read_text())
        profiles['second'] = dict(profiles['fixture'], model='Вторая модель')
        (config / 'profiles.json').write_text(json.dumps(profiles))
        self.profiles = profiles
        if broken:
            (config / 'profiles.json').write_text('{broken')
        (config / 'learning.json').write_text(json.dumps({'enabled': True, 'cases': []}))
        self.node, self.config = node, config / 'harness.json'
        self.fixture = None if owned else base.Fixture(node, config / 'harness.json', self.state, self.workspace)
        if self.fixture:
            self.fixture.call('learning.pause')
        self.terminal = Terminal(node, self.state, self.workspace, width, 24)
        try:
            self.terminal.wait_text('Следующий шаг' if broken else 'Чем займёмся?')
        except Exception:
            self.close()
            raise
        self.audit = audit
        self.prefix = str(width) + 'x24/' + root.name + '/'

    def capture(self, name, text, controls=False, absent=()):
        return self.audit.capture(self.terminal, self.prefix + name, text, controls, absent)

    def setting(self, label):
        self.terminal.open_label('Настройки')
        self.terminal.wait_text('Настройки')
        self.terminal.open_label(label)

    def info_back(self):
        self.terminal.wait_text('Продолжить')
        self.terminal.send('\r')
        self.terminal.wait_text('Чем займёмся?')

    def actions(self, title):
        self.terminal.open_label('Мои задачи')
        self.terminal.wait_text(title)
        self.terminal.open_label(title)
        self.terminal.wait_text('Ход задачи')
        self.terminal.send('\r')
        self.terminal.wait_text('Что дальше?')

    def start(self, title):
        return base.start_task(self.fixture, self.workspace, title)

    def close(self):
        self.terminal.close()
        if self.fixture:
            self.fixture.close()

    def restart_service(self):
        self.fixture.close()
        self.fixture = base.Fixture(self.node, self.config, self.state, self.workspace)
        until = time.monotonic() + 8
        while self.fixture.counts('diagnostics.status') == 0:
            assert time.monotonic() < until, 'Открытый экран не подключился к новому сервису'
            self.terminal.drain(0.1)

    def command(self, arguments):
        width = self.terminal.columns
        self.terminal.close()
        self.terminal = Terminal(self.node, self.state, self.workspace, width, 24, arguments)


def connection(session):
    terminal = session.terminal
    session.setting('Недавние папки')
    session.capture('recent-projects', 'Недавние папки', True)
    terminal.send('\r')
    session.capture('project-switched', 'Подключение выбрано для новых задач')
    session.info_back()
    session.setting('Подключить другую модель')
    session.capture('provider-picker', 'Какую модель подключим?')
    terminal.open_label('У меня пока нет подключения')
    session.capture('provider-help', 'Как подключить модель', True)
    terminal.send('\x1b')
    terminal.wait_text('Какую модель подключим?')
    terminal.send('\x1b')
    terminal.wait_text('Чем займёмся?')

    for label in ['Qwen', 'Anthropic', 'Google']:
        session.setting('Подключить другую модель')
        terminal.open_label(label)
        session.capture('endpoint-' + label, 'Другой адрес')
        terminal.send('\x1b')
        terminal.wait_text('Чем займёмся?')

    session.setting('Подключить другую модель')
    terminal.open_label('Локальная модель')
    terminal.open_label('Другой адрес')
    session.capture('endpoint-input', 'Адрес API из настроек сервера')
    terminal.send('\x01\x0bhttp://example.com\r')
    session.capture('endpoint-invalid', 'Нужен HTTPS')
    terminal.send('\x01\x0bhttp://127.0.0.1:9/v1\r')
    session.capture('key-required', 'Сервер требует ключ API?')
    terminal.send('\r')
    session.capture('catalogue-unavailable', 'Как продолжить?')
    terminal.open_label('Указать модель вручную')
    session.capture('model-manual', 'Название модели')
    terminal.send('inventory-local\r')
    session.capture('connection-ready', 'Подключение выбрано для новых задач')
    session.info_back()


def settings(session):
    terminal = session.terminal
    for label, title, expected in [
        ('Подключить другую модель', 'attached-model', 'Сервис работает в другом окне'),
        ('Недавние папки', 'attached-recent', 'Сервис работает в другом окне'),
        ('Ключ API', 'attached-key', 'Ключ задаётся в окне'),
        ('Настроить другой проект', 'attached-project', 'Сервис открыт в другом окне'),
    ]:
        session.setting(label)
        session.capture(title, expected)
        session.info_back()

    session.setting('Выбрать модель или папку')
    session.capture('profile-select', 'Вторая модель', True)
    terminal.open_label('Вторая модель')
    session.capture('workspace-select', 'Папка для новых задач', True)
    terminal.open_label('Вторая папка')
    session.capture('profile-saved', 'Выбор сохранён для новых задач')
    session.info_back()

    session.setting('Проверить, всё ли работает')
    session.capture('diagnostics', 'Диагностика', True)
    terminal.send('\x1b')
    terminal.wait_text('Чем займёмся?')

    session.setting('Самообучение')
    session.capture('learning-paused', 'Возобновить обучение', True)
    terminal.open_label('Возобновить обучение')
    session.capture('learning-resumed', 'Обучение возобновлено')
    session.info_back()
    session.setting('Самообучение')
    terminal.open_label('Приостановить обучение')
    session.capture('learning-paused-result', 'Обучение приостановлено')
    session.info_back()

    session.setting('Расход токенов')
    session.capture('token-usage', 'Оценка Harness', True, ['Добавить квоту', 'Лимит:'])
    terminal.send('\x1b')
    terminal.wait_text('Чем займёмся?')


def startup(session):
    terminal = session.terminal
    session.capture('broken-config-recovery', 'Следующий шаг')
    terminal.open_label('Открыть подсказки')
    session.capture('recovery-help', 'Как пользоваться')
    terminal.wait_text('Продолжить')
    terminal.send('\r')
    terminal.wait_text('Следующий шаг')
    (session.config.parent / 'profiles.json').write_text(json.dumps(session.profiles))
    terminal.open_label('Попробовать снова')
    session.capture('recovery-completed', 'Чем займёмся?', True)
    manifest = json.loads(session.config.read_text())
    manifest['workspaces'] = manifest['workspaces'][1:]
    session.config.write_text(json.dumps(manifest))
    session.setting('Настроить другой проект')
    session.capture('setup-folder', 'Выбор папки', True)
    terminal.open_label('Вставить путь к папке')
    session.capture('setup-folder-input', 'Вставьте полный путь к существующей папке')
    terminal.send('\x01\x0b' + str(session.workspace) + '\r')
    terminal.open_label('Выбрать эту папку')
    session.capture('project-config-found', 'Для этой папки найдены настройки Harness')
    terminal.open_label('Использовать настройки проекта')
    session.capture('project-workspace-restricted', 'В какой разрешённой папке работать?',
                    absent=['Для этой папки найдены настройки Harness'])
    terminal.send('\r')
    session.capture('project-workspace-restored', 'Чем займёмся?', True)


def tasks(session):
    terminal, fixture = session.terminal, session.fixture
    title = 'Отчёт проекта'
    run_id = session.start(title)
    fixture.request('complete', {'runId': run_id})
    session.actions(title)
    terminal.open_label('Технические подробности')
    for index, (name, expected) in enumerate([
        ('task', '[Задача]'), ('execution', '[Выполнение]'),
        ('files', '[Файлы]'), ('errors', '[Ошибки]'),
    ]):
        if index:
            terminal.send('\t')
        session.capture('details-' + name, expected, True)
    terminal.send('\x1b')
    terminal.wait_text('Что дальше?')
    terminal.open_label('Оценить результат')
    session.capture('feedback-choice', 'Вы проверили результат?')
    terminal.send('\r')
    session.capture('feedback-input', 'Что именно вы проверили')
    terminal.send('Проверил содержимое отчёта.\r')
    session.capture('feedback-saved', 'Отзыв сохранён', True)
    terminal.open_label('В главное меню')
    terminal.wait_text('Чем займёмся?')

    paused = session.start('Задача на паузе')
    fixture.request('inventory', {'kind': 'run', 'runId': paused, 'status': 'paused'})
    session.actions('Задача на паузе')
    session.capture('paused-actions', 'Продолжить после паузы', True)
    terminal.open_label('Расход токенов задачи')
    session.capture('paused-token-usage', 'Оценка Harness', True, ['Добавить квоту', 'Квота задачи:'])
    terminal.send('\x1b')
    terminal.wait_text('Что дальше?')
    terminal.open_label('Продолжить после паузы')
    session.capture('paused-resumed', 'Ход задачи', True)
    assert fixture.call('runtime.status', {'runId': paused})['status'] == 'running'
    terminal.send('\r')
    terminal.wait_text('Что дальше?')
    terminal.open_label('Остановить эту задачу')
    session.capture('cancel-confirmation', 'Остановить задачу и её подзадачи?', True)
    terminal.send('\x1b[D\r')
    terminal.wait_text('Что дальше?')
    terminal.open_label('В главное меню')
    terminal.wait_text('Чем займёмся?')

    failed = session.start('Неудачная задача')
    fixture.request('inventory', {'kind': 'run', 'runId': failed, 'status': 'failed'})
    session.actions('Неудачная задача')
    session.capture('failed-actions', 'Продолжить задачу', True)


def interrupted(session):
    terminal, fixture = session.terminal, session.fixture
    run_id = session.start('Проверка после обрыва')
    fixture.request('inventory', {'kind': 'run', 'runId': run_id,
                                  'status': 'cancelled', 'unknown': True})
    session.actions('Проверка после обрыва')
    session.capture('unknown-actions', 'Проверить прерванную операцию', True)
    terminal.open_label('Удалить навсегда')
    session.capture('purge-blocked', 'Удаление пока недоступно', True)
    terminal.send('\x1b')
    terminal.wait_text('Что дальше?')
    terminal.open_label('Проверить прерванную операцию')
    session.capture('unknown-review', 'Что установлено после проверки?', True)
    terminal.open_label('Показать операцию и аргументы')
    session.capture('unknown-arguments', 'Проверяемая операция', True)
    terminal.send('\x1b')
    terminal.wait_text('Что установлено после проверки?')
    terminal.open_label('Операция выполнилась')
    session.capture('unknown-result', 'Опишите фактический результат проверки')
    terminal.send('Файл проверен, операция выполнилась.\r')
    session.capture('unknown-confirmation', 'Зафиксировать этот проверенный результат?', True)
    terminal.send('\x1b[D\r')
    session.capture('unknown-resolved', 'Продолжить задачу', True)
    assert not fixture.call('runtime.status', {'runId': run_id})['unknownInvocations']


def knowledge(session):
    terminal, fixture = session.terminal, session.fixture
    source = session.start('Источник правил')
    fixture.request('complete', {'runId': source})
    fixture.request('inventory', {'kind': 'learning', 'runId': source})
    terminal.open_label('База знаний')
    session.capture('catalogue-page-one', 'страница 1/2', True)
    terminal.open_label('Следующая страница')
    session.capture('catalogue-page-two', 'страница 2/2', True)
    terminal.open_label('Только применяемые уроки')
    session.capture('catalogue-active', 'Применяемые уроки', True)
    terminal.open_label('Найти урок')
    session.capture('search-input', 'Название, роль, профиль или папка')
    terminal.send('Правило 1\r')
    session.capture('search-result', 'Поиск: Правило 1', True)
    terminal.open_label('Правило 1')
    session.capture('lesson', '[Урок]', True)
    terminal.send('\t')
    session.capture('proof', '[Доказательства]', True)
    terminal.send('\t')
    session.capture('evaluation', '[Оценка]', True)
    terminal.send('\r')
    session.capture('lesson-actions', 'Действия с уроком', True)
    terminal.open_label('Сохранить урок в Markdown')
    session.capture('lesson-exported', 'Урок сохранён', True)
    assert list((session.state / 'exports').glob('*.md'))
    terminal.send('\x1b')
    terminal.wait_text('[Урок]')
    terminal.send('\r')
    terminal.open_label('Сохранить урок в Markdown')
    session.capture('lesson-export-exists', 'Файл уже существует', True)
    terminal.send('\x1b')
    terminal.wait_text('[Урок]')
    terminal.send('\x1b')
    terminal.wait_text('Поиск: Правило 1')
    terminal.open_label('Вся очередь обучения')
    session.capture('queue', 'Обработано', True)
    terminal.send('\x1b')
    terminal.wait_text('Поиск: Правило 1')
    terminal.open_label('Версии и откаты')
    frame = session.capture('releases', 'Версии знаний', True)
    assert 'baseline' not in frame and '1970' not in frame
    terminal.send('\x1b')
    terminal.wait_text('Поиск: Правило 1')
    terminal.open_label('Правило 1')
    terminal.wait_text('[Урок]')
    exports, saved = session.state / 'exports', session.state / 'exports-saved'
    exports.rename(saved)
    exports.write_text('Проверочная помеха вместо каталога экспорта.')
    try:
        terminal.send('\r')
        terminal.open_label('Сохранить урок в Markdown')
        session.capture('lesson-export-error', 'Не удалось сохранить урок', True)
    finally:
        exports.unlink()
        saved.rename(exports)



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    parser.add_argument('--report-name', default='screen-inventory')
    parser.add_argument('--columns', type=int, nargs='+', choices=[48, 80], default=[48, 80])
    scenarios = ['settings', 'tasks', 'interrupted', 'knowledge', 'connection', 'startup',
                 'diagnostics', 'reset_data', 'external_reset', 'commands']
    parser.add_argument('--scenarios', nargs='+', choices=scenarios, default=scenarios)
    args = parser.parse_args()
    if not re.fullmatch('[a-z0-9-]+', args.report_name):
        parser.error('Имя отчёта может содержать только латинские буквы, цифры и дефис.')
    node = str(Path(args.node).resolve())
    audit = Audit(args.report_name)
    before = digest(ROOT / 'dist', '.js')
    with tempfile.TemporaryDirectory(prefix='harness-inventory-') as directory:
        for width in args.columns:
            for scenario in [globals()[name] for name in args.scenarios]:
                root = Path(directory).resolve() / (str(width) + '-' + scenario.__name__)
                session = None
                try:
                    session = Session(node, root, width, audit,
                                      owned=scenario in [connection, startup], broken=scenario is startup)
                    scenario(session)
                except Exception as error:
                    name = str(width) + 'x24/' + scenario.__name__
                    audit.failures.append({'screen': name, 'reason': str(error)})
                    print(name, 'ERROR:', str(error), flush=True)
                    if session:
                        audit.frames[name + '/failure'] = session.terminal.screen()
                finally:
                    if session:
                        session.close()
                    audit.save_frames()
    report = {'node': subprocess.check_output([node, '--version']).decode().strip(),
              'distDigest': before, 'distUnchanged': before == digest(ROOT / 'dist', '.js'),
              'coverage': audit.coverage, 'failures': audit.failures,
              'unverified': ['Реальная авторизация Codex и хранилище ключей ОС',
                             'Реальные облачные каталоги и ограничения аккаунтов провайдеров',
                             'Настройка при ошибке системного хранилища ключей']}
    audit.save_frames()
    (ROOT / ('docs/playtest-' + args.report_name + '.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'screens': len(audit.coverage), 'frames': len(audit.frames),
                      'failures': audit.failures, 'distUnchanged': report['distUnchanged']}, ensure_ascii=False, indent=2))
    if audit.failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
