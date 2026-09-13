import * as prompts from '@clack/prompts';
import { spawn } from 'node:child_process';
import { codexAccount } from '../../providers/codex/account.js';
import { codexExecutable } from '../../providers/codex/connection.js';
import { profileSchema, type Profile } from '../../configuration/schema.js';
import { note, selected } from '../ui.js';
import { activity } from './activity.js';
import { explainError } from './errors.js';

/** Использует вход Codex; официальный клиент сам открывает страницу авторизации при необходимости. */
export async function chooseCodex(): Promise<Profile | undefined> {
  while (true) {
    const spinner = activity();
    spinner.start('Проверяю вход в Codex и доступные модели');
    try {
      const account = await codexAccount();
      spinner.stop(account.loggedIn ? 'Вход в Codex найден' : 'Нужно войти в Codex');
      if (account.loggedIn && account.models.length) {
        note(
          'Используется ваш аккаунт Codex. Расход учитывается в лимитах этого аккаунта.\nДоступ к файлам и разрешения остаются под управлением Harness.\nСчётчик Harness — оценка; точные лимиты показывает Codex.',
          'Codex подключён',
        );
        const model = selected(
          await prompts.select({
            message: 'Модель Codex для задач',
            initialValue: account.models.find((item) => item.isDefault)?.id,
            options: account.models.map((item) => ({
              value: item.id,
              label: item.label,
              ...(item.isDefault ? { hint: 'по умолчанию в Codex' } : {}),
            })),
          }),
        );
        return profileSchema.parse({
          provider: 'codex',
          baseUrl: 'codex://account',
          model,
          retries: 0,
          outputTokens: 8192,
        });
      }
      if (account.loggedIn) throw new Error('В аккаунте пока нет доступных моделей Codex.');
      const login = selected(
        await prompts.confirm({
          message: 'Открыть вход в Codex?',
          active: 'Войти',
          inactive: 'Назад',
          initialValue: true,
        }),
      );
      if (!login) return undefined;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(codexExecutable(), ['login'], { stdio: 'inherit' });
        child.once('error', () => reject(new Error('Не удалось открыть вход в Codex.')));
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error('Вход в Codex не завершён.')),
        );
      });
    } catch (error) {
      spinner.stop('Подключение Codex не завершено');
      if (error instanceof Error && error.message === 'INTERACTIVE_CANCEL') throw error;
      prompts.log.warn(explainError(error));
      const retry = selected(
        await prompts.confirm({
          message: 'Повторить проверку Codex?',
          active: 'Повторить',
          inactive: 'Назад',
          initialValue: false,
        }),
      );
      if (!retry) return undefined;
    }
  }
}
