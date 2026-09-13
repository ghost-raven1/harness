"""Проверяет очистку и диагностику через настоящие экраны и второго клиента."""
import json
from pathlib import Path


def diagnostics(session):
    terminal, fixture = session.terminal, session.fixture
    session.setting('Диагностический лог')
    session.capture('log-off', 'Включить запись в файл', True)
    assert fixture.call('diagnostics.status')['enabled'] is False
    terminal.open_label('Включить запись в файл')
    session.capture('log-on', 'Выключить запись в файл', True)
    fixture.call('learning.pause')
    log = Path(fixture.call('diagnostics.status')['file'])
    records = [json.loads(line) for line in log.read_text().splitlines()]
    assert any(record.get('method') == 'learning.pause' for record in records)
    assert all(not any(key in record for key in ['args', 'params', 'result', 'message']) for record in records)
    terminal.open_label('Где хранится лог и что записывается')
    session.capture('log-details', 'Запись включена.', True)
    fixture.call('diagnostics.configure', {'enabled': False})
    session.capture('log-details-updated', 'Запись выключена.', True)
    before = log.read_bytes()
    fixture.call('learning.pause')
    assert log.read_bytes() == before
    terminal.send('\x1b')
    session.capture('log-menu-updated', 'Включить запись в файл', True)
    session.restart_service()
    fixture = session.fixture
    session.capture('log-off-after-restart', 'Включить запись в файл', True)
    assert fixture.call('diagnostics.status')['enabled'] is False
    fixture.call('diagnostics.configure', {'enabled': True})
    session.capture('log-external-enable', 'Выключить запись в файл', True)
    session.restart_service()
    fixture = session.fixture
    assert fixture.call('diagnostics.status')['enabled'] is True
    session.capture('log-on-after-restart', 'Выключить запись в файл', True)
    terminal.open_label('Выключить запись в файл')
    session.capture('log-ui-disabled', 'Включить запись в файл', True)
    assert fixture.call('diagnostics.status')['enabled'] is False


def reset_data(session):
    terminal, fixture = session.terminal, session.fixture
    source = session.start('Задача перед очисткой')
    fixture.request('complete', {'runId': source})
    fixture.request('inventory', {'kind': 'learning', 'runId': source})
    sentinel = session.workspace / 'Мой документ.txt'
    sentinel.write_text('Файл пользователя должен сохраниться.')
    session.setting('Очистка данных')
    session.capture('reset-picker', 'Что очистить?', True)
    terminal.open_label('Задачи, история и знания')
    session.capture('reset-decline', 'Удалить выбранные данные навсегда?', True)
    terminal.send('\r')
    session.capture('reset-declined', 'Что очистить?', True)
    assert fixture.call('maintenance.resetPreview', {'scope': 'all'})['tasks'] == 1
    assert fixture.call('maintenance.resetPreview', {'scope': 'all'})['lessons'] == 8
    terminal.send('\x1b')
    terminal.wait_text('Чем займёмся?')

    for scope, label, tasks_left, lessons_left in [
        ('learning', 'Накопленные знания', 1, 0),
        ('tasks', 'Задачи и история', 0, 8),
        ('all', 'Задачи, история и знания', 0, 0),
    ]:
        if scope == 'tasks':
            fixture.request('inventory', {'kind': 'learning', 'runId': source})
        if scope == 'all':
            source = session.start('Новая задача перед полной очисткой')
            fixture.request('complete', {'runId': source})
        session.setting('Очистка данных')
        terminal.open_label(label)
        session.capture('reset-' + scope + '-confirmation', 'Удалить выбранные данные навсегда?', True)
        terminal.send('\x1b[D\r')
        session.capture('reset-' + scope + '-result', 'Данные очищены', True)
        remaining = fixture.call('maintenance.resetPreview', {'scope': 'all'})
        assert remaining['tasks'] == tasks_left and remaining['lessons'] == lessons_left, remaining
        assert sentinel.read_text() == 'Файл пользователя должен сохраниться.'
        assert json.loads(session.config.read_text())['workspaces'][0] == str(session.workspace)
        terminal.send('\x1b')
        terminal.wait_text('Чем займёмся?')

    active = session.start('Работающая задача')
    session.setting('Очистка данных')
    terminal.open_label('Задачи и история')
    session.capture('reset-blocked', 'Очистка пока недоступна', True)
    fixture.call('runtime.cancel', {'runId': active})
    session.capture('reset-unblocked-live', 'Теперь очистка доступна.', True)
    terminal.send('\x1b')
    terminal.wait_text('Что очистить?')
    terminal.open_label('Задачи и история')
    session.capture('reset-before-drift', 'Удалить выбранные данные навсегда?', True)
    added = session.start('Задача другого клиента')
    fixture.request('complete', {'runId': added})
    session.capture('reset-drift', 'Состав изменился.', True)
    terminal.send('\x1b[D\r')
    assert fixture.call('maintenance.resetPreview', {'scope': 'all'})['tasks'] == 2
    terminal.send('\x1b')


def external_reset(session):
    terminal, fixture = session.terminal, session.fixture
    source = session.start('Удаляемая задача')
    fixture.request('complete', {'runId': source})
    terminal.open_label('Мои задачи')
    terminal.open_label('Удаляемая задача')
    session.capture('before-external-task-reset', 'Ход задачи', True)
    preview = fixture.call('maintenance.resetPreview', {'scope': 'tasks'})
    fixture.call('maintenance.reset', {'scope': 'tasks', 'previewToken': preview['previewToken']})
    try:
        frame = session.capture('external-task-reset', 'Задача удалена', True)
        assert 'Готово: Удаляемая задача' not in frame
    except AssertionError as error:
        session.audit.frames[session.prefix + 'external-task-reset-failure'] = terminal.screen()
        session.audit.failures.append({'screen': session.prefix + 'external-task-reset', 'reason': str(error)})
    terminal.send('\x1b')
    terminal.wait_text('Мои задачи')
    terminal.send('\x1b')
    terminal.wait_text('Чем займёмся?')
    source = session.start('Источник удаляемых знаний')
    fixture.request('complete', {'runId': source})
    fixture.request('inventory', {'kind': 'learning', 'runId': source})
    terminal.open_label('База знаний')
    terminal.open_label('Правило 8')
    session.capture('before-external-lesson-reset', '[Урок]', True)
    preview = fixture.call('maintenance.resetPreview', {'scope': 'learning'})
    fixture.call('maintenance.reset', {'scope': 'learning', 'previewToken': preview['previewToken']})
    frame = session.capture('external-lesson-reset', 'Урок удалён', True)
    assert 'Перед изменением файла' not in frame
    terminal.send('\x1b')
    session.capture('knowledge-empty-after-reset', 'Уроков пока нет', True)
    fixture.request('inventory', {'kind': 'learning', 'runId': source})
    terminal.wait_text('Правило 8')
    terminal.open_label('Правило 8')
    terminal.wait_text('[Урок]')
    terminal.send('\r')
    session.capture('lesson-actions-before-reset', 'Действия с уроком', True)
    preview = fixture.call('maintenance.resetPreview', {'scope': 'learning'})
    fixture.call('maintenance.reset', {'scope': 'learning', 'previewToken': preview['previewToken']})
    frame = session.capture('lesson-actions-after-reset', 'Урок удалён в другом окне.', True)
    assert 'Сохранить урок в Markdown' not in frame and 'Правило 8' not in frame
    terminal.send('\x1b')
    session.capture('knowledge-empty-after-actions', 'Уроков пока нет', True)
