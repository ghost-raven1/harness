import ora from 'ora';

/** Ora рисует индикатор; обработка клавиш и закрытие сервиса остаются у рабочего стола. */
export function activity(): { start(text: string): void; stop(text: string): void } {
  const spinner = ora({
    stream: process.stdout,
    discardStdin: false,
    isSilent: !process.stdout.isTTY,
  });
  return {
    /** Показывает индикатор, оставляя обработку клавиш текущему экрану. */
    start(text) {
      spinner.start(text);
    },
    /** Завершает индикатор и оставляет итоговую строку на экране. */
    stop(text) {
      spinner.stopAndPersist({ symbol: '·', text });
    },
  };
}
