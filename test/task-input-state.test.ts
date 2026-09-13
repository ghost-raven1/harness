import { expect, it } from 'vitest';
import { PasteDecoder, TaskInputState } from '../src/interfaces/guided/task-input-state.js';
import { taskTextLimit } from '../src/sessions/drafts.js';

it.each(['Первый абзац\nВторой абзац', 'Первый абзац\r\nВторой абзац'])(
  'вставка сохраняет обе строки: %s',
  (text) => {
    const state = new TaskInputState();
    const keys: string[] = [];
    const parser = new PasteDecoder(
      (value) => keys.push(value),
      (value) => state.insert(value),
    );
    for (const character of '\u001b[200~' + text + '\u001b[201~') parser.write(character);
    expect(state.text).toBe('Первый абзац\nВторой абзац');
    expect(keys).toEqual([]);
  },
);

it('Ctrl+S и Esc внутри вставки не становятся командами редактора', () => {
  const state = new TaskInputState();
  const keys: string[] = [];
  const parser = new PasteDecoder(
    (value) => keys.push(value),
    (value) => state.insert(value),
  );
  parser.write('\u001b[200~a\u0013\u001bb\u001b[201~');
  expect(state.text).toBe('ab');
  expect(keys).toEqual([]);
  parser.write('\u0013');
  expect(keys).toEqual(['\u0013']);
});

it('стрелки и одиночный Esc проходят как клавиши, не как текст вставки', () => {
  const keys: string[] = [];
  const parser = new PasteDecoder(
    (value) => keys.push(value),
    () => {
      throw Error('Unexpected paste');
    },
  );
  parser.write('\u001b[D');
  parser.write('\u001b');
  parser.flushEscape();
  expect(keys.join('')).toBe('\u001b[D\u001b');
});

it('лишний объём отклоняется целиком, существующий черновик остаётся', () => {
  const state = new TaskInputState('Начало');
  expect(state.insert('x'.repeat(taskTextLimit))).toBe(false);
  expect(state.text).toBe('Начало');
  expect(state.error).toContain('Вставка не добавлена');
});

it('Backspace удаляет emoji и составной символ целиком', () => {
  const state = new TaskInputState('а👩‍💻e\u0301');
  state.erase(true);
  expect(state.text).toBe('а👩‍💻');
  state.erase(true);
  expect(state.text).toBe('а');
});

it('обычный CRLF при разделении сетевых чанков добавляет одну новую строку', () => {
  const keys: string[] = [];
  const parser = new PasteDecoder(
    (text) => keys.push(text),
    () => undefined,
  );
  parser.write('Первая\r');
  parser.write('\nВторая');
  expect(keys.join('').replace(/\r/g, '\n')).toBe('Первая\nВторая');
});

it('стрелки перемещают курсор между строками, сохраняя удобную колонку', () => {
  const state = new TaskInputState('abcd\nef\nxyz');
  state.vertical(-1);
  expect(state.cursor).toBe(7);
  state.vertical(-1);
  expect(state.cursor).toBe(2);
  state.vertical(1);
  state.insert('!');
  expect(state.text).toBe('abcd\nef!\nxyz');
});
