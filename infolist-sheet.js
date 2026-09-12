// ==========================================
// infolist-sheet.js — бланк информационного листа
// ==========================================
// Лист едет в коробе на склад и там его читают в руках, на весу, рядом с
// лентой. Поэтому он крупный: заголовок 36pt, всё остальное 28pt, между
// строками воздух. Геометрия снята с образца, который печатает Uzum
// (Инфолисты.pdf): рамка в 24pt от края, логотип по центру на 56pt,
// заголовок на 201pt, строки реквизитов через 45.6pt.
//
// Чем этот лист отличается от образца — тем, что он не ломается на длинных
// списках. В образце ШК идут по одному в строку, и после тринадцатого они
// уезжают за нижний край листа: печать «получается», а половины коробки на
// ней нет. Здесь список сначала раскладывается в колонки, потом уменьшается
// до читаемого минимума, и только потом переносится на второй лист — с
// шапкой и нумерацией, чтобы приёмщик видел, что лист не один.

const PURPLE = '#6F00FF';

// Ширина листа и рамка — из образца, в пунктах.
export const SHEET = Object.freeze({
  w: 595.28, h: 841.89,     // A4
  frame: 24,                // отступ рамки от края
  pad: 42.6,                // левый край текста
  logoTop: 56.4, logoH: 77.5,
  titleTop: 201,
  bottom: 800               // ниже этого списку уже нельзя
});

/**
 * Типы листов. `fields` — порядок строк на бланке; `keywords` нужны поиску
 * в выпадающем списке: оператор ищет «брак» или «али», а не полное название.
 */
export const INFO_TEMPLATES = Object.freeze({
  fbs: {
    title: 'ОТМЕНЕННЫЕ ЗАКАЗЫ FBS',
    subtitle: '(Отмененные по причине: Отказ, Качество, Размер, Отмена заказа, Истек срок хранения)',
    fields: ['sender', 'receiver', 'date'],
    keywords: 'фбс отмена отказ качество размер срок хранения'
  },
  fbs_defect: {
    title: 'ОТМЕНЕННЫЕ ЗАКАЗЫ FBS (БРАК)',
    subtitle: '(Отмененные по причине: Брак, Комплектация, Неверный товар, Фото)',
    fields: ['sender', 'receiver', 'date'],
    keywords: 'фбс брак комплектация неверный товар фото'
  },
  fbo: {
    title: 'ОТМЕНЕННЫЕ ЗАКАЗЫ FBO',
    subtitle: '(Отмененные по причине: Отказ, Качество, Размер, Отмена заказа, Истек срок хранения)',
    fields: ['sender', 'receiver', 'date'],
    keywords: 'фбо отмена отказ качество размер срок хранения'
  },
  fbo_defect: {
    title: 'ОТМЕНЕННЫЕ ЗАКАЗЫ FBO (БРАК)',
    subtitle: '(Отмененные по причине: Брак, Комплектация, Неверный товар, Фото)',
    fields: ['sender', 'receiver', 'date'],
    keywords: 'фбо брак комплектация неверный товар фото'
  },

  diagnostic: {
    title: 'ТОВАР НА ДИАГНОСТИКУ В ОТДЕЛ СЕРВИСА',
    fields: ['sender', 'date', 'order', 'barcode'],
    keywords: 'сервис диагностика ремонт'
  },
  uzum_bank: {
    title: 'НЕВОСТРЕБОВАННЫЕ КАРТЫ UZUM BANK',
    fields: ['sender', 'receiver', 'date', 'count', 'list'],
    listLabel: 'Номера карт Uzum Bank:',
    keywords: 'узум банк карты uzum bank невостребованные'
  },
  aliexpress: {
    title: 'НЕВОСТРЕБОВАННЫЕ ЗАКАЗЫ ALIEXPRESS',
    fields: ['sender', 'receiver', 'date', 'count', 'list'],
    listLabel: 'Номера заказов AliExpress:',
    keywords: 'алиэкспресс ali aliexpress sx невостребованные'
  },
  uzum_global: {
    title: 'НЕВОСТРЕБОВАННЫЕ ЗАКАЗЫ UZUM GLOBAL',
    fields: ['sender', 'receiver', 'date', 'count', 'list'],
    listLabel: 'Номера заказов Uzum Global:',
    keywords: 'узум глобал global rx невостребованные'
  },
  canceled_earlier: {
    title: 'РАНЕЕ ОТМЕНЕННЫЕ ЗАКАЗЫ',
    fields: ['sender', 'receiver', 'date', 'list'],
    listLabel: 'Номера заказов/ШК товаров:',
    keywords: 'ранее отмененные заказы'
  },
  redirect: {
    title: 'ПЕРЕНАПРАВЛЕНИЕ',
    fields: ['sender', 'target', 'date', 'list'],
    listLabel: 'Номера заказов/ШК товаров:',
    keywords: 'перенаправление другой пвз переезд'
  },
  unknown: {
    title: 'НЕИЗВЕСТНЫЕ ТОВАРЫ',
    fields: ['sender', 'receiver', 'date', 'list', 'unknown_count'],
    listLabel: 'ШК товаров:',
    keywords: 'неизвестные товары без шк ничьи'
  },
  kgt: {
    title: 'КРУПНО-ГАБАРИТНЫЙ ТОВАР ОТГРУЖЕН В КОРОБ',
    fields: ['sender', 'receiver', 'date', 'gm', 'barcode'],
    keywords: 'кгт крупногабаритный габарит короб'
  }
});

/** Подписи строк — ровно те, что стоят в образце. */
export const FIELD_LABELS = Object.freeze({
  sender: 'ПВЗ Отправитель:',
  receiver: 'Куда:',
  target: 'Получатель:',
  date: 'Дата отправки:',
  order: 'Номер заказа:',
  barcode: 'ШК товара:',
  gm: 'ГМ короба:',
  count: 'Количество возвращаемых позиций в коробе:',
  unknown_count: 'Количество товаров без ШК:'
});

/** Поля, которые оператор заполняет руками (без `count` — он считается сам). */
export const EDITABLE_FIELDS = Object.freeze(['receiver', 'target', 'order', 'barcode', 'gm', 'unknown_count']);

export const INFO_DEFAULTS = Object.freeze({
  sender: 'ТАШ-120',
  receiver: 'На склад Ташкента',
  target: '',
  order: '',
  barcode: '',
  gm: '',
  unknown_count: 0,
  copies: 1
});

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** ДД.ММ.ГГГГ из значения <input type="date"> или из Date. */
export function formatSheetDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    const d = String(value.getDate()).padStart(2, '0');
    const m = String(value.getMonth() + 1).padStart(2, '0');
    return `${d}.${m}.${value.getFullYear()}`;
  }
  const parts = String(value).split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0]}` : String(value);
}

/**
 * Чего не хватает, чтобы печатать. Пустой бланк хуже ненапечатанного:
 * короб уедет на склад с листом, в котором не сказано, что внутри.
 */
export function missingFields(tplKey, data) {
  const tpl = INFO_TEMPLATES[tplKey];
  if (!tpl) return ['Тип инфолиста'];
  const out = [];
  if (!String(data.sender || '').trim()) out.push(FIELD_LABELS.sender.replace(':', ''));
  if (!String(data.date || '').trim()) out.push('Дата отправки');
  for (const f of tpl.fields) {
    if (f === 'sender' || f === 'date' || f === 'count') continue;
    if (f === 'list') {
      if (!(data.items || []).filter(x => String(x).trim()).length) out.push((tpl.listLabel || 'Список').replace(':', ''));
      continue;
    }
    if (f === 'unknown_count') continue;               // ноль — законное значение
    if (!String(data[f] || '').trim()) out.push(FIELD_LABELS[f].replace(':', ''));
  }
  return out;
}

// ---------- разметка ----------

function rowsHtml(tpl, data, which) {
  const items = (data.items || []).map(x => String(x).trim()).filter(Boolean);
  const at = tpl.fields.indexOf('list');
  const fields = at < 0 ? (which === 'after' ? [] : tpl.fields)
    : (which === 'after' ? tpl.fields.slice(at + 1) : tpl.fields.slice(0, at));
  const out = [];
  for (const f of fields) {
    if (f === 'list') continue;
    let value;
    if (f === 'sender') value = data.sender;
    else if (f === 'date') value = formatSheetDate(data.date);
    else if (f === 'count') value = String(items.length);
    else if (f === 'unknown_count') value = String(Math.max(0, Number(data.unknown_count) || 0));
    else value = data[f];
    out.push(`<p class="il-row"><b>${esc(FIELD_LABELS[f])}</b> ${esc(value)}</p>`);
  }
  return out.join('');
}

function listHtml(tpl, items) {
  if (!tpl.fields.includes('list')) return '';
  return `<div class="il-list" data-count="${items.length}">
    <p class="il-row il-row--label"><b>${esc(tpl.listLabel || '')}</b></p>
    <ol class="il-items">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ol>
  </div>`;
}

/**
 * Один лист. `part` — {index, total} для продолжения на втором листе.
 */
function sheetHtml(tpl, data, items, part) {
  const cont = part && part.total > 1;
  const logo = data.logoUrl || '';
  return `<section class="il-sheet" data-part="${part ? part.index : 1}">
    <div class="il-frame"></div>
    ${logo ? `<img class="il-logo" src="${esc(logo)}" alt="uzum">` : '<div class="il-logo"></div>'}
    <div class="il-body">
      <h1 class="il-title">${esc(tpl.title)}${cont ? ' <span class="il-cont">(лист '
        + part.index + ' из ' + part.total + ')</span>' : ''}</h1>
      ${tpl.subtitle ? `<h2 class="il-subtitle">${esc(tpl.subtitle)}</h2>` : ''}
      <p class="il-kicker">Информационный лист</p>
      <div class="il-rows">${rowsHtml(tpl, data, 'before')}</div>
      ${listHtml(tpl, items)}
      <div class="il-rows il-rows--after">${rowsHtml(tpl, data, 'after')}</div>
    </div>
  </section>`;
}

/**
 * Собирает бланк. Возвращает HTML одного или нескольких листов; сколько их
 * будет, решает подгонка уже в странице — здесь список кладётся целиком.
 */
export function buildInfolistSheet(tplKey, data) {
  const tpl = INFO_TEMPLATES[tplKey];
  if (!tpl) throw new Error(`Неизвестный тип инфолиста: ${tplKey}`);
  const items = (data.items || []).map(x => String(x).trim()).filter(Boolean);
  return sheetHtml(tpl, data, items, null);
}

/** Столько же листов, сколько просили копий: печать одним заходом. */
export function buildInfolistDocument(tplKey, data) {
  const copies = Math.max(1, Math.min(50, Number(data.copies) || 1));
  const one = buildInfolistSheet(tplKey, data);
  return Array.from({ length: copies }, () => one).join('\n');
}

// ---------- подгонка ----------
//
// Шапку не трогаем вовсе: её читает приёмщик, ещё не открыв короб, и мельче
// она быть не должна. Ужимается только список, и в таком порядке:
//   1. колонки — 1, 2, 3. Кегль при этом не меняется вообще;
//   2. кегль списка вниз, но не ниже 45% (12.6pt — всё ещё крупнее обычного
//      печатного текста), подбором по измерению, а не ступенями: берём
//      САМЫЙ КРУПНЫЙ, который влезает;
//   3. и только потом второй лист.
// Второй лист — последнее средство: приёмщик сверяет короб по одному листу
// и второй может не заметить, поэтому на нём стоит «лист 2 из 2».

export const LIST_MIN_SCALE = 0.4;
export const AIR_MIN = 0.5;
const MAX_COLUMNS = 4;

/** Заголовок должен помещаться в две строки — иначе он съедает лист. */
export function fitTitle(sheet, maxLines = 2) {
  const title = sheet.querySelector('.il-title');
  if (!title) return 1;
  const line = parseFloat(getComputedStyle(title).lineHeight) || 1;
  let scale = 1;
  for (let i = 0; i < 14; i++) {
    const lines = Math.round(title.getBoundingClientRect().height / line);
    if (lines <= maxLines || scale <= 0.62) break;
    scale = Math.round((scale - 0.05) * 100) / 100;
    title.style.fontSize = `calc(36pt * var(--il-sheet-scale) * ${scale})`;
  }
  return scale;
}

/** Помещается ли содержимое листа в рамку. */
export function sheetOverflows(sheet) {
  const body = sheet.querySelector('.il-body');
  if (!body) return false;
  const box = sheet.getBoundingClientRect();
  const limit = box.top + box.height * (SHEET.bottom / SHEET.h);
  return body.getBoundingClientRect().bottom > limit + 0.5;
}

function apply(sheet, { cols, list, air }) {
  sheet.style.setProperty('--il-list-scale', list);
  sheet.style.setProperty('--il-air', air);
  const el = sheet.querySelector('.il-items');
  if (el) el.style.columnCount = cols;
}

/** Номер, перенесённый на вторую строку, читается как два номера. */
function itemsWrap(sheet) {
  for (const li of sheet.querySelectorAll('.il-items li')) {
    if (li.scrollWidth > li.clientWidth + 1) return true;
  }
  return false;
}

/** Ищет самое большое значение в [lo, hi], при котором лист ещё влезает. */
function largestFitting(sheet, lo, hi, set, steps = 7) {
  let best = null;
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    set(mid);
    if (sheetOverflows(sheet)) hi = mid;
    else { best = mid; lo = mid; }
  }
  return best;
}

/**
 * Подбирает раскладку. Возвращает {cols, list, air, overflow}; overflow
 * значит, что не помогло ничего и список надо резать по листам.
 */
export function fitSheet(sheet) {
  fitTitle(sheet);
  const plain = { cols: 1, list: 1, air: 1 };
  apply(sheet, plain);
  if (!sheet.querySelector('.il-items')) {
    return { ...plain, overflow: sheetOverflows(sheet) };
  }

  // 1. Сначала пробуем вообще ничего не ужимать: только колонки.
  for (let cols = 1; cols <= MAX_COLUMNS; cols++) {
    apply(sheet, { ...plain, cols });
    if (cols > 1 && itemsWrap(sheet)) break;
    if (!sheetOverflows(sheet)) return { ...plain, cols, overflow: false };
  }

  // 2. Не хватило места. Идём ОТ БОЛЬШЕГО числа колонок: при той же высоте
  //    листа четыре колонки позволяют более крупный кегль, чем две. Колонок
  //    убавляем ровно до тех пор, пока номера не перестанут переноситься.
  let last = { ...plain, cols: 1, air: AIR_MIN, list: LIST_MIN_SCALE };
  for (let cols = MAX_COLUMNS; cols >= 1; cols--) {
    const st = { cols, list: 1, air: 1 };

    const air = largestFitting(sheet, AIR_MIN, 1, (v) => apply(sheet, { ...st, air: v }));
    st.air = air === null ? AIR_MIN : Math.floor(air * 100) / 100;
    apply(sheet, st);
    if (!sheetOverflows(sheet) && !itemsWrap(sheet)) return { ...st, overflow: false };

    const list = largestFitting(sheet, LIST_MIN_SCALE, 1, (v) => apply(sheet, { ...st, list: v }));
    st.list = list === null ? LIST_MIN_SCALE : Math.floor(list * 100) / 100;
    apply(sheet, st);
    if (!itemsWrap(sheet)) {
      last = st;
      if (!sheetOverflows(sheet)) return { ...st, overflow: false };
    }
  }

  apply(sheet, last);
  return { ...last, overflow: true };
}

/** Режет список по листам, когда он не влез даже на минимальном кегле. */
export function splitItems(items, perSheet) {
  const size = Math.max(1, Math.floor(perSheet) || 1);
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out.length ? out : [[]];
}

export function buildInfolistParts(tplKey, data, chunks) {
  const tpl = INFO_TEMPLATES[tplKey];
  return chunks.map((chunk, i) =>
    sheetHtml(tpl, data, chunk, { index: i + 1, total: chunks.length })).join('\n');
}

/**
 * Один лист из нескольких. Нужен, чтобы примерять вместимость: строка
 * «лист 1 из 2» занимает место, и если мерить без неё, на настоящем листе
 * последняя позиция окажется за рамкой.
 */
export function buildInfolistSheetPart(tplKey, data, items, index, total) {
  const tpl = INFO_TEMPLATES[tplKey];
  if (!tpl) throw new Error(`Неизвестный тип инфолиста: ${tplKey}`);
  return sheetHtml(tpl, data, items, { index, total });
}

/**
 * Полный расклад: рисует лист в `host`, подгоняет, при нужде режет по листам
 * и размножает по числу копий. Возвращает готовую разметку и то, чем за это
 * пришлось заплатить, — чтобы было что показать оператору.
 *
 * `host` — любой контейнер шириной с лист; в попапе это спрятанная за краем
 * сцена, на странице печати — сам предпросмотр. Меряем всегда по-настоящему:
 * сколько ШК влезет, зависит от длины номеров и от шрифта, который нашёлся
 * в системе, и посчитать это заранее нельзя.
 */
export function layoutSheets(host, tplKey, data) {
  const items = (data.items || []).map(x => String(x).trim()).filter(Boolean);

  host.innerHTML = buildInfolistSheet(tplKey, data);
  let fit = fitSheet(host.querySelector('.il-sheet'));
  let parts = 1;

  if (fit.overflow && items.length > 1) {
    // Сколько позиций влезает — ищем перебором, меряя ИМЕННО лист-продолжение:
    // у него в шапке лишняя строка «лист 1 из 2», и без неё вместимость
    // получается завышенной ровно на ту позицию, которая потом уедет за рамку.
    let lo = 1, hi = items.length, per = 1;
    for (let i = 0; i < 9 && lo <= hi; i++) {
      const mid = Math.floor((lo + hi) / 2);
      host.innerHTML = buildInfolistSheetPart(tplKey, data, items.slice(0, mid), 1, 2);
      if (fitSheet(host.querySelector('.il-sheet')).overflow) hi = mid - 1;
      else { per = mid; lo = mid + 1; }
    }
    // Чем больше листов, тем длиннее «из N» в шапке: если после разрезания
    // хоть один лист всё-таки вылез, снимаем по позиции.
    for (let guard = 0; guard < 4; guard++) {
      const chunks = splitItems(items, per);
      host.innerHTML = buildInfolistParts(tplKey, data, chunks);
      let over = false;
      for (const sheet of host.querySelectorAll('.il-sheet')) {
        fit = fitSheet(sheet);
        over = over || fit.overflow;
      }
      parts = chunks.length;
      if (!over || per <= 1) break;
      per = Math.max(1, per - 1);
    }
  }

  const copies = Math.max(1, Math.min(50, Number(data.copies) || 1));
  if (copies > 1) {
    const one = host.innerHTML;
    host.innerHTML = Array.from({ length: copies }, () => one).join('');
  }

  return { html: host.innerHTML, parts, copies, fit, items: items.length };
}

// ---------- стиль ----------
//
// Шрифт. В образце — Bahnschrift: узкий гротеск, который стоит в каждой
// Windows начиная с 10-й, то есть и на компьютере ПВЗ. Он и даёт бланку
// его вид: широкие поля при крупном кегле. Запасные — тоже узкие, чтобы
// при их подстановке лист не расползся.

export const INFOLIST_CSS = `
@page { size: A4 portrait; margin: 0; }

.il-sheet {
  --il-sheet-scale: 1;
  --il-list-scale: 1;
  /* Воздух шапки. 1 — как в образце; ниже — когда список иначе не влезает.
     Уплотняем именно воздух, а не кегль: кегль читают, воздух — нет. */
  --il-air: 1;
  position: relative;
  width: 210mm; height: 297mm;
  background: #fff; color: #000; overflow: hidden;
  page-break-after: always; break-after: page;
  font-family: 'Bahnschrift', 'DIN Alternate', 'Roboto Condensed',
               'PT Sans Narrow', 'Arial Narrow', 'Segoe UI', sans-serif;
  font-variant-numeric: lining-nums tabular-nums;
  -webkit-font-smoothing: antialiased;
}
.il-sheet:last-child { page-break-after: auto; break-after: auto; }

.il-frame {
  position: absolute; inset: ${SHEET.frame}pt;
  border: 0.5pt solid #000; pointer-events: none;
}

.il-logo {
  position: absolute; left: 50%; transform: translateX(-50%);
  top: ${SHEET.logoTop}pt; height: ${SHEET.logoH}pt; width: auto;
  display: block;
}

.il-body {
  position: absolute;
  left: ${SHEET.pad}pt; right: ${SHEET.pad}pt;
  top: calc(150pt + 20pt * var(--il-air));
  font-size: calc(28pt * var(--il-sheet-scale));
  line-height: calc(1.25 + 0.38 * var(--il-air));
}

.il-title {
  margin: 0; text-align: center; color: ${PURPLE};
  font-size: calc(36pt * var(--il-sheet-scale));
  line-height: 1.2; font-weight: 700; letter-spacing: .002em;
  text-transform: uppercase;
}
.il-cont {
  display: block; font-size: .55em; letter-spacing: .02em;
  color: ${PURPLE}; opacity: .75;
}
.il-subtitle {
  margin: 10.4pt 0 0; text-align: center; color: ${PURPLE};
  font-size: calc(28pt * var(--il-sheet-scale));
  line-height: 1.2; font-weight: 700;
}
.il-kicker {
  margin: calc(56pt * var(--il-air)) 0 0; text-align: center; font-weight: 700;
  font-size: calc(28pt * var(--il-sheet-scale)); line-height: 1.2;
}
.il-subtitle + .il-kicker { margin-top: calc(57.6pt * var(--il-air)); }

.il-rows { margin-top: 6pt; }
.il-row { margin: 0; }
.il-row b { font-weight: 700; }

.il-list { margin-top: 0; }
.il-row--label { margin-top: 0; }
.il-rows--after:not(:empty) { margin-top: calc(10pt * var(--il-air)); }
.il-items {
  list-style: none; margin: calc(4pt * var(--il-air)) 0 0; padding: 0;
  font-size: calc(1em * var(--il-list-scale));
  column-gap: 24pt;
}
.il-items li { break-inside: avoid; }
`;
