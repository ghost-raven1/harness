#!/usr/bin/env python3
"""Проверяет настройку порций шагов, автоматическую паузу и безопасное продолжение в PTY."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('inventory', ROOT / 'scripts/playtest-screen-inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


def iteration_status(session, run_id=None):
    state = session.fixture.call('iterations.status', {'runId': run_id} if run_id else {})
    return state['run'] if run_id else state


def change_prompt(session, amount, name, run_id=None):
    terminal = session.terminal
    state = iteration_status(session, run_id)
    current = state['limit'] if run_id else state['defaultLimit']
    terminal.open_label('Изменить предел')
    session.capture(name + '-input', 'Сколько шагов в одной порции?')
    terminal.send('\x7f' * len(str(current)) + str(amount) + '\r')
    return session.capture(name + '-confirm', 'Сохранить предел шагов?', True)


def save_limit(session, amount, name, run_id=None):
    change_prompt(session, amount, name, run_id)
    session.terminal.send('\x1b[D\r')
    session.capture(name + '-saved', 'Предел сохранён: ' + str(amount) + ' шагов.', True)
    state = iteration_status(session, run_id)
    assert (state['limit'] if run_id else state['defaultLimit']) == amount, state


def leave_setting(session, destination='Чем займёмся?'):
    session.terminal.open_label('Назад')
    session.terminal.wait_text(destination)


def return_main(session):
    session.terminal.open_label('В главное меню')
    session.terminal.wait_text('Чем займёмся?')


def restart(session):
    terminal = session.terminal
    terminal.open_label('Выход')
    terminal.expect('Сервис продолжает работать')
    terminal.finish()
    terminal.close()
    session.fixture.close()
    session.fixture = inventory.base.Fixture(session.node, session.config, session.state, session.workspace)
    session.terminal = inventory.Terminal(session.node, session.state, session.workspace, terminal.columns, 24)
    session.terminal.wait_text('Чем займёмся?')


def global_limit_and_resume(session, checks):
    terminal, fixture = session.terminal, session.fixture
    assert iteration_status(session)['defaultLimit'] == 256
    session.setting('Предел шагов')
    session.capture('global-default', 'Изменить предел', True)
    terminal.open_label('Как считаются шаги')
    session.capture('step-explanation', 'Как считаются шаги', True)
    terminal.send('\x1b')
    terminal.wait_text('Изменить предел')
    confirm = change_prompt(session, 1, 'global-refusal')
    assert '● Назад' in confirm, confirm
    terminal.send('\r')
    terminal.wait_text('Изменить предел')
    assert iteration_status(session)['defaultLimit'] == 256
    save_limit(session, 1, 'global-one')
    checks.append(session.prefix + 'global-change-and-refusal')

    change_prompt(session, 2, 'global-stale')
    fixture.call('iterations.configure', {'limit': 3})
    terminal.wait_text('Предел уже изменён')
    terminal.send('\r')
    session.capture('global-stale-blocked', 'Предел уже изменён в другом окне', True)
    assert iteration_status(session)['defaultLimit'] == 3
    fixture.call('iterations.configure', {'limit': 1})
    leave_setting(session)
    checks.append(session.prefix + 'global-stale-confirmation-preserves-external-change')

    title = 'Один шаг за раз'
    run_id = session.start(title)
    fixture.request('write', {'runId': run_id})
    assert fixture.call('runtime.status', {'runId': run_id})['status'] == 'paused'
    state = iteration_status(session, run_id)
    assert state['limit'] == 1 and state['used'] == 1 and state['total'] == 1, state
    assert state['remaining'] == 0 and state['pausedByLimit'] and state['editable'], state
    path = session.workspace / 'Однократная запись.txt'
    assert path.read_text() == 'Записано один раз.'
    original_time = path.stat().st_mtime_ns
    session.actions(title)
    session.capture('automatic-pause', 'Продолжить после паузы', True)
    terminal.open_label('Предел шагов задачи')
    session.capture('task-paused-limit', 'Достигнут предел. Задача на паузе.', True)
    frame = session.capture('task-paused-counts', 'В порции: 1 / 1 шагов', True)
    assert 'Всего выполнено: 1' in inventory.compact(frame), frame
    leave_setting(session, 'Что дальше?')
    return_main(session)
    restart(session)
    terminal, fixture = session.terminal, session.fixture
    assert iteration_status(session)['defaultLimit'] == 1
    assert iteration_status(session, run_id) == state, 'Перезапуск изменил порцию задачи'
    session.actions(title)
    session.capture('pause-after-restart', 'Продолжить после паузы', True)
    terminal.open_label('Продолжить после паузы')
    session.capture('resumed', 'Ход задачи', True)
    fixture.request('complete', {'runId': run_id})
    session.capture('resumed-completed', 'Что дальше?', True)
    assert fixture.call('runtime.status', {'runId': run_id})['status'] == 'completed'
    assert iteration_status(session, run_id)['total'] == 2
    assert iteration_status(session, run_id)['used'] == 1
    assert path.read_text() == 'Записано один раз.' and path.stat().st_mtime_ns == original_time
    record = json.loads((session.state / 'runs' / (run_id + '.json')).read_text())
    assert len(record['invocations']) == 1
    events = [json.loads(line) for line in (session.state / 'runs' / (run_id + '.jsonl')).read_text().splitlines()]
    assert sum(item['type'] == 'tool.started' for item in events) == 1
    assert sum(item['type'] == 'run.resumed' for item in events) == 1
    checks.extend([session.prefix + name for name in ['one-step-pauses-after-real-tool',
                  'limit-and-pause-survive-restart', 'resume-grants-next-portion',
                  'resume-does-not-repeat-completed-mutation']])
    return_main(session)


def guarded_task_change(session, checks):
    terminal, fixture = session.terminal, session.fixture
    title = 'Настройка задачи'
    run_id = session.start(title)
    session.actions(title)
    terminal.open_label('Предел шагов задачи')
    frame = session.capture('running-limit-read-only', 'Изменение доступно на паузе', True)
    assert '● Изменить предел' not in frame and '○ Изменить предел' not in frame, frame
    leave_setting(session, 'Что дальше?')
    return_main(session)
    fixture.request('write', {'runId': run_id})
    assert fixture.call('runtime.status', {'runId': run_id})['status'] == 'paused'
    session.actions(title)
    terminal.open_label('Предел шагов задачи')
    save_limit(session, 2, 'task-two', run_id)
    assert iteration_status(session)['defaultLimit'] == 1
    change_prompt(session, 4, 'task-stale', run_id)
    fixture.call('iterations.configure', {'runId': run_id, 'limit': 3})
    terminal.wait_text('Предел уже изменён')
    terminal.send('\r')
    session.capture('task-stale-blocked', 'Предел уже изменён в другом окне', True)
    assert iteration_status(session, run_id)['limit'] == 3
    leave_setting(session, 'Что дальше?')
    return_main(session)
    restart(session)
    terminal, fixture = session.terminal, session.fixture
    assert iteration_status(session, run_id)['limit'] == 3
    assert iteration_status(session)['defaultLimit'] == 1
    session.actions(title)
    terminal.open_label('Предел шагов задачи')
    change_prompt(session, 4, 'task-became-active', run_id)
    fixture.call('runtime.resume', {'runId': run_id})
    terminal.wait_text('Изменение доступно на паузе')
    terminal.send('\r')
    session.capture('active-confirmation-blocked', 'Изменение доступно на паузе', True)
    assert iteration_status(session, run_id)['limit'] == 3
    fixture.request('complete', {'runId': run_id})
    leave_setting(session, 'Что дальше?')
    return_main(session)
    checks.extend([session.prefix + name for name in ['running-task-cannot-change-limit',
                  'per-task-change-is-independent-and-persistent',
                  'task-stale-confirmation-preserves-external-change',
                  'resume-invalidates-open-confirmation']])

    removed = session.start('Удаляемая задача')
    fixture.request('write', {'runId': removed})
    session.actions('Удаляемая задача')
    terminal.open_label('Предел шагов задачи')
    change_prompt(session, 2, 'task-deleted', removed)
    fixture.call('runtime.cancel', {'runId': removed})
    fixture.call('runtime.delete', {'runId': removed})
    terminal.wait_text('Изменение доступно на паузе')
    terminal.send('\r')
    session.capture('deleted-confirmation-blocked', 'Изменение доступно на паузе', True)
    assert iteration_status(session, removed)['limit'] == 1
    assert not iteration_status(session, removed)['editable']
    checks.append(session.prefix + 'deleted-task-cannot-change-limit')
    preview = fixture.call('runtime.purgePreview', {'runId': removed})
    fixture.call('runtime.purge', {'runId': removed, 'previewToken': preview['previewToken']})
    frame = session.capture('purged-task-clears-limit', 'Задача удалена', True)
    assert 'В порции:' not in frame and 'Изменить предел' not in frame, frame
    terminal.send('\x1b')
    session.capture('purged-task-back-to-list', 'Мои задачи · страница', True)
    checks.append(session.prefix + 'purged-task-clears-stale-limit')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    audit, checks = inventory.Audit('iterations'), []
    before = inventory.digest(ROOT / 'dist', '.js')
    with tempfile.TemporaryDirectory(prefix='harness-iterations-') as directory:
        for width in [48, 80]:
            session = inventory.Session(node, Path(directory).resolve() / str(width), width, audit)
            try:
                global_limit_and_resume(session, checks)
                guarded_task_change(session, checks)
            except Exception as error:
                audit.failures.append({'width': width, 'reason': str(error)})
                audit.frames[str(width) + '/failure'] = session.terminal.screen()
                print(width, str(error), flush=True)
            finally:
                session.close()
                audit.save_frames()
    report = {'node': subprocess.check_output([node, '--version']).decode().strip(),
              'distDigest': before, 'distUnchanged': before == inventory.digest(ROOT / 'dist', '.js'),
              'checks': checks, 'coverage': audit.coverage, 'failures': audit.failures}
    (ROOT / 'docs/playtest-iterations.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'checks': len(checks), 'screens': len(audit.coverage), 'failures': audit.failures}, ensure_ascii=False))
    if audit.failures or not report['distUnchanged']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
