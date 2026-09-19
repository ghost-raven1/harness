import { parentPort } from 'node:worker_threads';
import { createTwoFilesPatch } from 'diff';

/** Тяжёлое сравнение изолировано от IPC; данные запроса никогда не исполняются как код. */
parentPort?.on('message', (input: { id: number; path: string; before: string; after: string }) => {
  try {
    const text = createTwoFilesPatch(
      'до/' + input.path,
      'после/' + input.path,
      input.before,
      input.after,
      undefined,
      undefined,
      { timeout: 1000, maxEditLength: 10_000, context: 3 },
    );
    parentPort?.postMessage({ id: input.id, text });
  } catch {
    parentPort?.postMessage({ id: input.id });
  }
});

// Отдельный сигнал исключает запуск Node.js и загрузку библиотеки из бюджета сравнения.
parentPort?.postMessage({ ready: true });
