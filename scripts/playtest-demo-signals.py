#!/usr/bin/env python3
"""Проверяет ранний SIGTERM и выход из raw-режима настоящего учебного CLI в PTY."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
READY = 'Начать учебный проект'.encode('utf-8')


class DemoProcess:
    """Владеет одним дочерним процессом и постоянно освобождает буфер его терминала."""

    def __init__(self, node, temporary, width):
        self.master, self.slave = pty.openpty()
        self.output = bytearray()
        self.closed = False
        self.child = None
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, width, 0, 0))
        self.original_mode = termios.tcgetattr(self.slave)[3]
        environment = {
            **os.environ,
            'TERM': 'xterm-256color',
            'TMPDIR': str(temporary),
            'HARNESS_STATE_DIR': str(temporary / 'ordinary-state'),
            'NO_COLOR': '1',
        }
        try:
            self.child = subprocess.Popen(
                [node, str(ROOT / 'dist/interfaces/cli.js'), 'demo'],
                stdin=self.slave, stdout=self.slave, stderr=self.slave,
                env=environment, start_new_session=True, cwd=ROOT,
            )
        except BaseException:
            os.close(self.master)
            os.close(self.slave)
            raise

    def drain(self, delay=0.003):
        """Не позволяет тесту заблокировать синхронный TTY write во время завершения."""
        if select.select([self.master], [], [], delay)[0]:
            self.output.extend(os.read(self.master, 65536))
            # Для диагностики достаточно хвоста; повторная перерисовка не накапливает память.
            del self.output[:-65536]

    def wait_for(self, predicate, timeout, description):
        """Ожидает наблюдаемое состояние, продолжая читать вывод терминала."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.drain()
            if predicate():
                return
            if self.child.poll() is not None:
                raise AssertionError(f'CLI завершился до {description}: {self.tail()}')
        raise AssertionError(f'Таймаут: {description}. Последний экран: {self.tail()}')

    def wait_exit(self, timeout):
        """Ожидает свой процесс без блокирующего wait на заполненном канале PTY."""
        deadline = time.monotonic() + timeout
        while self.child.poll() is None and time.monotonic() < deadline:
            self.drain()
        if self.child.poll() is None:
            raise AssertionError(f'CLI не завершился после SIGTERM: {self.tail()}')
        while select.select([self.master], [], [], 0.02)[0]:
            self.drain(0)
        return self.child.returncode

    def tail(self):
        """Возвращает ограниченную диагностику исключительно учебного окна."""
        return bytes(self.output[-4000:]).decode('utf-8', errors='replace')

    def close(self):
        """Убирает только собственный процесс; повторный вызов не посылает новый сигнал."""
        if self.closed:
            return
        self.closed = True
        try:
            if self.child.poll() is None:
                try:
                    self.child.send_signal(signal.SIGTERM)
                    self.wait_exit(5)
                except (ProcessLookupError, AssertionError):
                    if self.child.poll() is None:
                        self.child.kill()
                    self.child.wait(timeout=5)
        finally:
            os.close(self.master)
            os.close(self.slave)


def run_case(node, mode, width, results, checks):
    """Каждый случай имеет короткий TMPDIR и не касается обычных каталогов Harness."""
    name = f'{width}x24/{mode}'
    # Короткий путь нужен для ограничения sockaddr_un на macOS и Linux.
    with tempfile.TemporaryDirectory(prefix='hds-', dir='/tmp') as folder:
        temporary = Path(folder)
        terminal = DemoProcess(node, temporary, width)
        result = {'name': name, 'signal': 'SIGTERM'}
        results.append(result)
        try:
            if mode == 'startup':
                terminal.wait_for(
                    lambda: any(temporary.glob('harness-demo-*')),
                    20, 'создания временной учебной папки',
                )
            else:
                terminal.wait_for(lambda: READY in terminal.output, 20, 'открытия учебного меню')
            raw_before = not bool(termios.tcgetattr(terminal.slave)[3] & termios.ICANON)
            result['rawBefore'] = raw_before
            if mode == 'active':
                assert raw_before, 'Активное меню не включило raw-режим терминала'
                checks.append(name + '/raw-mode-active')
            terminal.child.send_signal(signal.SIGTERM)
            result['exitCode'] = terminal.wait_exit(20)
            assert result['exitCode'] == 130, terminal.tail()
            checks.append(name + '/exit-130')
            remaining = list(temporary.glob('harness-demo-*'))
            assert not remaining, 'После завершения остались учебные данные'
            assert not (temporary / 'ordinary-state').exists(), 'Демо затронуло обычный каталог состояния'
            result['temporaryRootsRemaining'] = len(remaining)
            checks.append(name + '/owned-data-removed')
            mask = termios.ECHO | termios.ICANON
            current = termios.tcgetattr(terminal.slave)[3]
            assert current & mask == terminal.original_mode & mask, 'Режим терминала не восстановлен'
            result['terminalRestored'] = True
            checks.append(name + '/terminal-restored')
        except BaseException as error:
            result['error'] = str(error)
            result['output'] = terminal.tail()
            raise
        finally:
            terminal.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--output', default='releases/project-playtest/demo-signals.json')
    args = parser.parse_args()
    node = str(Path(args.node).resolve())
    if not (ROOT / 'dist/interfaces/cli.js').is_file():
        parser.error('Сначала соберите CLI командой npm run build.')
    results, checks = [], []
    try:
        for width in [48, 80]:
            for mode in ['startup', 'active']:
                run_case(node, mode, width, results, checks)
    finally:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps({'cases': results, 'checks': checks}, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )
    print(json.dumps({'passed': len(checks), 'output': args.output}, ensure_ascii=False))


if __name__ == '__main__':
    main()
