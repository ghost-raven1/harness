import { z } from 'zod';
import { ApplicationError } from '../../shared/application-error.js';
import { taskCommands } from './tasks.js';
import { learningCommands } from './learning.js';
import { draftCommands } from './drafts.js';
import { maintenanceCommands } from './maintenance.js';
import { systemCommands } from './system.js';

export const commands = {
  ...taskCommands,
  ...learningCommands,
  ...draftCommands,
  ...maintenanceCommands,
  ...systemCommands,
};
export type CommandName = keyof typeof commands;
export type CommandInput<M extends CommandName> = z.input<(typeof commands)[M]['params']>;
export type CommandResponse<M extends CommandName> = z.output<(typeof commands)[M]['response']>;
export type CommandRequest = <M extends CommandName>(
  method: M,
  ...args: RequestArguments<M>
) => Promise<CommandResponse<M>>;
export type RequestArguments<M extends CommandName> =
  {} extends CommandInput<M> ? [params?: CommandInput<M>] : [params: CommandInput<M>];

/** Отбрасывает неизвестную команду до обращения к прикладному слою. */
export function commandName(method: string): CommandName {
  if (!Object.hasOwn(commands, method))
    throw new ApplicationError('UNKNOWN_COMMAND', 'Неизвестная локальная команда: ' + method);
  return method as CommandName;
}
/** Проверяет параметры перед выполнением, применяя только объявленные значения по умолчанию. */
export function parseCommandInput<M extends CommandName>(
  method: M,
  input: unknown,
): CommandInput<M> {
  const parsed = commands[method].params.safeParse(input ?? {});
  if (!parsed.success)
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Аргументы команды не соответствуют контракту: ' + method,
      { cause: parsed.error },
    );
  return parsed.data as CommandInput<M>;
}
/** Проверяет ответ на обеих сторонах канала; повреждённый ответ не выглядит успешной операцией. */
export function parseCommandResponse<M extends CommandName>(
  method: M,
  response: unknown,
): CommandResponse<M> {
  const parsed = commands[method].response.safeParse(response);
  if (!parsed.success)
    throw new ApplicationError(
      'INVALID_RESPONSE',
      'Ответ команды не соответствует контракту: ' + method,
      { cause: parsed.error },
    );
  return parsed.data as CommandResponse<M>;
}
