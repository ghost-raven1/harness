#!/usr/bin/env python3
"""Проверяет большой вывод команды, чтение ответа по частям и полный экспорт на 48 колонках."""
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


def run_case(session):
    title = 'Длинный вывод команды'
    run_id = session.start(title)
    status = session.fixture.request('commandOutput', {'runId': run_id})
    assert status['status'] == 'awaiting_approval', status
    approvals = session.fixture.call('approvals.list')
    approval = next(item for item in approvals if item['runId'] == run_id)
    assert approval['tool'] == 'process.exec', approval
    session.fixture.call('approvals.decide', {'approvalId': approval['id'], 'allow': True})
    messages = session.fixture.request('modelMessages', {'runId': run_id})
    result = json.loads(next(item['content'] for item in reversed(messages) if item['role'] == 'tool'))
    assert result['truncated'] is True, result
    assert result['stdoutTruncated'] is True and result['stderrTruncated'] is True, result
    artifact = json.loads((session.state / 'artifacts' / run_id / (result['artifactId'] + '.txt')).read_text())
    assert artifact['exitCode'] == 0 and artifact['signal'] is None
    assert len(artifact['stdout']) == len(artifact['stderr']) == 1048576
    assert artifact['stdoutTruncated'] is True and artifact['stderrTruncated'] is True
    assert 'STDOUT_END' not in artifact['stdout'] and 'STDERR_END' not in artifact['stderr']

    terminal = session.terminal
    terminal.open_label('Мои задачи')
    terminal.open_label(title)
    terminal.wait_text('Ход задачи')
    terminal.send('\t\x1b[F')
    texts = ['Вывод команды обрезан: конец не сохранён.',
             'Вывод ошибок обрезан: конец не сохранён.',
             'Большой результат сохранён отдельно']
    for _ in range(35):
        if all(text in inventory.compact(terminal.screen()) for text in texts):
            break
        terminal.send('\x1b[A')
    else:
        raise AssertionError('Предупреждения не читаются в журнале\n' + terminal.screen())
    frame = session.capture('bounded-process-output-after-artifact', texts[0], True)
    assert all(text in inventory.compact(frame) for text in texts), frame
    return {
        'scenario': 'command-output',
        'approvedInvocation': approval['tool'],
        'artifactEnvelope': {key: result[key] for key in ['truncated', 'artifactId', 'stdoutTruncated', 'stderrTruncated']},
        'exitCode': artifact['exitCode'],
        'stdoutCharacters': len(artifact['stdout']),
        'stderrCharacters': len(artifact['stderr']),
        'lostTailsReported': True,
    }


def large_answer(session):
    title = 'Большой ответ'
    beginning = 'НАЧАЛО БОЛЬШОГО ОТВЕТА'
    ending = 'КОНЕЦ БОЛЬШОГО ОТВЕТА'
    answer = beginning + '\n\n' + 'Проверочная строка ответа для сохранения.\n' * 4000 + '\n' + ending
    assert len(answer.encode('utf8')) > 256 * 1024
    run_id = session.start(title)
    status = session.fixture.call('runtime.status', {'runId': run_id})
    root_id = next(agent['id'] for agent in status['agents'] if not agent.get('parentId'))
    session.fixture.request('answerAgent', {'runId': run_id, 'agentId': root_id, 'text': answer})
    deadline = time.monotonic() + 10
    while True:
        status = session.fixture.call('runtime.status', {'runId': run_id})
        if status['status'] == 'completed':
            break
        assert time.monotonic() < deadline, status['status']
        session.terminal.drain(0.1)
    assert status['resultTruncated'] is True
    assert status['resultLength'] == len(answer.encode('utf-16-le')) // 2
    first = status['resultPage']
    last = session.fixture.call('runtime.result', {'runId': run_id, 'cursor': first['nextCursor']})
    assert first['hasMore'] and not last['hasMore']
    assert first['text'] + last['text'] == answer

    session.actions(title)
    terminal = session.terminal
    terminal.open_label('Прочитать ответ')
    terminal.wait_text('Ответ · часть 1')
    frame = session.capture('large-answer-first-part', beginning, True)
    assert 'часть 1' in inventory.compact(frame) and 'Есть следующая часть' in inventory.compact(frame)
    terminal.send('\r')
    session.capture('large-answer-parts-menu', 'Какую часть открыть?', True)
    terminal.open_label('Следующая часть')
    terminal.wait_text('Ответ · часть 2')
    terminal.send('\x1b[F')
    frame = session.capture('large-answer-last-part', ending, True)
    assert 'Конец ответа' in inventory.compact(frame) and beginning not in frame
    terminal.send('\r')
    menu = session.capture('large-answer-last-part-actions', 'Предыдущая часть', True)
    assert 'Следующая часть' not in menu
    terminal.open_label('Предыдущая часть')
    terminal.wait_text('Ответ · часть 1')
    frame = session.capture('large-answer-previous-part', beginning, True)
    assert 'часть 1' in inventory.compact(frame)
    terminal.send('\x1b')
    terminal.wait_text('Что дальше?')
    terminal.open_label('Сохранить ответ')
    session.capture('large-answer-exported', 'Ответ сохранён:', True)
    exported = session.workspace / ('Ответ Harness ' + run_id + '.md')
    assert exported.read_bytes() == (answer + '\n').encode('utf8')
    assert not list(session.workspace.glob('.harness-answer-*.tmp'))
    return {
        'scenario': 'large-answer',
        'answerUtf8Bytes': len(answer.encode('utf8')),
        'answerUtf16Characters': status['resultLength'],
        'pages': 2,
        'previousPageReopened': True,
        'exportedBytes': exported.stat().st_size,
        'completeExportMatched': True,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    audit, results = inventory.Audit('source-bugs'), []
    source, before = inventory.digest(ROOT / 'src', '.ts'), inventory.digest(ROOT / 'dist', '.js')
    with tempfile.TemporaryDirectory(prefix='harness-source-bugs-') as directory:
        for name, scenario in [('command-output', run_case), ('large-answer', large_answer)]:
            session = inventory.Session(node, Path(directory).resolve() / name, 48, audit)
            try:
                results.append(scenario(session))
            except Exception as error:
                audit.failures.append({'case': name, 'reason': str(error)})
                audit.frames[session.prefix + 'failure'] = session.terminal.screen()
            finally:
                session.close()
                audit.save_frames()
    report = {
        'node': subprocess.check_output([node, '--version']).decode().strip(),
        'sourceDigest': source, 'distDigest': before,
        'distUnchanged': before == inventory.digest(ROOT / 'dist', '.js'),
        'results': results, 'coverage': audit.coverage, 'failures': audit.failures,
        'transport': 'isolated fixture with approved actual process and executor artifact',
    }
    (ROOT / 'docs/playtest-source-bugs.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if audit.failures or not report['distUnchanged']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
