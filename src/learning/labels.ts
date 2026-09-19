/** Показывает смысл начальной версии вместо внутреннего имени хранилища. */
export function learningVersionLabel(version: string): string {
  return version === 'baseline' ? 'Без накопленного опыта' : 'Выпуск ' + version.slice(0, 8);
}
