import color from 'picocolors';

export let brandName = 'Harness by Ghost_Raven';

/** Помечает все учебные экраны и возвращает прежнюю подпись после завершения. */
export function enterDemoBrand(): () => void {
  const previous = brandName;
  brandName = 'ДЕМО · Harness by Ghost_Raven';
  return () => {
    brandName = previous;
  };
}

/** Терминальный знак H и название; ширина выбирается до добавления ANSI-цветов. */
export function renderLogo(columns: number, ascii = false): string {
  if (brandName.startsWith('ДЕМО')) return color.cyan('[H] ') + color.bold(brandName);
  if (columns < 11) return color.bold('H');
  if (ascii || columns < 28) {
    const heading = color.cyan('[H]') + ' ' + color.bold('Harness');
    if (columns >= brandName.length + 4) return color.cyan('[H]') + ' ' + color.bold(brandName);
    return columns >= 18 ? heading + '\n    ' + color.dim('by Ghost_Raven') : heading;
  }

  if (columns < 58) {
    return [
      color.cyan('╭─╮ ╭─╮') + '  ' + color.bold('Harness'),
      color.cyan('│ ├─┤ │') + '  ' + color.dim('by Ghost_Raven'),
      color.cyan('╰─╯ ╰─╯'),
    ].join('\n');
  }

  return [
    color.cyan('  ╭─╮     ╭─╮'),
    color.cyan('  │ ├─────┤ │') + '    ' + color.bold(brandName),
    color.cyan('  │ ├─────┤ │') + '    ' + color.dim('задачи · файлы · ответы'),
    color.cyan('  ╰─╯     ╰─╯'),
  ].join('\n');
}

/** Печатает логотип только там, где stdout используется человеком, а не протоколом. */
export function showLogo(): void {
  const columns = process.stdout.columns || 80;
  process.stdout.write('\n' + renderLogo(columns, process.env.TERM === 'dumb') + '\n\n');
}
