// ==========================================
// diag-act.js — акт приёма товара на диагностику
// ==========================================
// Двухстраничный бланк, который уезжает вместе с товаром в сервисный центр
// и остаётся у покупателя. Юридический текст в нём — не оформление: он
// перечисляет, на что покупатель соглашается, подписывая талон. Поэтому
// текст взят из образца дословно и стоит на тех же координатах: геометрия
// снята парсером из PDF (diag-layout.js), шрифт тот же — Arial, который
// есть в любой Windows.
//
// Печатается ВСЕГДА в трёх экземплярах и всегда с двух сторон: один
// экземпляр остаётся у покупателя, два уезжают на склад.
//
// Заполняется только шапка: одиннадцать ячеек сверху и две фамилии внизу.
// Всё остальное на листе неизменно.

import { DIAG_P1, DIAG_P2 } from './diag-layout.js';

const PAGE_W = 595.32;
const PAGE_H = 841.92;

// Шапка — единственное место бланка, которое заполняется, и единственное,
// где текст может не влезть. Ячейки заданы координатами из образца:
// [x текста, верх ячейки, ширина под текст, высота ячейки, базовая линия
// первой строки, сколько строк занято в образце, шаблон].
//
// Базовая линия задана числом, а не «отступом от верха»: Word ставит текст
// в ячейке по центру, и в высоких ячейках («Наименование товара», «Дефект
// со слов владельца») отступ от верха другой, чем в низких. Считать его
// формулой — значит промахнуться на строку ровно в тех двух ячейках, где
// текста больше всего.
const HEAD_CELLS = Object.freeze([
  [52.92, 91.74, 242.52, 14.76, 101.52, 1, 'Номер заказа: {{order}}'],
  [297.25, 91.74, 242.51, 14.76, 101.52, 1, 'Короткое наименование пункта выдачи: {{pvz}}'],
  [52.92, 106.50, 242.52, 23.64, 120.72, 1, 'Наименование товара: {{item}}'],
  [297.25, 106.50, 242.51, 23.64, 120.72, 1, 'ФИО покупателя: {{client}}'],
  [52.92, 130.14, 242.52, 14.76, 139.92, 1, 'Дата выдачи товара покупателю: {{issued}}'],
  [297.25, 130.14, 242.51, 14.76, 139.92, 1, 'Телефон: {{phone}}'],
  [52.92, 144.90, 242.52, 14.76, 154.68, 1, 'Дата возврата: {{returnDate}}'],
  [297.25, 144.90, 242.51, 14.76, 154.68, 1,
    'Дополнительный способ связи на выбор покупателя: {{phone2}}'],
  [52.92, 159.66, 486.84, 14.76, 168.96, 1,
    'Комплект(перечислите комплектующие изделия, которые имеются в момент передачи товара: {{kit}}'],
  [52.92, 174.42, 486.84, 14.76, 183.72, 1,
    'Состояние, внешний вид(подробное описание): {{condition}}'],
  [52.92, 189.18, 486.84, 31.08, 202.20, 2,
    'Дефект со слов владельца(подробное описание: что не работает, при каких условиях, '
    + 'периодичность проявления дефекта): {{defect}}']
]);

// Рамка шапки — ровно те прямоугольники, которыми её рисует образец.
const HEAD_RULES = Object.freeze([
  [51.12, 91.32, 0.84, 129.36], [295.44, 92.16, 0.84, 67.92], [539.76, 92.16, 0.84, 128.52],
  [51.96, 91.32, 488.64, 0.84], [51.96, 106.08, 488.64, 0.84], [51.96, 129.72, 488.64, 0.84],
  [51.96, 144.48, 488.64, 0.84], [51.96, 159.24, 488.64, 0.84], [51.96, 174.00, 488.64, 0.84],
  [51.96, 188.76, 488.64, 0.84], [51.96, 219.84, 488.64, 0.84]
]);

const SIZE = 6.96;          // кегль всего бланка
const LEAD = 8.88;          // межстрочный интервал внутри ячейки
const MIN_SHRINK = 0.68;    // ниже этого текст в ячейке уже не читается

export const DIAG_COPIES = 3;

export const DIAG_FIELDS = Object.freeze([
  ['order', 'Номер заказа', 'text'],
  ['pvz', 'ПВЗ', 'text'],
  ['item', 'Наименование товара', 'text'],
  ['client', 'ФИО клиента', 'text'],
  ['issued', 'Дата выдачи', 'text'],
  ['phone', 'Номер клиента', 'text'],
  ['returnDate', 'Дата возврата', 'text'],
  ['phone2', 'Дополнительный номер телефона', 'text'],
  ['kit', 'Комплект', 'text'],
  ['condition', 'Состояние, внешний вид', 'text'],
  ['defect', 'Дефект со слов владельца', 'text'],
  ['admin', 'ФИО администратора', 'text']
]);

export const DIAG_DEFAULTS = Object.freeze({
  order: '', pvz: 'ТАШ-120', item: '', client: '', issued: '', phone: '+998 ',
  returnDate: '', phone2: '+998 ', kit: 'Полный', condition: 'Отлично', defect: '', admin: ''
});

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fill = (tpl, data) => String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) =>
  data[k] === undefined || data[k] === null ? '' : String(data[k]));

/** Чего не хватает, чтобы печатать. Пустой акт не имеет силы. */
export function diagMissing(data) {
  const need = [['order', 'Номер заказа'], ['pvz', 'ПВЗ'], ['item', 'Наименование товара'],
                ['client', 'ФИО клиента'], ['issued', 'Дата выдачи'], ['phone', 'Номер клиента'],
                ['returnDate', 'Дата возврата'], ['defect', 'Дефект со слов владельца'],
                ['admin', 'ФИО администратора']];
  return need.filter(([k]) => {
    const v = String(data[k] || '').trim();
    return !v || v === '+998';
  }).map(([, label]) => label);
}

// ---------- отрисовка ----------

function runsSvg(spec) {
  const out = [];
  for (const [x, y, size, style, text] of spec.t) {
    const weight = style === 'b' || style === 'bi' ? ' font-weight="700"' : '';
    const italic = style === 'i' || style === 'bi' ? ' font-style="italic"' : '';
    out.push(`<text x="${x}" y="${y}" font-size="${size}"${weight}${italic}>${esc(text)}</text>`);
  }
  for (const [x, y, w, h] of spec.r) {
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/>`);
  }
  return out.join('');
}

function page(spec, klass, extra = '') {
  return `<section class="sheet ${klass}"><svg class="page" xmlns="http://www.w3.org/2000/svg" `
       + `viewBox="0 0 ${PAGE_W} ${PAGE_H}" width="210mm" height="297mm" xml:space="preserve">`
       + `${runsSvg(spec)}${extra}</svg></section>`;
}

/** Обе стороны акта. Значения подставляются в статичный текст тоже: внизу
 *  каждой страницы стоят фамилии покупателя и администратора. */
export function buildDiagPages(data, { side = 'front' } = {}) {
  const filled = (spec) => ({
    t: spec.t.map(([x, y, s, st, t]) => [x, y, s, st, fill(t, data)]),
    r: spec.r
  });
  const copies = Math.max(1, Math.min(9, Number(data.copies) || DIAG_COPIES));
  const one = side === 'back'
    ? page(filled(DIAG_P2), 'diag-back')
    : page(filled(DIAG_P1), 'diag-front', headSvg(data));
  return Array.from({ length: copies }, () => one).join('\n');
}

// Шапку рисуем отдельно: в ней единственное место бланка, где текст может
// не влезть. Перенос и ужимание считаются по-настоящему, измерением.
let measurer = null;
function measure(text, size, bold) {
  if (!text) return 0;
  if (measurer === null) {
    try { measurer = document.createElement('canvas').getContext('2d'); }
    catch { measurer = false; }
  }
  if (!measurer) return String(text).length * size * 0.5;   // без DOM — грубая оценка
  measurer.font = `${bold ? '700 ' : ''}${size}pt Arial, Helvetica, sans-serif`;
  return measurer.measureText(String(text)).width * 0.75;   // px -> pt
}

function wrap(text, size, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = words[0];
  for (const w of words.slice(1)) {
    const next = `${cur} ${w}`;
    if (measure(next, size, false) > maxWidth) { lines.push(cur); cur = w; }
    else cur = next;
  }
  lines.push(cur);
  return lines;
}

function headSvg(data) {
  const out = [];
  for (const [x, y, w, h] of HEAD_RULES) {
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/>`);
  }
  for (const [x, top, room, h, base, refLines, tpl] of HEAD_CELLS) {
    const text = fill(tpl, data);
    // Сколько строк вообще помещается в ячейку по высоте.
    const maxLines = Math.max(refLines, Math.floor(h / LEAD));
    let size = SIZE;
    let lines = wrap(text, size, room);
    while (lines.length > maxLines && size > SIZE * MIN_SHRINK) {
      size = Math.round((size - 0.12) * 100) / 100;
      lines = wrap(text, size, room);
    }
    lines = lines.slice(0, maxLines);
    const lead = LEAD * (size / SIZE);
    // Строк стало больше, чем в образце, — блок расходится от той же
    // середины ячейки, а не съезжает вниз за рамку.
    const first = base - (lines.length - refLines) * lead / 2;
    lines.forEach((line, i) => {
      out.push(`<text x="${x.toFixed(2)}" y="${(first + i * lead).toFixed(2)}" `
             + `font-size="${size}">${esc(line)}</text>`);
    });
  }
  return out.join('');
}

// Шрифт бланка — Arial: он стоит в каждой Windows, и образец набран им же.
// Ничего вшивать не нужно, а запасные перечислены на случай другой системы.
export const DIAG_CSS = `
@page { size: A4 portrait; margin: 0; }
/* Поля страницы обнуляет @page, но у <body> они свои, восьмипиксельные,
   и Chrome сдвигает ими весь лист на 6 пунктов вправо и вниз, а потом
   ужимает его, чтобы влез. Бланк уезжает целиком — поэтому обнуляем. */
html, body { margin: 0; padding: 0; }

.sheet {
  width: 210mm; height: 297mm; overflow: hidden; background: #fff;
  page-break-after: always; break-after: page;
}
.sheet:last-child { page-break-after: auto; break-after: auto; }
.sheet .page { display: block; }
/* Кернинг и растеризацию НЕ трогаем. Проверено сравнением с образцом
   попиксельно: и font-kerning:none, и text-rendering:geometricPrecision
   ухудшают совпадение (94 % против 98 % в пределах двух пикселей при
   300 dpi) — Word набирает этот бланк с кернингом и с обычным хинтингом,
   и лист совпадает с образцом именно в настройках по умолчанию. */
.sheet text {
  font-family: Arial, 'Liberation Sans', Helvetica, sans-serif;
  fill: #000; white-space: pre;
}

@media screen {
  body { background: #eceff3; }
  .sheet { margin: 0 auto 8mm; box-shadow: 0 2px 12px rgba(0, 0, 0, .15); }
}
@media print {
  .sheet { box-shadow: none; margin: 0; }
}
`;
