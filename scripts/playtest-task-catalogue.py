#!/usr/bin/env python3
"""Проверяет страницы каталога задач и пустой результат после внешней очистки."""
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


def catalogue(session):
    fixture, terminal = session.fixture, session.terminal
    for index in range(12):
        run_id = session.start('Архив ' + str(index + 1).zfill(2))
        fixture.request('complete', {'runId': run_id})
    terminal.open_label('Мои задачи')
    session.capture('page-one', 'страница 1/2', True)
    terminal.open_label('Следующая страница')
    frame = session.capture('page-two', 'страница 2/2', True)
    assert 'Архив 01' in frame and 'Архив 02' in frame
    terminal.open_label('Предыдущая страница')
    session.capture('back-page-one', 'страница 1/2', True)
    terminal.open_label('Найти задачу или ответ')
    session.capture('search', 'Слова из задачи, ответа или пути к папке')
    terminal.send('Несуществующая задача\r')
    session.capture('no-matches', 'Нет совпадений', True)
    terminal.open_label('Сбросить поиск')
    session.capture('search-cleared', 'страница 1/2', True)
    terminal.open_label('Следующая страница')
    session.capture('before-clear', 'страница 2/2', True)
    preview = fixture.call('maintenance.resetPreview', {'scope': 'tasks'})
    fixture.call('maintenance.reset', {'scope': 'tasks', 'previewToken': preview['previewToken']})
    frame = session.capture('empty-after-clear', 'Пока нет задач', True)
    assert 'страница 1/1' in frame and 'Архив ' not in frame
    assert fixture.call('runtime.list') == []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    audit = inventory.Audit('task-catalogue')
    before = inventory.digest(ROOT / 'dist', '.js')
    with tempfile.TemporaryDirectory(prefix='harness-catalogue-') as directory:
        for width in [48, 80]:
            session = inventory.Session(node, Path(directory).resolve() / str(width), width, audit)
            try:
                catalogue(session)
            except Exception as error:
                audit.failures.append({'width': width, 'reason': str(error)})
                audit.frames[str(width) + '/failure'] = session.terminal.screen()
            finally:
                session.close()
                audit.save_frames()
    report = {'node': subprocess.check_output([node, '--version']).decode().strip(),
              'distDigest': before, 'distUnchanged': before == inventory.digest(ROOT / 'dist', '.js'),
              'coverage': audit.coverage, 'failures': audit.failures}
    (ROOT / 'docs/playtest-task-catalogue.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'screens': len(audit.coverage), 'failures': audit.failures}, ensure_ascii=False))
    if audit.failures:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
