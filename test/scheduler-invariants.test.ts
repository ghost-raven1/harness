import { expect, it } from 'vitest';
import { ToolScheduler } from '../src/tools/scheduler.js';
import { eventually } from './helpers.js';

it.each([1, 2, 4])(
  'очередь сохраняет порядок и освобождает блокировки после ошибки, reads=%i',
  async (limit) => {
    const scheduler = new ToolScheduler(limit);
    const events: string[] = [];
    let readers = 0;
    let writer = false;
    let peak = 0;
    const jobs = Array.from({ length: 24 }, (_, index) => {
      const effect = index % 4 === 2 ? 'write' : 'read';
      return scheduler.schedule(effect, async () => {
        expect(writer).toBe(false);
        if (effect === 'write') {
          expect(readers).toBe(0);
          writer = true;
        } else {
          readers++;
          peak = Math.max(peak, readers);
          expect(readers).toBeLessThanOrEqual(limit);
        }
        events.push('start:' + index);
        try {
          await new Promise((resolve) => setTimeout(resolve, (index % 3) + 1));
          if (index === 6) throw new Error('Контролируемая ошибка записи');
        } finally {
          events.push('end:' + index);
          if (effect === 'write') writer = false;
          else readers--;
        }
      });
    });
    const results = await Promise.allSettled(jobs);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results[6]).toMatchObject({ status: 'rejected' });
    expect(events).toHaveLength(48);
    expect(peak).toBeGreaterThan(0);
    for (let index = 2; index < 24; index += 4) {
      const start = events.indexOf('start:' + index);
      const end = events.indexOf('end:' + index);
      for (let before = 0; before < index; before++)
        expect(events.indexOf('end:' + before)).toBeLessThan(start);
      for (let after = index + 1; after < 24; after++)
        expect(events.indexOf('start:' + after)).toBeGreaterThan(end);
    }
  },
);

it('отмена ожидающей записи снимает её барьер для следующих чтений', async () => {
  const scheduler = new ToolScheduler(2);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const reading = scheduler.schedule('read', async () => {
    events.push('reading');
    await gate;
  });
  const controller = new AbortController();
  const writing = scheduler.schedule(
    'write',
    async () => {
      events.push('writing');
    },
    controller.signal,
  );
  const cancelled = expect(writing).rejects.toThrow('CANCELLED');
  const next = scheduler.schedule('read', async () => {
    events.push('next');
  });
  try {
    expect(events).toEqual(['reading']);
    controller.abort();
    await cancelled;
    await eventually(() => events.includes('next'));
    expect(events).toEqual(['reading', 'next']);
  } finally {
    release();
    await Promise.all([reading, next]);
  }
});
