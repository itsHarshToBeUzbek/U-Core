// ==========================================
// app-sheet.js — акт приёма-передачи (АПП)
// ==========================================
// Лист, по которому водитель забирает заказы с ПВЗ. Его подписывают трое:
// администратор, водитель и сотрудник склада, — и каждый расписывается за
// то, что пересчитал строки. Поэтому строки нумерованы, а «Целостность
// заказов нарушена при доставки» стоит ДВАЖДЫ: левый столбец заполняет
// водитель при приёмке, правый — администратор, который лист и печатает.
//
// Расширение заполняет ТОЛЬКО правый. Левый остаётся пустым всегда: его
// пишут на месте, ручкой, и напечатанное там «не вскрыта» было бы подписью
// водителя, которую он не ставил.
//
// Геометрия снята парсером из образца (АПП Заказы на диагностику.pdf) и
// стоит здесь числами, а не формулами: в образце шаг строк гуляет от 16.0
// до 16.5 пункта, и любой «ровный» шаг уводит сетку на полстроки к десятому
// заказу. Толщина линий тоже из образца — рамка таблицы 2.16, всё остальное
// 0.48; на глаз это разные линии, и если сделать их одинаковыми, лист сразу
// читается как чужой.
//
// Шрифт — Calibri: образец набран им, и он стоит в каждой Windows с Office.
// Запасной Carlito метрически совместим, так что на Linux лист не поедет.
//
// ДЕСЯТЬ СТРОК НА ЛИСТ — не ограничение вёрстки, а сам бланк: в нём ровно
// десять пронумерованных строк. Одиннадцатый заказ уходит на второй лист,
// и тогда в шапке появляется «Стр. 2 из 2», а номер акта — «№___2____».

const PAGE_W = 595.32;
const PAGE_H = 841.92;
export const ROWS_PER_SHEET = 10;

/** Четыре вида АПП. Столбцы у всех одинаковые — меняется только заголовок. */
export const APP_TYPES = Object.freeze({
  diagnostic: { n: 1, title: 'Передача заказов на диагностику' },
  duplicate: { n: 2, title: 'Передача дублированных заказов' },
  tpl: { n: 3, title: '3PL заказы: Банковские карты, Aliexpress, Uzum Global' },
  canceled: { n: 4, title: 'Передача ранее отмененных заказов' }
});

export const APP_DEFAULTS = Object.freeze({
  type: 'diagnostic', admin: '', tabel: '', date: '', pvz: 'ТАШ-120', copies: 1
});

// ---------- линейки: [x, y, ширина, высота] закрашенных прямоугольников ----------
// Тонкие штрихи на лазернике при печати пропадают, залитые прямоугольники —
// нет. Поэтому вся сетка нарисована заливкой, как в образце.

const HEAD_RULES = Object.freeze([
  [35.16, 56.64, 536.40, 0.48], [229.85, 84.02, 341.71, 0.48], [35.16, 98.06, 536.40, 0.48],
  [229.85, 113.66, 341.71, 0.48], [35.16, 127.58, 536.40, 0.48],
  [35.16, 57.12, 0.48, 70.46], [229.85, 57.12, 0.48, 70.46],
  [361.39, 57.12, 0.48, 70.46], [571.08, 57.12, 0.48, 70.46]
]);

const TABLE_RULES = Object.freeze([
  [34.32, 186.14, 540.96, 2.16],                                   // верх рамки
  [90.14, 235.82, 362.47, 2.16], [454.78, 235.82, 118.34, 2.16],   // низ «Заполняет …»
  [36.48, 288.17, 51.50, 2.16], [90.14, 288.17, 482.98, 2.16],     // низ шапки таблицы
  [34.32, 306.29, 540.96, 0.48], [34.32, 322.61, 540.96, 0.48],
  [34.32, 338.93, 540.96, 0.48], [34.32, 355.37, 540.96, 0.48],
  [34.32, 371.69, 540.96, 0.48], [34.32, 388.01, 540.96, 0.48],
  [34.32, 404.33, 540.96, 0.48], [34.32, 420.79, 540.96, 0.48],
  [34.32, 437.11, 540.96, 0.48], [34.32, 453.43, 540.96, 0.48],
  [34.32, 186.14, 2.16, 267.29], [87.98, 188.42, 2.16, 265.01],
  [212.45, 188.42, 0.48, 265.01], [347.11, 188.42, 0.48, 265.01],
  [452.62, 188.42, 2.16, 99.75], [453.46, 288.17, 0.48, 165.26],
  [573.12, 186.14, 2.16, 267.29]
]);

const FOOT_RULES = Object.freeze([
  [34.32, 517.39, 539.28, 0.48], [34.32, 534.67, 539.28, 0.48],
  [34.32, 552.07, 539.28, 0.48], [34.32, 569.47, 539.28, 0.48], [34.32, 586.78, 539.28, 0.48],
  [34.32, 517.63, 0.48, 69.39], [133.58, 517.63, 0.48, 69.39],
  [332.11, 517.63, 0.48, 69.39], [452.62, 517.63, 0.48, 69.39], [573.12, 517.63, 0.48, 69.39]
]);

// ---------- неизменные подписи: [x, базовая линия, кегль, жирный, текст] ----------
// Базовые линии восстановлены из образца точно: pdfminer отдаёт низ строки,
// а Calibri в дескрипторе объявляет Descent −250, то есть базовая линия
// ровно на 0.25 кегля выше низа. Раскладывать эти подписи «по центру
// ячейки» нельзя — в образце они стоят не по центру.
const STATIC = Object.freeze([
  [65.78, 73.80, 14.04, 1, 'Акт приема-передачи'],
  [244.13, 67.68, 11.04, 0, 'ФИО Администратора'],
  [286.73, 81.02, 11.04, 0, 'ПВЗ'],
  [253.37, 95.06, 11.04, 0, 'Табельный номер'],
  [284.81, 109.82, 11.04, 0, 'Дата'],
  [286.73, 124.58, 11.04, 0, 'ПВЗ'],
  [100.34, 215.18, 9.00, 0, 'Заполняет администратор'],
  [229.49, 215.18, 9.00, 0, 'Заполняет администратор'],
  [361.75, 215.18, 9.00, 0, 'Заполняет водитель'],
  [463.42, 215.18, 9.00, 0, 'Заполняет администратор'],
  [56.54, 241.94, 11.04, 0, '№'],
  [118.70, 266.81, 11.04, 0, 'Номер заказа'],
  [223.97, 266.81, 11.04, 0, 'ШК товара (если видно)'],
  [356.35, 248.33, 9.96, 0, 'Целостность заказов'],
  [370.27, 260.45, 9.96, 0, 'нарушена при'],
  [354.43, 272.69, 9.96, 0, 'доставки (вскрыта/не'],
  [381.79, 284.93, 9.96, 0, 'вскрыта)'],
  [469.78, 254.33, 9.96, 0, 'Целостность заказов'],
  [463.30, 266.57, 9.96, 0, 'нарушена при доставки'],
  [468.46, 278.81, 9.96, 0, '(вскрыта/не вскрыта)'],
  [222.05, 529.99, 11.04, 0, 'ФИО'],
  [381.67, 529.99, 11.04, 0, 'Дата'],
  [492.82, 529.99, 11.04, 0, 'Подпись'],
  [57.98, 547.39, 11.04, 0, 'Админ ПВЗ'],
  [61.94, 564.67, 11.04, 0, 'Водитель'],
  [42.00, 582.10, 11.04, 0, 'Сотрудник склада']
]);

// Базовые линии строк таблицы и номера в первом столбце — тоже из образца.
const ROW_BASE = Object.freeze([302.09, 318.41, 334.73, 351.05, 367.49,
                                383.81, 400.13, 416.47, 432.91, 449.23]);
const ROW_NUM_X = Object.freeze([59.42, 59.42, 59.42, 59.42, 59.42,
                                 59.42, 59.42, 59.42, 59.42, 56.54]);

// Центры столбцов, куда попадают введённые значения.
const COL_ORDER = (89.06 + 212.69) / 2;
const COL_BARCODE = (212.69 + 347.35) / 2;
// Правый столбец «Целостность заказов…» — тот, что подписан «Заполняет
// администратор». Соседний, слева от него, подписан «Заполняет водитель»:
// туда расширение не пишет ничего и никогда.
const COL_INTEGRITY = (453.70 + 574.20) / 2;
export const INTEGRITY_OK = 'не вскрыта';
export const INTEGRITY_OPEN = 'вскрыта';
const COL_VALUE_X = (361.63 + 571.32) / 2;      // правый столбец шапки
const VALUE_BASE = Object.freeze([74.40, 95.06, 109.82, 124.58]);
const FOOT_NAME_X = (133.82 + 332.35) / 2;
const FOOT_DATE_X = (332.35 + 452.86) / 2;

const TITLE_SIZE = 20.04;
const TITLE_BASE = 170.90;
const TITLE_NUM_X = 49.68;
const TITLE_X = 67.70;
const TITLE_RIGHT = 574.20;

const CELL_SIZE = 11.04;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** ДД.ММ.ГГГГ из значения <input type="date">. */
export function formatAppDate(value) {
  if (!value) return '';
  const p = String(value).split('-');
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : String(value);
}

/** Чего не хватает, чтобы печатать. Пустой акт водитель не примет. */
export function appMissing(data) {
  const need = [['admin', 'ФИО Администратора ПВЗ'], ['tabel', 'Табельный номер'],
                ['date', 'Дата'], ['pvz', 'ПВЗ']];
  const out = need.filter(([k]) => !String(data[k] || '').trim()).map(([, l]) => l);
  if (!(data.items || []).filter(i => String(i.order || '').trim()).length) out.push('Номера заказов');
  return out;
}

// ---------- примитивы ----------

const rule = ([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"/>`;

function txt(x, y, size, text, { bold = false, anchor = 'start' } = {}) {
  const s = String(text == null ? '' : text);
  if (!s) return '';
  return `<text x="${x}" y="${y}" font-size="${size}"`
       + `${bold ? ' font-weight="700"' : ''}`
       + `${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}>${esc(s)}</text>`;
}

// Ширина текста — настоящим измерением, а не «примерно по символам»: длинное
// название товара или штрихкод обязаны ужаться, а не вылезти за рамку.
let measurer = null;
function measure(text, size, bold) {
  if (!text) return 0;
  if (measurer === null) {
    try { measurer = document.createElement('canvas').getContext('2d'); }
    catch { measurer = false; }
  }
  if (!measurer) return String(text).length * size * 0.48;   // без DOM — грубая оценка
  measurer.font = `${bold ? '700 ' : ''}${size}pt Calibri, Carlito, sans-serif`;
  return measurer.measureText(String(text)).width * 0.75;    // px -> pt
}

/** Значение по центру столбца; если не влезает — кегль ужимается до 70 %. */
function fitted(cx, baseline, room, text, { bold = false, size = CELL_SIZE } = {}) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '';
  let use = size;
  while (use > size * 0.7 && measure(s, use, bold) > room) use -= 0.24;
  return txt(cx, baseline, Math.round(use * 100) / 100, s, { bold, anchor: 'middle' });
}

// ---------- лист ----------

function sheetSvg(data, rows, part) {
  const tpl = APP_TYPES[data.type] || APP_TYPES.diagnostic;
  const out = [];

  for (const r of HEAD_RULES) out.push(rule(r));
  for (const r of TABLE_RULES) out.push(rule(r));
  for (const r of FOOT_RULES) out.push(rule(r));

  for (const [x, y, size, bold, text] of STATIC) out.push(txt(x, y, size, text, { bold: !!bold }));

  // Номер акта. В чистом бланке это восемь прочерков; когда заказов больше
  // десяти, акт делится, и во втором листе стоит его собственный номер —
  // «№___2____», ровно те же восемь знакомест.
  const actNo = part.total > 1
    ? `№___${part.index}____`
    : '№________';
  out.push(txt(97.46, 90.98, 14.04, actNo, { bold: true }));
  out.push(txt(108.74, 116.78, CELL_SIZE, `Стр. ${part.index} из ${part.total}`));

  // Заголовок раздела: номер отдельно от названия — как в образце.
  out.push(txt(TITLE_NUM_X, TITLE_BASE, TITLE_SIZE, `${tpl.n}.`, { bold: true }));
  let titleSize = TITLE_SIZE;
  const titleRoom = TITLE_RIGHT - TITLE_X;
  while (titleSize > TITLE_SIZE * 0.6 && measure(tpl.title, titleSize, true) > titleRoom) {
    titleSize -= 0.3;
  }
  out.push(txt(TITLE_X, TITLE_BASE, Math.round(titleSize * 100) / 100, tpl.title, { bold: true }));

  // Реквизиты в правом столбце шапки.
  const head = [data.admin, data.tabel, formatAppDate(data.date), data.pvz];
  head.forEach((value, i) => {
    out.push(fitted(COL_VALUE_X, VALUE_BASE[i], 571.32 - 361.63 - 8, value));
  });

  // Строки заказов. Номера 1…10 стоят в бланке всегда — и в пустых строках
  // тоже: по ним считают, сколько заказов уехало.
  for (let i = 0; i < ROWS_PER_SHEET; i++) {
    const row = rows[i] || {};
    const filled = !!(row.order || row.barcode);
    out.push(txt(ROW_NUM_X[i], ROW_BASE[i], CELL_SIZE, String(i + 1)));
    out.push(fitted(COL_ORDER, ROW_BASE[i], 212.69 - 89.06 - 6, row.order));
    out.push(fitted(COL_BARCODE, ROW_BASE[i], 347.35 - 212.69 - 6, row.barcode));
    // Целостность — только в столбце администратора и только у строк, где
    // заказ есть: в пустой строке «не вскрыта» означало бы, что кто-то
    // осмотрел несуществующую коробку.
    if (filled) {
      out.push(fitted(COL_INTEGRITY, ROW_BASE[i], 574.20 - 453.70 - 6,
        row.opened ? INTEGRITY_OPEN : INTEGRITY_OK));
    }
    // Столбец водителя НЕ заполняем: его пишут на месте, при приёмке.
    // Печатать туда что-либо — расписываться за водителя.
  }

  // Подписи. Заполняем только строку администратора: водитель и сотрудник
  // склада расписываются сами, и подставлять их данные нельзя.
  out.push(fitted(FOOT_NAME_X, 547.39, 332.35 - 133.82 - 14, data.admin));
  out.push(fitted(FOOT_DATE_X, 547.39, 452.86 - 332.35 - 8, formatAppDate(data.date)));

  return `<section class="sheet app-sheet" data-part="${part.index}">`
       + `<svg class="page" xmlns="http://www.w3.org/2000/svg" `
       + `viewBox="0 0 ${PAGE_W} ${PAGE_H}" width="210mm" height="297mm" xml:space="preserve">`
       + `${out.join('')}</svg></section>`;
}

/** Все листы: по десять строк на лист, с «Стр. N из M» в шапке. */
export function buildAppSheets(data) {
  const items = (data.items || [])
    .map(i => ({
      order: String(i.order || '').trim(),
      barcode: String(i.barcode || '').trim(),
      opened: i.opened === true || i.opened === INTEGRITY_OPEN
    }))
    .filter(i => i.order || i.barcode);
  const total = Math.max(1, Math.ceil(items.length / ROWS_PER_SHEET));
  const out = [];
  for (let p = 0; p < total; p++) {
    const rows = items.slice(p * ROWS_PER_SHEET, (p + 1) * ROWS_PER_SHEET);
    out.push(sheetSvg(data, rows, { index: p + 1, total }));
  }
  const copies = Math.max(1, Math.min(20, Number(data.copies) || 1));
  const one = out.join('\n');
  return { html: Array.from({ length: copies }, () => one).join('\n'), parts: total, copies };
}

export const APP_CSS = `
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
/* Кернинг ВЫКЛЮЧЕН намеренно: Word набирает этот бланк без него, и с
   кернингом строки съезжают. Проверено сравнением с образцом попиксельно —
   99.5 % чернил в пределах одного пикселя при 300 dpi против 98.1 %.
   geometricPrecision убирает округление ширины каждой буквы до целого
   пикселя принтера: без него к концу длинной строки набегает до пункта. */
.sheet text {
  font-family: Calibri, 'Carlito', 'Segoe UI', Arial, sans-serif;
  fill: #000; white-space: pre;
  font-kerning: none;
  text-rendering: geometricPrecision;
}

@media screen {
  body { background: #eceff3; }
  .sheet { margin: 0 auto 8mm; box-shadow: 0 2px 12px rgba(0, 0, 0, .15); }
}
@media print {
  .sheet { box-shadow: none; margin: 0; }
}
`;
