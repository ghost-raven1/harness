#!/usr/bin/env python3
"""Проверяет живой журнал настоящих fs.search/fs.list на 48 колонках и временных файлах."""
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


def run_case(session, kind):
    for index in range(1001):
        (session.workspace / ('entry-%04d.txt' % index)).write_text('Другой текст')
    title = 'Неполный поиск' if kind == 'search' else 'Страница папки'
    run_id = session.start(title)
    args = {'path': '.', 'text': 'Не найденный текст'} if kind == 'search' else {'path': '.', 'limit': 2}
    result = session.fixture.request('fileTool', {'runId': run_id, 'name': 'fs.' + kind, 'args': args})
    if kind == 'search':
        assert result['matches'] == [] and result['visited'] == 1000, result
        assert result['incomplete'] and result['reason'] == 'file_limit', result
        texts = ['Поиск неполный.', 'Укажите более узкую папку.']
    else:
        assert len(result['entries']) == 2 and result['total'] >= 1001, result
        assert result['offset'] == 0 and result['nextOffset'] == 2, result
        texts = ['Показано записей: 2 из ' + str(result['total']) + '.', 'Есть ещё записи в папке.']
    terminal = session.terminal
    terminal.open_label('Мои задачи')
    terminal.open_label(title)
    terminal.wait_text('Ход задачи')
    terminal.send('\t\x1b[F')
    for _ in range(35):
        frame = terminal.screen()
        if all(text in inventory.compact(frame) for text in texts):
            break
        terminal.send('\x1b[A')
    else:
        raise AssertionError('Сообщение не читается в журнале\n' + terminal.screen())
    frame = session.capture(kind + '-real-tool-result', texts[0], True)
    assert texts[1] in inventory.compact(frame), frame
    assert 'сохранён отдельно' not in frame, frame
    return {'tool': 'fs.' + kind, 'result': result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    audit, results = inventory.Audit('file-tools'), []
    source, before = inventory.digest(ROOT / 'src', '.ts'), inventory.digest(ROOT / 'dist', '.js')
    with tempfile.TemporaryDirectory(prefix='harness-file-tools-') as directory:
        for kind in ['search', 'list']:
            session = inventory.Session(node, Path(directory).resolve() / kind, 48, audit)
            try:
                results.append(run_case(session, kind))
            except Exception as error:
                audit.failures.append({'case': kind, 'reason': str(error)})
                audit.frames[session.prefix + 'failure'] = session.terminal.screen()
            finally:
                session.close()
                audit.save_frames()
    report = {
        'node': subprocess.check_output([node, '--version']).decode().strip(),
        'sourceDigest': source, 'distDigest': before,
        'distUnchanged': before == inventory.digest(ROOT / 'dist', '.js'),
        'results': results, 'coverage': audit.coverage, 'failures': audit.failures,
        'transport': 'isolated fixture with actual local tools',
    }
    (ROOT / 'docs/playtest-file-tools.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if audit.failures or not report['distUnchanged']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
