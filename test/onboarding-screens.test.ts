import { beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { onboarding } from '../src/interfaces/guided/onboarding.js';
import { chooseFolder } from '../src/interfaces/guided/folders.js';
import { enterKey } from '../src/interfaces/guided/connection.js';
import { liveSelect, menuFrame } from '../src/interfaces/guided/live-select.js';
import { SessionKeys } from '../src/interfaces/guided/service.js';
import { configDirectory, temporary } from './helpers.js';

vi.mock('../src/interfaces/guided/folders.js', () => ({ chooseFolder: vi.fn() }));
vi.mock('../src/interfaces/guided/connection.js', () => ({
  enterKey: vi.fn(),
  chooseConnection: vi.fn(),
}));
vi.mock('../src/interfaces/guided/live-select.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/live-select.js')>()),
  liveSelect: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

it.each([48, 80])(
  'настройки проекта и разрешённые папки заменяют экран и помещаются при %s колонках',
  async (width) => {
    const root = join(await temporary(), 'Проект с длинным названием для проверки первого запуска');
    await mkdir(root);
    const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
    const selectedFolder = join(root, 'Запрещённая папка');
    const allowedFolder = join(root, 'Длинная разрешённая папка для файлов проекта');
    await mkdir(selectedFolder);
    await mkdir(allowedFolder);
    const manifest = JSON.parse(await readFile(config, 'utf8'));
    manifest.workspaces = ['../Длинная разрешённая папка для файлов проекта'];
    await writeFile(config, JSON.stringify(manifest));
    vi.mocked(chooseFolder).mockResolvedValue(selectedFolder);
    const frames: string[] = [];
    vi.mocked(liveSelect).mockImplementation(async (options) => {
      const menu = await options.load();
      const frame = stripVTControlCharacters(
        menuFrame(options.title, menu, menu.options[0]?.value, width, 24),
      );
      frames.push(frame);
      expect(frame).toContain('Harness by Ghost_Raven');
      expect(frame.split('\n').every((line) => stringWidth(line) <= width)).toBe(true);
      expect(frame.split('\n').length).toBeLessThan(24);
      expect(frame).toContain('Esc — назад');
      if (options.title === 'Настройки проекта') {
        expect(menu.options.map((item) => item.value)).toEqual(['project', 'separate']);
        expect(menu.summary).toContain(config);
        return 'project';
      }
      expect(options.title).toBe('Папка вне правил проекта');
      expect(menu.options).toEqual([{ value: allowedFolder, label: allowedFolder }]);
      expect(frame).not.toContain('Найдены настройки Harness');
      return allowedFolder;
    });
    const result = await onboarding(join(root, 'state'), new SessionKeys());
    expect(result).toEqual({ configFile: config, workspace: allowedFolder, profile: 'test' });
    expect(frames).toHaveLength(2);
    expect(enterKey).toHaveBeenCalledOnce();
  },
);

it('Esc на найденных настройках сохраняет отмену и не запрашивает ключ', async () => {
  const root = await temporary();
  await configDirectory(root, 'http://127.0.0.1:1/v1');
  vi.mocked(chooseFolder).mockResolvedValue(join(root, 'workspace'));
  vi.mocked(liveSelect).mockResolvedValueOnce(Symbol('cancel'));
  await expect(onboarding(join(root, 'state'), new SessionKeys())).rejects.toThrow(
    'INTERACTIVE_CANCEL',
  );
  expect(enterKey).not.toHaveBeenCalled();
});
