import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from './helpers.js';
import { FileLearningStore } from '../src/learning/store.js';

it('восстанавливает обучение по журналу даже при повреждённом JSON-снимке', async () => {
  const directory = await temporary();
  const original = new FileLearningStore(directory);
  await original.initialize();
  await original.update((state) => {
    state.paused = true;
  });
  await writeFile(join(directory, 'learning.json'), '{broken snapshot');

  const restored = new FileLearningStore(directory);
  await restored.initialize();
  expect(restored.read().paused).toBe(true);
  expect(restored.read().activeVersion).toBe('baseline');
});
