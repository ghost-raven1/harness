import { stripVTControlCharacters } from 'node:util';

/** Вывод модели не может управлять курсором, заголовком окна или буфером обмена терминала. */
export function plainText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
