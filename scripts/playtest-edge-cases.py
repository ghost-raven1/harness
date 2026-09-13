#!/usr/bin/env python3
"""Проверяет удаление открытых экранов, экспорт, ввод и работу ролей на временных данных."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('inventory', ROOT / 'scripts/playtest-screen-inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


def task_actions(session, title):
    session.terminal.open_label('Мои задачи')
    session.terminal.wait_text('Мои задачи · страница')
    session.terminal.open_label(title)
    session.terminal.wait_text('Ход задачи')
    session.terminal.send('\r')
    session.terminal.wait_text('Что дальше?')


def purge(session, run_id):
    preview = session.fixture.call('runtime.purgePreview', {'runId': run_id})
    session.fixture.call('runtime.purge', {'runId': run_id, 'previewToken': preview['previewToken']})


def to_main(session):
    session.terminal.send('\x1b')
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


def task_input(session, checks):
    terminal, fixture = session.terminal, session.fixture
    terminal.open_label('Новая задача')
    session.capture('empty-editor', 'Ctrl+S — отправить', True)
    terminal.send('\r\x13')
    empty = session.capture('empty-input-not-submitted', 'Опишите задачу своими словами', True)
    assert 'Например: изучи файлы' not in empty and fixture.counts('runtime.run') == 0, empty
    terminal.send('\x7f')
    pasted = 'Первый абзац задачи\nВторая строка без отправки'
    terminal.send('\x1b[200~' + pasted + '\x1b[201~')
    terminal.send('\rПоследняя строка')
    text = pasted + '\nПоследняя строка'
    frame = session.capture('multiline-paste-stays-in-editor', 'Последняя строка', True)
    assert 'Первый абзац задачи' in frame and 'Вторая строка без отправки' in frame, frame
    assert fixture.counts('runtime.run') == 0
    terminal.send('\x1b')
    terminal.wait_text('Чем займёмся?')
    restart(session)
    terminal, fixture = session.terminal, session.fixture
    terminal.open_label('Новая задача')
    session.capture('saved-draft-after-restart', 'Сохранённые черновики', True)
    terminal.open_label('Первый абзац задачи')
    terminal.open_label('Продолжить ввод')
    restored = session.capture('restored-multiline-editor', 'Последняя строка', True)
    assert 'Вторая строка без отправки' in restored, restored
    fixture.request('connection', {'available': False})
    terminal.send('!\x13')
    failed = session.capture('offline-draft-keeps-input', 'Нет связи. Текст остаётся в этом окне.', True)
    assert 'Local service' not in failed, failed
    assert 'Последняя строка!' in failed and fixture.call('runtime.list') == [], failed
    fixture.request('connection', {'available': True})
    terminal.send('\x13')
    terminal.wait_text('Ход задачи')
    runs = fixture.call('runtime.list')
    assert len(runs) == 1, runs
    run_id = runs[0]['runId']
    status = fixture.call('runtime.status', {'runId': run_id})
    assert status['task'] == text + '!', status
    fixture.request('answer', {'runId': run_id, 'text': 'Многострочный ввод принят целиком.'})
    session.capture('restored-draft-submitted', 'Многострочный ввод принят целиком.', True)
    checks.extend([session.prefix + name for name in [
        'empty-submit-does-not-run-example', 'enter-and-paste-do-not-submit',
        'draft-survives-restart', 'offline-input-keeps-text-and-submits-after-reconnect']])


def lost_ack(session, checks):
    terminal, fixture = session.terminal, session.fixture
    text = 'Один запрос при потере ответа'
    terminal.open_label('Новая задача')
    terminal.wait_text('Ctrl+S — отправить')
    fixture.request('loseNextRunReply')
    terminal.send(text + '\x13')
    session.capture('run-accepted-with-lost-response', 'Запрос не подтверждён', True)
    before = fixture.call('runtime.list')
    assert len(before) == 1, before
    first_id = before[0]['runId']
    terminal.open_label('Повторить отправку')
    terminal.wait_text('Ход задачи')
    after = fixture.call('runtime.list')
    assert len(after) == 1 and after[0]['runId'] == first_id, after
    attempts = [item['params'] for item in fixture.request('metrics')['recent']
                if item['method'] == 'runtime.run']
    assert len(attempts) == 2 and len({item['requestKey'] for item in attempts}) == 1, attempts
    assert all(item['message'] == text for item in attempts), attempts
    fixture.request('answer', {'runId': first_id, 'text': 'Повтор открыл ту же задачу.'})
    session.capture('lost-response-retry-is-idempotent', 'Повтор открыл ту же задачу.', True)
    checks.append(session.prefix + 'accepted-request-retry-keeps-id-and-request-key')


def deleted_views(session, checks):
    terminal, fixture = session.terminal, session.fixture
    for view in ['actions', 'details']:
        title = 'Удаление ' + ('карточки' if view == 'actions' else 'сведений')
        run_id = session.start(title)
        fixture.request('answer', {'runId': run_id, 'text': 'Удаляемый проверочный ответ'})
        task_actions(session, title)
        if view == 'details':
            terminal.open_label('Технические подробности')
            terminal.wait_text('Сведения о задаче')
        purge(session, run_id)
        removed = session.capture(view + '-deleted-live', 'Задача удалена', True)
        assert 'Удаляемый проверочный ответ' not in removed and title not in removed, removed
        assert 'Нет связи' not in removed and 'Unknown run' not in removed, removed
        terminal.send('\x1b')
        session.capture(view + '-back-to-catalogue', 'Мои задачи · страница', True)
        assert fixture.call('runtime.list') == []
        checks.append(session.prefix + view + '-deletion-clears-content-and-returns-to-catalogue')
        to_main(session)


def export_answer(session, checks):
    terminal, fixture = session.terminal, session.fixture
    run_id = session.start('Сохранение ответа')
    answer = 'Полный ответ\n\nВторая строка\nПоследняя строка'
    fixture.request('answer', {'runId': run_id, 'text': answer})
    path = session.workspace / ('Ответ Harness ' + run_id + '.md')
    path.write_text('Заметки пользователя', encoding='utf8')
    task_actions(session, 'Сохранение ответа')
    terminal.open_label('Сохранить ответ')
    conflict = session.capture('answer-file-conflict', 'содержит другой текст', True)
    assert 'Переименуйте его.' in inventory.compact(conflict), conflict
    assert 'Ответ уже сохранён' not in conflict and 'Ответ сохранён:' not in conflict, conflict
    assert path.read_text() == 'Заметки пользователя'
    path.unlink()
    terminal.open_label('Сохранить ответ')
    session.capture('answer-file-saved', 'Ответ сохранён:', True)
    assert path.read_text() == answer + '\n'
    before = path.stat().st_mtime_ns
    terminal.open_label('Сохранить ответ')
    terminal.wait_text('Ответ сохранён:')
    assert path.stat().st_mtime_ns == before and path.read_text() == answer + '\n'
    assert not list(session.workspace.glob('.harness-answer-*.tmp'))
    checks.extend([session.prefix + name for name in [
        'different-export-is-not-overwritten-or-reported-as-saved',
        'whole-answer-export-and-identical-retry-leave-no-temporary-file']])
    terminal.open_label('В главное меню')
    terminal.wait_text('Чем займёмся?')


def role_activity(session, checks):
    terminal = session.terminal
    session.fixture.close()
    manifest = json.loads(session.config.read_text())
    manifest['coordination'] = 'auto'
    session.config.write_text(json.dumps(manifest))
    session.fixture = inventory.base.Fixture(session.node, session.config, session.state, session.workspace)
    fixture = session.fixture
    terminal.wait_text('Чем займёмся?')
    run_id = session.start('Две независимые проверки')
    tasks = [{'role': 'researcher', 'task': 'Проверка каталога', 'context': ''},
             {'role': 'reviewer', 'task': 'Проверка инструкций', 'context': ''}]
    status = fixture.request('planRoles', {'runId': run_id, 'tasks': tasks})
    agents = {item['role']: item for item in status['agents']}
    assert agents['researcher']['status'] == agents['reviewer']['status'] == 'running', status
    for role in ['researcher', 'reviewer']:
        fixture.request('modelMessages', {'runId': run_id, 'agentId': agents[role]['id']})
    terminal.open_label('Мои задачи')
    terminal.open_label('Две независимые проверки')
    session.capture('role-activity-header', 'Участников:', True)
    for _ in range(35):
        frame = terminal.screen()
        if 'Выбран способ работы' in inventory.compact(frame) and 'Проверки независимы' in inventory.compact(frame):
            break
        terminal.send('\x1b[A' * 3)
    else:
        raise AssertionError('План не найден в журнале\n' + terminal.screen())
    session.capture('automatic-plan-in-log', 'Проверки независимы', True)
    terminal.send('\r')
    terminal.wait_text('Что дальше?')
    terminal.open_label('Технические подробности')
    terminal.wait_text('Сведения о задаче')
    terminal.send('\t\x1b[F')
    active = session.capture('two-configured-roles-running', 'researcher · В работе', True)
    assert 'reviewer · В работе' in inventory.compact(active), active
    result_a, result_b = 'Каталог проверен исследователем', 'Инструкции проверены рецензентом'
    fixture.request('answerAgent', {'runId': run_id, 'agentId': agents['researcher']['id'], 'text': result_a})
    partial = session.capture('first-role-completed-live', 'researcher · Ответ получен', True)
    assert 'reviewer · В работе' in inventory.compact(partial), partial
    fixture.request('answerAgent', {'runId': run_id, 'agentId': agents['reviewer']['id'], 'text': result_b})
    session.capture('second-role-completed-live', 'reviewer · Ответ получен', True)
    root_id = agents['coordinator']['id']
    messages = fixture.request('modelMessages', {'runId': run_id, 'agentId': root_id})
    if result_a not in json.dumps(messages, ensure_ascii=False):
        fixture.request('answerAgent', {'runId': run_id, 'agentId': root_id, 'text': 'Собираю результаты подзадач.'})
        messages = fixture.request('modelMessages', {'runId': run_id, 'agentId': root_id})
    context = json.dumps(messages, ensure_ascii=False)
    assert result_a in context and result_b in context, messages
    fixture.request('answerAgent', {'runId': run_id, 'agentId': root_id, 'text': 'Обе проверки получены и сопоставлены.'})
    status = fixture.call('runtime.status', {'runId': run_id})
    deadline = time.monotonic() + 8
    while status['status'] == 'running' and time.monotonic() < deadline:
        terminal.drain(0.1)
        status = fixture.call('runtime.status', {'runId': run_id})
    assert status['status'] == 'completed', status
    terminal.send('\x1b')
    session.capture('coordinator-final-answer', 'Обе проверки получены', True)
    terminal.open_label('Прочитать ответ')
    session.capture('coordinator-full-answer', 'Обе проверки получены и сопоставлены.', True)
    checks.extend([session.prefix + name for name in [
        'validated-auto-plan-starts-two-configured-roles',
        'role-completion-updates-open-details',
        'coordinator-receives-both-child-results-before-final-answer']])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    parser.add_argument('--groups', default='input,ack,deletion,export,roles')
    parser.add_argument('--report-name', default='edge-cases')
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    audit, checks = inventory.Audit(args.report_name), []
    source, before = inventory.digest(ROOT / 'src', '.ts'), inventory.digest(ROOT / 'dist', '.js')
    groups = {'input': task_input, 'ack': lost_ack, 'deletion': deleted_views,
              'export': export_answer, 'roles': role_activity}
    with tempfile.TemporaryDirectory(prefix='harness-edge-cases-') as directory:
        for width in [48, 80]:
            for name in args.groups.split(','):
                session = inventory.Session(node, Path(directory).resolve() / (str(width) + '-' + name), width, audit)
                try:
                    groups[name](session, checks)
                except Exception as error:
                    audit.failures.append({'width': width, 'group': name, 'reason': str(error)})
                    audit.frames[session.prefix + 'failure'] = session.terminal.screen()
                    print(width, name, str(error), flush=True)
                finally:
                    session.close()
                    audit.save_frames()
    report = {'node': subprocess.check_output([node, '--version']).decode().strip(),
              'sourceDigest': source, 'distDigest': before,
              'distUnchanged': before == inventory.digest(ROOT / 'dist', '.js'),
              'checks': checks, 'coverage': audit.coverage, 'failures': audit.failures,
              'transport': 'isolated fixture'}
    (ROOT / ('docs/playtest-' + args.report_name + '.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'checks': len(checks), 'screens': len(audit.coverage), 'failures': audit.failures}, ensure_ascii=False))
    if audit.failures or not report['distUnchanged']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
