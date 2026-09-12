// ==========================================
// encash-act.js — бланк инкассации «Далолатнома»
// ==========================================
// Бланк не «похож» на тот, что печатает WMS, — это он и есть. Геометрия
// (act-layout.js) снята парсером из PDF, который WMS отдал 09.09.2026:
// каждая строка стоит на своей базовой линии с точностью до сотой пункта,
// каждая линейка — там же, где её рисует WMS, и шрифт тот же самый —
// Inter, вынутый из того же PDF (см. ACT_FONT).
//
// Почему не «свёрстано красиво»: бланк уходит в банк, инкассатор сверяет
// его глазами с сотнями таких же. Любое расхождение — повод переспросить,
// а переспрашивают уже на кассе, когда мешок опечатан.
//
// Своя печать нужна ещё и потому, что у бланка из WMS оператор каждый раз
// выставлял масштаб 70%, выбирал нечётные страницы, печатал, перекладывал
// стопку руками (лазерный выдаёт листы лицом вверх) и только потом печатал
// обороты. Здесь лист свёрстан в натуральную величину, а порядок страниц
// расширение считает само.

import { ACT_LOGO, ACT_FONT, ACT_ADV, ACT_COPY12, ACT_COPY3, ACT_TABLE, ACT_CLIENT }
  from './act-layout.js';

// Метрики Inter (из FontDescriptor того же PDF): ascent 968/1000, descent 241/1000.
// Из них — где внутри строки с line-height:1 лежит базовая линия.
const ASCENT = 0.96875;
const DESCENT = 0.2414773;
const LINE = ASCENT + DESCENT;          // 1.2102 em — «нормальный» интерлиньяж
const BASE = ASCENT - (LINE - 1) / 2;   // 0.86364 em — от верха строки до базовой

// Номиналы в том же порядке, в каком они стоят в бланке.
const DENOMS = [1, 3, 5, 10, 25, 100, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
                'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// Ячейка «Сана»: текст начинается с 155, правый край — 260. Перенос WMS
// делает по этой ширине, и только сентябрь в неё не влезает.
const DATE = { x: 155, cont: 150, width: 105, size: 12, center: 106.265 };

export const ACT_DEFAULTS = Object.freeze({
  // Ровно те строки, что печатает WMS, вплоть до латинских O в «OOO»
  // и латинского ATB: бланк сверяют посимвольно.
  sender: 'ИП OOO "UZUM MARKET"',
  receiver: 'ATB "KAPITALBANK"',
  account: '20208000105504983002',
  bankName: 'ATB "KAPITALBANK"',
  mfo: '00974',
  // Фамилию НЕ берём из образца: в банке её сверяют, и чужая фамилия в акте
  // хуже пустой строки. Расширение читает её из левого нижнего угла WMS
  // (см. content.js) — там она стоит ровно в том виде, в каком нужна бланку.
  chief: '',
  copies: 3
});

// Значения из старых версий: тогда бланк был «похожий», а не тот же самый,
// и реквизиты были записаны кириллицей. Молча подменяем — руками их никто
// не менял, это была наша ошибка, а не выбор оператора.
const LEGACY = Object.freeze({
  sender: 'ИП ООО "UZUM MARKET"',
  receiver: 'АТВ "KAPITALBANK"',
  bankName: 'АТВ "KAPITALBANK"'
});

// Фамилии из образцов WMS: они попали в настройки как «значение по умолчанию»,
// хотя принадлежат другим ПВЗ. Их подменяем именем из WMS молча — своё имя
// никто из операторов туда не вписывал.
const SAMPLE_CHIEFS = Object.freeze(['ERGASHEV N.', 'OLIMBOYEV S.']);

/**
 * Подтягивает реквизиты, сохранённые до перехода на точный бланк.
 * `wmsName` — фамилия, прочитанная из WMS; она перебивает и пустое поле,
 * и оставшуюся от образца чужую фамилию, но не то, что оператор вписал сам.
 */
export function migrateActConstants(saved, wmsName) {
  const out = { ...ACT_DEFAULTS, ...(saved || {}) };
  for (const key of ['sender', 'receiver', 'bankName']) {
    if (out[key] === LEGACY[key]) out[key] = ACT_DEFAULTS[key];
  }
  const name = String(wmsName || '').trim();
  if (name && (!String(out.chief || '').trim() || SAMPLE_CHIEFS.includes(out.chief))) {
    out.chief = name;
  }
  return out;
}

// ---------- сумма прописью ----------
// В бланке она стоит отдельной строкой и заверяется подписью, поэтому
// ошибка здесь дороже любой другой: банк сверяет цифру со словами.

const ONES = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
              'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
              'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const ONES_F = ['', 'одна', 'две'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят',
              'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот',
                  'семьсот', 'восемьсот', 'девятьсот'];

/** Форма слова по числу: 1 тысяча, 2 тысячи, 5 тысяч. */
function plural(n, one, few, many) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function tripletToWords(n, feminine) {
  const words = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) words.push(HUNDREDS[h]);
  if (rest < 20) {
    if (rest) words.push(feminine && rest < 3 ? ONES_F[rest] : ONES[rest]);
  } else {
    words.push(TENS[Math.floor(rest / 10)]);
    const unit = rest % 10;
    if (unit) words.push(feminine && unit < 3 ? ONES_F[unit] : ONES[unit]);
  }
  return words;
}

export function numberToWordsRu(value) {
  const n = Math.floor(Math.abs(Number(value) || 0));
  if (!n) return 'Ноль';

  const groups = [
    { div: 1e9, fem: false, forms: ['миллиард', 'миллиарда', 'миллиардов'] },
    { div: 1e6, fem: false, forms: ['миллион', 'миллиона', 'миллионов'] },
    { div: 1e3, fem: true, forms: ['тысяча', 'тысячи', 'тысяч'] },
    { div: 1, fem: false, forms: null }
  ];

  const out = [];
  let rest = n;
  for (const g of groups) {
    const part = Math.floor(rest / g.div);
    rest -= part * g.div;
    if (!part) continue;
    out.push(...tripletToWords(part, g.fem));
    if (g.forms) out.push(plural(part, g.forms[0], g.forms[1], g.forms[2]));
  }

  const text = out.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------- мелочи форматирования ----------

const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
};

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Ширина строки в пунктах по метрикам Inter — тем же, что у WMS. */
function textWidth(text, size) {
  let sum = 0;
  for (const ch of String(text)) sum += (ACT_ADV[ch] !== undefined ? ACT_ADV[ch] : 0.55);
  return sum * size;
}

export function formatActDate(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Разбивает дату так же, как её разбивает WMS: по ширине ячейки, а не по
 * «красиво». Сентябрь не влезает в 105pt и уезжает годом на вторую строку —
 * октябрь влезает и остаётся одной. Повторяем ровно это.
 */
function dateLines(text) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textWidth(next, DATE.size) > DATE.width) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------- отрисовка ----------
// Лист рисуется как SVG, и это не украшательство. В SVG координата текста —
// это его базовая линия, ровно то, что снято из PDF. В HTML пришлось бы
// пересчитывать базовую линию в top через метрики шрифта, а Chrome округляет
// их до целых пикселей по-разному для 8, 9 и 12 пунктов — и строки разъезжались
// на пункт-полтора. Здесь пересчёта нет вовсе.

const PAGE_W = 595.28;   // A4 в пунктах
const PAGE_H = 841.89;

function textNode(x, baseline, size, bold, text, align) {
  let anchor = '';
  let px = x;
  if (align && align[0] === 'c') { anchor = ' text-anchor="middle"'; px = align[1]; }
  else if (align && align[0] === 'r') { anchor = ' text-anchor="end"'; px = align[1]; }
  // «Жирное» WMS делает обводкой 0.3pt по контуру обычного начертания —
  // ширина строки от этого не меняется. Настоящий bold сдвинул бы всё,
  // что выключено вправо и по центру.
  const stroke = bold ? ' stroke="#000" stroke-width="0.3"' : '';
  return `<text x="${px}" y="${baseline}" font-size="${size}"${anchor}${stroke}>`
       + `${esc(text)}</text>`;
}

// ЛИНИЯ ОТРЕЗА. Стопку режут по одной высоте на всех листах, поэтому линия
// стоит на одном и том же месте — чуть ниже нижнего края таблицы купюр
// (та кончается на 601.5) и заведомо ниже всего, что напечатано на лицевой
// стороне. Рисуем её только на оборотах: резать удобно по той стороне,
// которая смотрит вверх в стопке, а на лицевой стороне лишняя черта рядом
// с подписями — повод переспросить.
//
// ПОЧЕМУ ШТРИХИ — ПРЯМОУГОЛЬНИКИ, А НЕ ПУНКТИРНАЯ ОБВОДКА.
// Первый вариант был <line stroke-dasharray>. В файле он есть — Chrome
// разворачивает его в семь десятков залитых путей, — но на бумаге его нет:
// при обводке 0.6pt и масштабе листа 0.7 штрих выходит 0.15 мм, а это
// меньше того, что лазерный принтер уверенно кладёт тонером. Все линейки
// бланка, которые видно, нарисованы залитыми прямоугольниками в 1pt —
// линия отреза теперь такая же.
const CUT_Y = 620;
const CUT_H = 1;        // как у линеек бланка: их видно
const CUT_ON = 8;       // штрих
const CUT_OFF = 5;      // пробел

function cutLine() {
  const x0 = 24, x1 = PAGE_W - 24;
  const parts = [];
  for (let x = x0; x < x1; x += CUT_ON + CUT_OFF) {
    const w = Math.min(CUT_ON, x1 - x);
    if (w < CUT_ON / 2) break;          // огрызок штриха выглядит как грязь
    parts.push(`<rect x="${x.toFixed(2)}" y="${CUT_Y - CUT_H / 2}" `
             + `width="${w.toFixed(2)}" height="${CUT_H}" fill="#000"/>`);
  }
  // Треугольники по краям: без них пунктир читается как часть бланка.
  const mark = (x, dir) => `<path d="M${x} ${CUT_Y - 4} L${x + dir * 6.5} ${CUT_Y} `
                         + `L${x} ${CUT_Y + 4} Z" fill="#000"/>`;
  parts.push(mark(14, 1), mark(PAGE_W - 14, -1));
  // Подпись СТОИТ НИЖЕ ЛИНИИ — вместе с обрезком она уходит в мусор, и в
  // банк попадает лист без единого лишнего слова.
  parts.push(`<text x="${PAGE_W / 2}" y="${CUT_Y + 13}" font-size="7.5" `
           + `text-anchor="middle" fill="#8a8a8a">ЛИНИЯ ОТРЕЗА</text>`);
  return parts.join('');
}

function rules(spec) {
  const out = [];
  for (const [x1, y, x2, black] of spec.h) {
    out.push(`<rect x="${x1}" y="${(y - 0.5).toFixed(2)}" width="${(x2 - x1).toFixed(2)}" `
           + `height="1" fill="${black ? '#000' : '#c9c9c9'}"/>`);
  }
  for (const [x, y1, y2, black] of spec.v) {
    out.push(`<rect x="${(x - 0.5).toFixed(2)}" y="${y1}" width="1" `
           + `height="${(y2 - y1).toFixed(2)}" fill="${black ? '#000' : '#c9c9c9'}"/>`);
  }
  return out.join('');
}

/** Рисует страницу по снятой геометрии, подставляя живые значения. */
function renderPage(spec, values, klass) {
  const parts = [];
  if (spec.img) {
    parts.push(`<image x="${spec.img.x}" y="${spec.img.y}" width="${spec.img.w}" `
             + `height="${spec.img.h}" href="${ACT_LOGO}"/>`);
  }
  parts.push(rules(spec));
  for (const [x, y, size, bold, tpl, align] of spec.t) {
    const key = /^\{\{(\w+)\}\}$/.exec(tpl);
    if (key) {
      const v = values[key[1]];
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v)) { for (const node of v) parts.push(node); continue; }
      parts.push(textNode(x, y, size, bold, v, align));
      continue;
    }
    const text = tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] == null ? '' : values[k]);
    parts.push(textNode(x, y, size, bold, text, align));
  }
  if (klass !== 'act') parts.push(cutLine());
  return `<section class="sheet ${klass}"><svg class="page" xmlns="http://www.w3.org/2000/svg" `
       + `viewBox="0 0 ${PAGE_W} ${PAGE_H}" width="210mm" height="297mm" `
       + `xml:space="preserve" shape-rendering="crispEdges">${parts.join('')}</svg></section>`;
}

/** Значения, которые бланк берёт из кассы, — общие для всех трёх нусха. */
function actValues(data, copyIndex) {
  const c = migrateActConstants(data.constants);
  const lines = dateLines(data.dateText || formatActDate(new Date()));
  const lh = LINE * DATE.size;
  // Блок даты центрируется по строке целиком: одна строка или две — центр один.
  const first = DATE.center - (lines.length * lh) / 2 + BASE * DATE.size;
  const dateNodes = lines.map((line, i) => textNode(
    i === 0 ? DATE.x : DATE.cont, Math.round((first + i * lh) * 100) / 100, DATE.size, 1, line));

  return {
    copy: String(copyIndex),
    date1: dateNodes,          // весь блок даты — один слот, остальные строки внутри
    date2: '',                 // вторая строка из образца больше не нужна
    bag: data.bagNumber || '',
    sender: c.sender,
    receiver: c.receiver,
    bank: c.bankName,
    mfo: c.mfo,
    chief: c.chief,
    account: String(c.account).split('').join(' '),
    amount: `${fmt(data.amount)}, 00`,
    words: `${data.amountWords || numberToWordsRu(data.amount)} сум 00 тийин`
  };
}

/** Значения оборота: по купюре в строку плюс итог. */
function tableValues(data) {
  const counts = data.counts || {};
  const values = {};
  let total = 0;
  for (const denom of DENOMS) {
    const n = Math.max(0, Math.floor(Number(counts[denom]) || 0));
    const sum = n * denom;
    total += sum;
    values[`n${denom}`] = fmt(n);
    values[`s${denom}`] = fmt(sum);
  }
  values.total = fmt(total);
  return values;
}

function actPage(data, copyIndex) {
  const spec = copyIndex >= 3 ? ACT_COPY3 : ACT_COPY12;
  return renderPage(spec, actValues(data, copyIndex), 'act');
}

function backPage(data, copyIndex) {
  return copyIndex >= 3
    ? renderPage(ACT_CLIENT, {}, 'client-sheet')
    : renderPage(ACT_TABLE, tableValues(data), 'table-sheet');
}

/**
 * Одна печать = одна сторона листа у ВСЕХ экземпляров.
 *
 * `side: 'front'` — только листы «нусха», `side: 'back'` — их обороты
 * (роспись купюр у 1 и 2 нусха, памятка «МИЖОЗНИНГ АХБОРОТИГА» у третьей —
 * так же, как в файле WMS). Оператор печатает лицевые стороны, кладёт
 * стопку обратно и печатает обороты; выбирать нечётные страницы не нужно.
 *
 * `reverse` — для принтеров, которые выдают лист лицом вверх: последний
 * напечатанный оказывается сверху, и без обратного порядка стопка выходит
 * задом наперёд. Именно это оператор и перекладывал руками.
 */
export function buildPages(data, { side = 'front', reverse = false } = {}) {
  const asked = Number((data.constants && data.constants.copies) || ACT_DEFAULTS.copies);
  const copies = Math.max(1, Math.min(3, asked || 3));
  const order = [];
  for (let i = 1; i <= copies; i++) order.push(i);
  if (reverse) order.reverse();
  return order.map(i => side === 'back' ? backPage(data, i) : actPage(data, i)).join('\n');
}

export function buildActDocument(data, options = {}) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Инкассация ${esc(data.dateText)}</title>
<style>${ACT_CSS}</style></head><body>${buildPages(data, options)}</body></html>`;
}

// Шрифт вшит в стиль: страница печати живёт внутри расширения, из сети MV3
// его всё равно не даст подтянуть. Это тот же Inter, что и в файле WMS, —
// вынут из его PDF, поэтому строки имеют ровно ту же ширину. Без него
// выключка по центру и вправо разъедется на пункт-другой.
export const ACT_CSS = `
@font-face {
  font-family: 'ActInter';
  src: url(${ACT_FONT}) format('woff');
  font-weight: 400; font-style: normal; font-display: block;
}

/* Лист в натуральную величину: масштаб в диалоге печати выставлять не надо.
   Нулевое поле страницы — единственный способ убрать колонтитулы Chrome
   (адрес, дату и «1/1»); поля внутри листа заданы координатами бланка. */
@page { size: A4 portrait; margin: 0; }

/* МАСШТАБ 70% ВСТРОЕН В ЛИСТ.
   Бланк из WMS всегда печатали с масштабом 70% — таким его знают и в банке,
   и инкассатор, который сверяет его с сотнями таких же. Выставлять масштаб
   руками в окне печати оператор больше не должен: сжатие сидит в самом
   листе, а в диалоге остаётся честные 100%. Начало отсчёта — левый верхний
   угол, ровно как это делает Chrome со своим ползунком масштаба. */
.sheet {
  --act-scale: 0.7;
  width: 210mm; height: 297mm; overflow: hidden; background: #fff;
  page-break-after: always; break-after: page;
}
.sheet:last-child { page-break-after: auto; break-after: auto; }
.sheet .page { display: block; transform: scale(var(--act-scale)); transform-origin: top left; }
.sheet[data-scale="1"] { --act-scale: 1; }

.sheet text {
  font-family: 'ActInter', 'Segoe UI', Arial, sans-serif;
  fill: #000; white-space: pre;
  font-kerning: none; font-variant-ligatures: none;
  /* Без geometricPrecision Chrome округляет ширину КАЖДОЙ буквы до целого
     пикселя принтера, и к концу длинной строки набегает пункт-полтора —
     ровно то, из-за чего «Пул тушуми солинган халтанинг илова кайдномаси»
     не совпадала с оригиналом. С ним ширины дробные и точные. */
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
