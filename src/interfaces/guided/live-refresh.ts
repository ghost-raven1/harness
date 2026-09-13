/** Обновляет только открытый экран; медленные запросы не накладываются друг на друга. */
export function startRefresh<T>(
  load: () => Promise<T>,
  onValue: (value: T) => void,
  onError: (error: unknown) => void,
  intervalMs = 1000,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const tick = async (): Promise<void> => {
    try {
      const value = await load();
      if (!stopped) onValue(value);
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    }
  };
  timer = setTimeout(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
