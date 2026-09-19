/** Мягкая пауза оставляет незапущенные вызовы для продолжения и не отменяет начатые эффекты. */
export class RunPausedError extends Error {
  constructor() {
    super('Задача приостановлена по запросу проекта.');
    this.name = 'RunPausedError';
  }
}
