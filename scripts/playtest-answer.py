#!/usr/bin/env python3
"""Проверяет уточняющий ответ, чтение с начала и продолжение переписки в настоящем PTY."""
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

QUESTION = ('Алексей, какие ключи проверяем: **настройки, тексты и SEO в Studio** '
            'или **API-ключи доступа**?\n\n'
            'В истории поиска найдены первые; API-ключи пока не обнаружены. '
            'Уточни раздел админки — проверю без изменений и раскрытия секретов.')
REPLY = 'Настройки, тексты и SEO в Studio'
ANSWER_START = 'Уточнение принято: проверяем Studio'
ANSWER_END = 'Последняя строка полного ответа.'
ANSWER = (ANSWER_START + '\n\n' + '\n'.join(
    'Пункт %02d: проверяем подписи и расположение настроек без изменения файлов.' % index
    for index in range(1, 81)) + '\n\n' + ANSWER_END)


def bounded_frame(frame, columns):
    lines = [line.strip() for line in frame.splitlines()
             if line.lstrip().startswith(('╭', '╰', '│', '──'))]
    assert lines and max(map(len, lines)) <= min(columns, 108), frame
    assert 'Esc' in frame, frame


def contains_dialogue(messages):
    question = next((index for index, item in enumerate(messages)
                     if item['role'] == 'assistant' and item['content'] == QUESTION), None)
    replies = [index for index, item in enumerate(messages)
               if item['role'] == 'user' and item['content'] == REPLY]
    assert question is not None and any(index > question for index in replies), messages


def actions(session, label):
    terminal = session.terminal
    terminal.open_label('Мои задачи')
    terminal.wait_text('Мои задачи · страница')
    terminal.open_label(label)
    terminal.wait_text('Ход задачи')
    terminal.send('\r')
    terminal.wait_text('Что дальше?')


def to_main(session):
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


def answer_flow(session, checks):
    terminal, fixture = session.terminal, session.fixture
    width = terminal.columns

    def capture(name, text):
        frame = session.capture(name, text, True)
        bounded_frame(frame, terminal.columns)
        return frame

    first = session.start('Ключи админки')
    fixture.request('answer', {'runId': first, 'text': QUESTION})
    original = fixture.call('runtime.status', {'runId': first})
    assert original['status'] == 'completed' and original['result'] == QUESTION
    actions(session, 'Ключи админки')
    menu = capture('clarification-actions', 'Ответ получен')
    compact = inventory.compact(menu)
    assert 'Алексей, какие ключи проверяем' in compact, menu
    assert 'Ответить или продолжить' in compact and 'Прочитать ответ' in compact, menu
    assert 'Готово' not in menu, menu
    if width >= 80:
        assert ' '.join(QUESTION.split()) in compact, menu
    else:
        assert 'Полный ответ —' in compact, menu
    checks.append(session.prefix + 'completed-question-is-an-answer-not-success-claim')

    terminal.open_label('Прочитать ответ')
    reader = capture('clarification-reader', 'Ответ модели')
    assert ' '.join(QUESTION.split()) in inventory.compact(reader), reader
    assert reader.find('Алексей') < reader.find('В истории поиска'), reader
    checks.append(session.prefix + 'full-question-and-paragraphs-are-readable')
    terminal.send('\x1b')
    terminal.wait_text('Что дальше?')
    terminal.open_label('Ответить или продолжить')
    session.capture('reply-prompt', 'Ваш ответ модели или следующий шаг')
    terminal.send(REPLY + '\x13')
    terminal.wait_text('Ход задачи')
    runs = fixture.call('runtime.list')
    current = next(item['runId'] for item in runs if item['runId'] != first)
    status = fixture.call('runtime.status', {'runId': current})
    assert status['sessionId'] == original['sessionId'] and status['workspace'] == original['workspace']
    assert status['profile'] == original['profile']
    contains_dialogue(fixture.request('modelMessages', {'runId': current}))
    checks.append(session.prefix + 'next-model-request-includes-question-and-human-answer')
    fixture.request('answer', {'runId': current, 'text': ANSWER})
    capture('answer-actions', 'Ответить или продолжить')
    assert fixture.call('runtime.status', {'runId': current})['status'] == 'completed'
    checks.append(session.prefix + 'completed-statement-keeps-the-same-available-actions')

    terminal.open_label('Прочитать ответ')
    beginning = capture('answer-beginning', ANSWER_START)
    assert ANSWER_END not in beginning, beginning
    assert 'Пункт 01:' in beginning, beginning
    other_width = 48 if width == 200 else 200
    terminal.resize(other_width, 24)
    resized = capture('answer-resized-' + str(other_width), ANSWER_START)
    assert ANSWER_END not in resized, resized
    terminal.resize(width, 24)
    capture('answer-resize-restored', ANSWER_START)
    terminal.send('\x1b[F')
    tail = capture('answer-end', ANSWER_END)
    assert ANSWER_START not in tail, tail
    terminal.send('\x1b')
    terminal.wait_text('Что дальше?')
    terminal.open_label('Прочитать ответ')
    reopened = capture('answer-reopened-from-start', ANSWER_START)
    assert ANSWER_END not in reopened, reopened
    checks.extend([session.prefix + name for name in ['reader-opens-at-first-line',
                  'resize-preserves-readable-frame', 'long-answer-scrolls-to-end',
                  'reopening-starts-from-the-beginning']])
    terminal.send('\x1b')
    terminal.wait_text('Что дальше?')
    to_main(session)
    restart(session)
    terminal, fixture = session.terminal, session.fixture
    saved = fixture.call('runtime.status', {'runId': current})
    assert saved['sessionId'] == original['sessionId'] and saved['result'] == ANSWER
    assert fixture.call('runtime.status', {'runId': first})['result'] == QUESTION
    record = json.loads((session.state / 'runs' / (current + '.json')).read_text())
    contains_dialogue(record['agents'][record['rootAgentId']]['messages'])
    actions(session, 'Настройки, тексты')
    terminal.open_label('Прочитать ответ')
    capture('answer-after-restart', ANSWER_START)
    checks.append(session.prefix + 'dialogue-and-answer-survive-restart')

    preview = fixture.call('runtime.purgePreview', {'runId': current})
    fixture.call('runtime.purge', {'runId': current, 'previewToken': preview['previewToken']})
    removed = capture('answer-deleted-live', 'Задача удалена')
    assert ANSWER_START not in removed and 'Пункт 01:' not in removed, removed
    terminal.send('\x1b')
    capture('deleted-answer-back-to-list', 'Мои задачи · страница')
    assert fixture.call('runtime.list') == []
    checks.append(session.prefix + 'external-deletion-clears-answer-and-returns-to-list')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    audit, checks = inventory.Audit('answer'), []
    source, before = inventory.digest(ROOT / 'src', '.ts'), inventory.digest(ROOT / 'dist', '.js')
    with tempfile.TemporaryDirectory(prefix='harness-answer-') as directory:
        for width in [48, 80, 200]:
            session = inventory.Session(node, Path(directory).resolve() / str(width), width, audit)
            try:
                answer_flow(session, checks)
            except Exception as error:
                audit.failures.append({'width': width, 'reason': str(error)})
                audit.frames[str(width) + '/failure'] = session.terminal.screen()
                print(width, str(error), flush=True)
            finally:
                session.close()
                audit.save_frames()
    report = {'node': subprocess.check_output([node, '--version']).decode().strip(),
              'sourceDigest': source, 'distDigest': before,
              'distUnchanged': before == inventory.digest(ROOT / 'dist', '.js'),
              'checks': checks, 'coverage': audit.coverage, 'failures': audit.failures,
              'transport': 'isolated fixture', 'markdown': 'preserved as source text'}
    output = 'docs/playtest-answer.json' if not audit.failures else '.harness/answer-failed-report.json'
    (ROOT / output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'checks': len(checks), 'screens': len(audit.coverage), 'failures': audit.failures}, ensure_ascii=False))
    if audit.failures or not report['distUnchanged']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
