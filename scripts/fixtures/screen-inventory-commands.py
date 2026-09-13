"""Проверяет самостоятельные команды CLI через тот же изолированный сервис."""
import json


def output(session, name, text):
    terminal = session.terminal
    terminal.expect(text)
    terminal.finish()
    frame = terminal.screen()
    key = session.prefix + name
    session.audit.frames[key] = frame
    session.audit.coverage[key] = {'status': 'passed', 'type': 'command-output', 'text': text}
    session.audit.save_frames()
    print(key, 'passed', flush=True)


def commands(session):
    fixture = session.fixture
    created = session.workspace / 'Созданные настройки'
    session.command(['init', str(created)])
    terminal = session.terminal
    session.capture('init-provider', 'Провайдер модели')
    terminal.open_label('openai-compatible')
    session.capture('init-workspace', 'Рабочая папка проекта', absent=['Провайдер модели'])
    terminal.send('\r')
    session.capture('init-model', 'ID модели из вашего аккаунта', absent=['Рабочая папка проекта'])
    terminal.send('\x01\x0binventory-local\r')
    session.capture('init-address', 'Адрес API', absent=['ID модели из вашего аккаунта'])
    terminal.send('\x01\x0bhttp://127.0.0.1:9/v1\r')
    session.capture('init-key-required', 'Этот API требует ключ?', absent=['Адрес API'])
    terminal.send('\r')
    output(session, 'init-result', 'Проект подготовлен')
    assert (created / 'harness.json').is_file()

    session.command(['approvals'])
    terminal = session.terminal
    session.capture('approvals-empty', 'Ожидающих разрешений нет', True)
    run_id = session.start('Проверка отказа в запуске программы')
    fixture.request('approval', {'runId': run_id})
    session.capture('approvals-pending-live', 'process.exec', True)
    terminal.open_label('process.exec')
    session.capture('approval-deny', 'Разрешить однократное выполнение этой операции?', True)
    terminal.send('\r')
    output(session, 'approval-denied', 'Выполнение отклонено')
    assert not fixture.call('approvals.list')
    record = json.loads((session.state / 'runs' / (run_id + '.json')).read_text())
    assert any(item['status'] == 'denied' for item in record['approvals'].values())
    fixture.call('runtime.cancel', {'runId': run_id})

    run_id = session.start('Разрешение в другом окне')
    fixture.request('approval', {'runId': run_id})
    session.command(['approvals'])
    terminal = session.terminal
    terminal.open_label('process.exec')
    session.capture('approval-before-external-decision', 'Разрешить однократное выполнение этой операции?', True)
    approval = fixture.call('approvals.list')[0]
    fixture.call('approvals.decide', {'approvalId': approval['id'], 'allow': False})
    session.capture('approval-external-decision', 'Операция уже разрешена или отменена', True)
    terminal.send('\r')
    terminal.finish()
    fixture.call('runtime.cancel', {'runId': run_id})

    session.command(['run', '--detach'])
    terminal = session.terminal
    session.capture('run-command-task', 'Что нужно сделать?')
    terminal.send('Задача через отдельную команду\x13')
    session.capture('run-command-profile', 'Профиль модели')
    terminal.send('\r')
    session.capture('run-command-workspace', 'Рабочая папка')
    terminal.send('\r')
    output(session, 'run-command-result', 'runId')
    for task in fixture.call('runtime.list'):
        if task['status'] == 'running':
            fixture.call('runtime.cancel', {'runId': task['runId']})

    session.command(['doctor', '--config', str(session.config)])
    output(session, 'doctor-command', 'Доступность модели проверяется при выполнении задачи.')
    session.command(['logs'])
    session.capture('logs-command', 'Включить запись в файл', True)
    session.terminal.send('\x1b')
    session.terminal.finish()
    session.command(['reset'])
    session.capture('reset-command', 'Что очистить?', True)
    session.terminal.send('\x1b')
    session.terminal.finish()

    run_id = session.start('Проверка ошибки удаления')
    fixture.request('complete', {'runId': run_id})
    session.command(['purge', run_id])
    terminal = session.terminal
    session.capture('purge-command', 'Удалить эту переписку навсегда?', True)
    fixture.request('failNext', {'method': 'runtime.purge'})
    terminal.send('\x1b[D\r')
    session.capture('purge-error', 'Удаление не выполнено', True)
    assert fixture.call('runtime.status', {'runId': run_id})['status'] == 'completed'
    terminal.send('\x1b')
    terminal.finish()

    session.command(['status', run_id])
    output(session, 'status-command', 'Модель:')
    session.command(['status'])
    output(session, 'status-list-command', 'Последние задачи')
    session.command(['learning', 'status'])
    output(session, 'learning-status-command', 'Самообучение')

    interrupted = session.start('Проверка команды resolve')
    fixture.request('inventory', {'kind': 'run', 'runId': interrupted,
                                  'status': 'cancelled', 'unknown': True})
    proof = session.workspace / 'Проверенный результат.txt'
    proof.write_text('Файл проверен: операция не выполнилась.')
    arguments = ['resolve', interrupted, 'inventory-write', '--result-file', str(proof), '--failed']
    session.command(arguments)
    session.capture('resolve-command-decline', 'Вы проверили фактический результат операции?')
    session.terminal.send('\r')
    session.terminal.finish()
    assert fixture.call('runtime.status', {'runId': interrupted})['unknownInvocations']
    session.command(arguments)
    session.capture('resolve-command-confirm', 'Вы проверили фактический результат операции?')
    session.terminal.send('\x1b[D\r')
    output(session, 'resolve-command-result', 'Результат')
    assert not fixture.call('runtime.status', {'runId': interrupted})['unknownInvocations']

    paused = session.start('Продолжение отдельной командой')
    fixture.request('inventory', {'kind': 'run', 'runId': paused, 'status': 'paused'})
    session.command(['resume', paused])
    fixture.request('complete', {'runId': paused})
    output(session, 'resume-command-result', 'Ответ получен')
    assert fixture.call('runtime.status', {'runId': paused})['status'] == 'completed'
    active = session.start('Отмена отдельной командой')
    session.command(['cancel', active])
    output(session, 'cancel-command-result', 'cancelled')
    assert fixture.call('runtime.status', {'runId': active})['status'] == 'cancelled'
