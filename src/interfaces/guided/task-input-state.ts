import { taskTextLimit } from '../../sessions/drafts.js';

/** Редактор хранит исходные переводы строк; вставка никогда не означает отправку. */
export class TaskInputState {
  text: string;
  cursor: number;
  error = '';
  constructor(initial = '') {
    this.text = initial;
    this.cursor = initial.length;
  }
  insert(value: string): boolean {
    const text = value
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
    if (this.text.length + text.length > taskTextLimit) {
      this.error = 'Не больше 100 000 символов. Вставка не добавлена.';
      return false;
    }
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
    this.error = '';
    return true;
  }
  move(delta: -1 | 1): void {
    const edges = [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(this.text),
    ].map((item) => item.index);
    edges.push(this.text.length);
    this.cursor =
      delta < 0
        ? (edges.filter((index) => index < this.cursor).at(-1) ?? 0)
        : (edges.find((index) => index > this.cursor) ?? this.text.length);
  }
  erase(backward: boolean): void {
    const previous = this.cursor;
    this.move(backward ? -1 : 1);
    const start = Math.min(previous, this.cursor),
      end = Math.max(previous, this.cursor);
    this.text = this.text.slice(0, start) + this.text.slice(end);
    this.cursor = start;
    this.error = '';
  }
  edge(end: boolean): void {
    if (!end && this.cursor === 0) return;
    this.cursor = end
      ? this.text.indexOf('\n', this.cursor)
      : this.text.lastIndexOf('\n', this.cursor - 1) + 1;
    if (this.cursor < 0) this.cursor = this.text.length;
  }
  vertical(delta: -1 | 1): void {
    const start = this.cursor ? this.text.lastIndexOf('\n', this.cursor - 1) + 1 : 0;
    const column = this.cursor - start;
    const targetStart =
      delta < 0
        ? start > 0
          ? this.text.lastIndexOf('\n', start - 2) + 1
          : -1
        : this.text.indexOf('\n', this.cursor) + 1;
    if (targetStart < 0 || (delta > 0 && targetStart === 0)) return;
    const end = this.text.indexOf('\n', targetStart);
    this.cursor = Math.min(targetStart + column, end < 0 ? this.text.length : end);
    const segment = [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(this.text),
    ].find((item) => item.index < this.cursor && item.index + item.segment.length > this.cursor);
    if (segment) this.cursor = segment.index;
  }
}

/** Маркеры вставки могут приходить частями; управляющие клавиши внутри блока не обрабатываются. */
export class PasteDecoder {
  private buffer = '';
  private pasted = '';
  private pasting = false;
  private previousCR = false;
  constructor(
    private readonly keys: (text: string) => void,
    private readonly insert: (text: string) => void,
  ) {}
  write(text: string): void {
    this.buffer += text;
    const start = '\u001b[200~',
      end = '\u001b[201~';
    while (this.buffer) {
      const marker = this.pasting ? end : start;
      const at = this.buffer.indexOf(marker);
      if (at >= 0) {
        const before = this.buffer.slice(0, at);
        if (this.pasting) {
          this.insert(this.pasted + before);
          this.pasted = '';
        } else if (before) this.plain(before);
        this.pasting = !this.pasting;
        this.buffer = this.buffer.slice(at + marker.length);
        continue;
      }
      let keep = Math.min(marker.length - 1, this.buffer.length);
      while (keep && !marker.startsWith(this.buffer.slice(-keep))) keep--;
      const ready = this.buffer.slice(0, this.buffer.length - keep);
      if (this.pasting) this.pasted += ready;
      else if (ready) this.plain(ready);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      break;
    }
  }
  /** Отдельный Esc отличается от начала вставки после короткого ожидания продолжения. */
  flushEscape(): void {
    if (!this.pasting && this.buffer) {
      this.keys(this.buffer);
      this.buffer = '';
    }
  }
  private plain(text: string): void {
    const value = this.previousCR && text.startsWith('\n') ? text.slice(1) : text;
    this.previousCR = text.endsWith('\r');
    if (value) this.keys(value.replace(/\r\n/g, '\n'));
  }
}
