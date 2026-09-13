export const IPC_REQUEST_BYTES = 1_200_000;
export const IPC_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Сериализация и предел проверяются до открытия сокета или отправки ответа. */
export function encodeFrame(
  value: unknown,
  maximumBytes: number,
  kind: 'request' | 'response',
): string {
  let frame: string;
  try {
    frame = JSON.stringify(value) + '\n';
  } catch (error) {
    throw new Error('Данные запроса или ответа нельзя передать в формате JSON.', { cause: error });
  }
  if (Buffer.byteLength(frame) > maximumBytes)
    throw new Error(
      kind === 'request'
        ? 'Запрос слишком большой для локального канала. Уменьшите объём передаваемых данных.'
        : 'Ответ слишком большой для локального канала. Запросите отдельную задачу или следующую страницу данных.',
    );
  return frame;
}
