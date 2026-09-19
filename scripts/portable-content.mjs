import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const targets = {
  'linux-x64': 'linux',
  'win32-x64': 'windows',
  'darwin-arm64': 'macos',
  'darwin-x64': 'macos',
};

/** Готовую поставку собирает и проверяет только её собственная платформа. */
export function portableTarget(platform = process.platform, arch = process.arch) {
  const name = targets[platform + '-' + arch];
  if (!name)
    throw new Error('Нативная portable-сборка не поддерживается: ' + platform + '-' + arch);
  return { platform: name, nodePlatform: platform, arch };
}

/** Копирует дерево без ссылок, служебных npm bin и локальных переменных окружения. */
export async function copyPortableTree(source, destination, modules = false) {
  if (!(await lstat(source)).isDirectory())
    throw new Error('Источник должен быть обычным каталогом.');
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (modules && ['.bin', '.package-lock.json'].includes(entry.name)) continue;
    if (/^\.env(?:\.|$)/.test(entry.name)) throw new Error('Файл окружения запрещён в поставке.');
    if (entry.isDirectory())
      await copyPortableTree(join(source, entry.name), join(destination, entry.name), modules);
    else if (entry.isFile()) await cp(join(source, entry.name), join(destination, entry.name));
    else throw new Error('Ссылка или специальный файл запрещён: ' + entry.name);
  }
}

/** Кладёт только Node и его лицензии; npm и средства компиляции пользователю не нужны. */
export async function copyRuntime(destination) {
  const binary = await lstat(process.execPath);
  if (!binary.isFile()) throw new Error('Node должен быть обычным исполняемым файлом.');
  const runtime = join(destination, 'runtime');
  await mkdir(runtime);
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  await cp(process.execPath, join(runtime, name));
  await chmod(join(runtime, name), 0o755);
  const home =
    process.platform === 'win32' ? dirname(process.execPath) : dirname(dirname(process.execPath));
  await cp(join(home, 'LICENSE'), join(runtime, 'LICENSE'));
  if (process.platform === 'win32') {
    for (const entry of await readdir(home, { withFileTypes: true }))
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll'))
        await cp(join(home, entry.name), join(runtime, entry.name));
  }
}

/** Запуск использует встроенный Node даже при отсутствии node/npm в PATH. */
export async function writeLaunchers(root, version, target) {
  const shell = [
    '#!/bin/sh',
    '# Запускает готовый Harness без установки библиотек и системного Node.js.',
    'set -eu',
    'ROOT=$(CDPATH= cd -- "${0%/*}" && pwd)',
    'cd "$ROOT"',
    'PATH="$ROOT/runtime${PATH:+:$PATH}"',
    'export PATH',
    'exec "$ROOT/runtime/node" "$ROOT/dist/interfaces/cli.js" "$@"',
    '',
  ].join('\n');
  if (target.nodePlatform === 'win32') {
    await writeFile(
      join(root, 'Запустить Harness.cmd'),
      [
        '@echo off',
        'setlocal DisableDelayedExpansion',
        '"%SystemRoot%\\System32\\chcp.com" 65001 >nul',
        'cd /d "%~dp0"',
        'set "PATH=%~dp0runtime;%PATH%"',
        '"%~dp0runtime\\node.exe" "%~dp0dist\\interfaces\\cli.js" %*',
        'set "HARNESS_EXIT=%ERRORLEVEL%"',
        'if "%HARNESS_EXIT%"=="0" exit /b 0',
        'if "%HARNESS_EXIT%"=="130" exit /b 130',
        'echo Не удалось открыть Harness. Сообщение об ошибке находится выше.',
        'pause',
        'exit /b %HARNESS_EXIT%',
        '',
      ].join('\r\n'),
    );
  } else {
    await writeFile(join(root, 'start.sh'), shell, { mode: 0o755 });
    if (target.nodePlatform === 'darwin')
      await writeFile(join(root, 'Запустить Harness.command'), shell, { mode: 0o755 });
  }
  const launcher =
    target.nodePlatform === 'win32'
      ? 'Запустить Harness.cmd'
      : target.nodePlatform === 'darwin'
        ? 'Запустить Harness.command'
        : './start.sh';
  await writeFile(
    join(root, 'Начните здесь.txt'),
    [
      `Harness by Ghost_Raven ${version} · ${target.platform} ${target.arch}`,
      '',
      '1. Распакуйте весь архив в отдельную папку. Не запускайте файлы внутри ZIP.',
      `2. Откройте ${launcher}. На Linux выполните ./start.sh в терминале.`,
      '3. Выберите «Попробовать на учебном проекте»: сеть и API-ключи не нужны.',
      '4. Для своих задач настройте подключение в меню. Сам Harness не требует npm или сборки.',
      '',
      'Node.js, Codex и библиотеки уже включены. Не переносите отдельные файлы из этой папки.',
      'Для другой системы или архитектуры скачайте соответствующий ZIP.',
      'Задачи и настройки по умолчанию находятся в .harness в домашней папке пользователя.',
      'Обновление: остановите Harness и распакуйте новую версию отдельно. Сохранённое состояние останется доступным.',
      'Не заменяйте файлы работающего сервиса. Папки ваших проектов этим архивом не изменяются.',
      'В учебном режиме данные временные и удаляются при выходе.',
      '',
      'Интернет нужен для облачных моделей и входа в Codex, но не для установки и учебного проекта.',
      'На Linux системное хранилище ключей требует Secret Service в сеансе рабочего стола.',
      'Если macOS блокирует загруженный файл, откройте его через контекстное меню «Открыть».',
      'Если Linux не сохранил права: chmod +x start.sh runtime/node.',
      'Лицензии встроенных компонентов: THIRD_PARTY_NOTICES.md, runtime/LICENSE и node_modules.',
      '',
    ].join('\n'),
  );
}

const codexCommit = '6b9826e3aa83b1a5947db50f4332cb9c65f1b340';
const codexNotices = {
  LICENSE: 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc',
  NOTICE: '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915',
};

/** Дополняет npm-поставку лицензией Codex из проверенного коммита той же версии. */
export async function writeNotices(root, lock) {
  if (lock.packages['node_modules/@openai/codex']?.version !== '0.154.0')
    throw new Error('Обновите привязку лицензий к новой версии Codex перед выпуском.');
  const directory = join(root, 'licenses', 'codex');
  await mkdir(directory, { recursive: true });
  for (const [name, hash] of Object.entries(codexNotices)) {
    const response = await fetch(
      `https://raw.githubusercontent.com/openai/codex/${codexCommit}/${name}`,
      {
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error('Не удалось получить лицензию Codex: ' + response.status);
    const text = await response.text();
    if (createHash('sha256').update(text).digest('hex') !== hash)
      throw new Error('Контрольная сумма лицензии Codex не совпадает.');
    await writeFile(join(directory, name), text);
  }
  const notices = [
    '# Встроенные компоненты',
    '',
    'Node.js: runtime/LICENSE (включая уведомления его встроенных зависимостей).',
    'Codex 0.154.0: licenses/codex/LICENSE и NOTICE; исходный коммит ' + codexCommit + '.',
    'Штатные файлы лицензий npm-пакетов сохранены в соответствующих каталогах node_modules.',
    '',
    '| Пакет | Версия | Объявленная лицензия |',
    '| --- | --- | --- |',
  ];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.startsWith('node_modules/')) continue;
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (entry.dev) throw new Error('Dev-зависимость попала в готовую поставку: ' + path);
    notices.push(
      `| ${pkg.name} | ${pkg.version} | ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'см. файлы пакета')} |`,
    );
  }
  await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), notices.join('\n') + '\n');
}
