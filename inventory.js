// ==========================================
// inventory.js — инвентаризация по ячейкам
// ==========================================
// Отдельная СТРАНИЦА, а не вкладка попапа, и это не косметика: попап Chrome
// закрывается, как только фокус ушёл, а при инвентаризации оператор держит в
// руках товар и сканер. Терять состояние на каждом клике мимо — неприемлемо.
//
// Данные берутся из того же chrome.storage.local, что наполняет Приёмка:
// «должно лежать в ячейке» — это записи с заполненным полем cell.
//
// Ход проверки хранится отдельным ключом priemkaInventory и переживает
// закрытие вкладки, перезагрузку и конец смены: аудит на 358 ячеек за один
// присест не делается.

const STORE_KEY = 'priemkaInventory';
const SOURCE_KEYS = ['priemkaRecords', 'priemkaCells', 'priemkaSku', 'priemkaMissingCells',
                     'priemkaInvPrefs', 'priemkaFbsContents', 'pvzLayout'];

const state = {
  records: [],
  byCell: new Map(),        // cellId -> [records]
  session: { cells: {}, startedAt: null },
  noCell: [],
  shelfOrders: 0,
  sku: {},                  // ШК -> название товара из справочника WMS
  activeCell: null,
  filter: '',
  sound: true,
  showAllCells: false,   // показывать и пустые ячейки справочника
  lastScan: null,        // {key, at} — строка, по которой только что пикнули
  fbs: {},               // посылка -> её состав по описи WMS
  openFbs: new Set(),    // какие составы сейчас развёрнуты
  missing: new Set()     // ячейки, которых физически нет
};

const el = {
  cellList: document.getElementById('cell-list'),
  search: document.getElementById('cell-search'),
  workEmpty: document.getElementById('work-empty'),
  workBody: document.getElementById('work-body'),
  workCell: document.getElementById('work-cell'),
  workMeta: document.getElementById('work-meta'),
  items: document.getElementById('items'),
  extras: document.getElementById('extras'),
  extraWrap: document.getElementById('extra-wrap'),
  scan: document.getElementById('scan-input'),
  scanIdle: document.getElementById('scan-idle'),
  scanHint: document.getElementById('scan-hint'),
  flash: document.getElementById('flash'),
  statCells: document.getElementById('stat-cells'),
  statNoCell: document.getElementById('stat-nocell'),
  ledger: document.getElementById('ledger'),
  statFound: document.getElementById('stat-found'),
  statMissing: document.getElementById('stat-missing'),
  statExtra: document.getElementById('stat-extra')
};

// ---------- идентификация товара ----------
// Сканер может прочитать что угодно из того, что наклеено на посылке:
// ШК товара, штрихкод заказа, номер заказа. Поэтому у записи не один код,
// а набор, и совпадение по любому из них считается попаданием.

/**
 * ШТРИХКОД ПОСЫЛКИ ЧИТАЕТСЯ НЕ ВСЕГДА ЦЕЛИКОМ.
 *
 * У франшизных ПВЗ к коду отправления добавлен хвост пункта:
 * `10-0109920688-1-PU02` (замер FrТАШ-223 08.09.2026). Сканер и наклейка не
 * всегда сходятся на одном написании, поэтому кроме полного кода принимаем
 * и его начало без хвоста, и голый номер заказа. Все варианты выведены из
 * штрихкода САМОЙ этой записи, поэтому чужую посылку такой скан не поймает.
 */
function barcodeForms(code) {
  const out = [];
  const text = String(code || '').trim().toUpperCase();
  if (!text) return out;
  out.push(text);
  const noPickup = text.replace(/-PU\d+$/i, '');
  if (noPickup !== text) out.push(noPickup);
  const m = noPickup.match(/^(\d{2}-\d{6,})-\d+$/);
  if (m) out.push(m[1]);
  return out;
}

function codesOf(record) {
  const out = [];
  for (const v of [record.orderBarcode, record.barcode]) out.push(...barcodeForms(v));
  for (const v of [record.barcode, record.orderId, record.pid]) {
    if (v) out.push(String(v).trim().toUpperCase());
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * РУССКАЯ РАСКЛАДКА — ЭТО НЕ ОШИБКА ОПЕРАТОРА.
 *
 * Сканер печатает буквы как клавиатура: он «нажимает» физические клавиши, а
 * какая раскладка стоит в системе, ему знать неоткуда. Оставили ЙЦУКЕН —
 * и штрихкод `RX612087819UZ` приезжает как `КЧ612087819УЯ`. Прежде это был
 * неизвестный код, звук ошибки и поход разбираться на пустом месте.
 *
 * В штрихкодах кириллицы не бывает вовсе, поэтому любая русская буква в
 * скане означает ровно одно: раскладка. Возвращаем клавиши на место.
 */
const RU_TO_EN = {
  'Й': 'Q', 'Ц': 'W', 'У': 'E', 'К': 'R', 'Е': 'T', 'Н': 'Y', 'Г': 'U', 'Ш': 'I',
  'Щ': 'O', 'З': 'P', 'Х': '[', 'Ъ': ']',
  'Ф': 'A', 'Ы': 'S', 'В': 'D', 'А': 'F', 'П': 'G', 'Р': 'H', 'О': 'J', 'Л': 'K',
  'Д': 'L', 'Ж': ';', 'Э': "'",
  'Я': 'Z', 'Ч': 'X', 'С': 'C', 'М': 'V', 'И': 'B', 'Т': 'N', 'Ь': 'M',
  'Б': ',', 'Ю': '.', 'Ё': '`'
};

function fromRuLayout(text) {
  if (!/[А-ЯЁ]/.test(text)) return text;
  return text.replace(/[А-ЯЁ]/g, (c) => RU_TO_EN[c] || c);
}

function normalizeScan(text) {
  return fromRuLayout(String(text || '').trim().toUpperCase().replace(/\s+/g, ''));
}

/**
 * СКОЛЬКО ФИЗИЧЕСКИХ ЕДИНИЦ В СТРОКЕ.
 *
 * Экран «Перейти к выдаче» показывает у каждой строки «0 / N шт.» — и это
 * N и есть число одинаковых копий этого товара в этом заказе и в этой
 * ячейке. Приходит оно полем `amount` из того же запроса товаров, что мы
 * и делаем. Строка на экране ОДНА, копий в ней может быть несколько.
 *
 * Считать строки вместо копий — значит недосчитаться товара: оператор
 * закрывает ячейку, отсканировав одну вещь из двух, и недостача всплывает
 * в тот день, когда за второй придёт клиент.
 */
function unitsOf(record) {
  return globalThis.UCoreWmsParse.unitsOf(record);
}

/**
 * Строку с несколькими копиями разворачиваем в отдельные единицы: дальше
 * весь обход считает вещи, а не строки. Каждая копия получает свой номер,
 * и он входит в ключ — иначе вторая копия «уже отмечена» первой.
 */
function expandUnits(records) {
  const out = [];
  for (const record of records) {
    const n = unitsOf(record);
    if (n === 1) { out.push(record); continue; }
    for (let i = 1; i <= n; i++) out.push({ ...record, unit: i, units: n });
  }
  return out;
}

/**
 * Ручная разметка со схемы зала: что оператор пометил своими руками.
 *
 * `none` — ячейки физически нет: на обходе её не спрашиваем.
 * `wall` / `oversize` / `big` — подсказка на строке ячейки: у стены стоит
 * крупногабарит, и оператор должен знать это ДО того, как пойдёт искать.
 */
function planMarks(layout) {
  const none = [];
  const kind = new Map();
  // Какие ячейки схема вообще знает: отдел нарисован, у него столько-то
  // этажей и позиций. Пока ни один отдел не нарисован — схемы нет, и
  // ограничивать по ней нечего.
  const exists = new Set();
  let drawn = 0;

  for (const group of (layout && layout.groups) || []) {
    if (!group) continue;
    for (const [code, mark] of Object.entries(group.cells || {})) {
      if (mark === 'none') none.push(String(code));
      else if (mark && mark !== 'standard') kind.set(String(code), mark);
    }
    const section = String(group.section || '').trim();
    if (!section) continue;
    const floors = Number(group.floors) || 0;
    const positions = Number(group.positions) || 0;
    if (!floors || !positions) continue;
    drawn++;
    for (let floor = 1; floor <= floors; floor++) {
      for (let pos = 1; pos <= positions; pos++) exists.add(`${section}${floor}${pos}`);
    }
  }

  return { none, kind, exists: drawn ? exists : null };
}

const PLAN_LABEL = { big: 'большая', wall: 'стена', oversize: 'негабарит' };

function keyOf(record) {
  const key = globalThis.UCoreWmsParse.recordKey(record);
  return record && record.unit ? `${key}#${record.unit}` : key;
}

/** «FBS», «UZUM-BANK», «Aliexpress» — чем эта посылка является. */
function typeLabel(record) {
  return globalThis.UCoreWmsParse.typeLabel(record);
}

/**
 * ЗАПЕЧАТАННЫЕ ПАРТНЁРСКИЕ ПОСЫЛКИ.
 *
 * Их состав не отдаёт ни WMS, ни продавец, и вскрывать их на ПВЗ нельзя.
 * Значит, «что внутри» у них не бывает неизвестным временно — оно неизвестно
 * всегда, и говорить об этом на каждой строке незачем. Список именной, а не
 * «всё партнёрское»: у JOOM и Uzum Nasiya состав иногда приезжает сбором.
 */
const SEALED_PARTNERS = new Set(['Aliexpress', 'Uzum Global', 'UZUM-BANK']);

/** Посылка целиком: содержимое ПВЗ неизвестно, штрихкод один. */
function isWholeOrder(record) {
  return globalThis.UCoreWmsParse.isWholeOrder(record);
}

/** Лежит ли эта вещь на полке прямо сейчас (и если нет — почему). */
function shelfState(record) {
  return globalThis.UCoreWmsParse.shelfState(record);
}

/**
 * ЧТО ВНУТРИ ПАКЕТА — по сканам самого оператора.
 *
 * WMS содержимого FBS не отдаёт: проверено 07.09.2026 по всем адресам ПВЗ —
 * `items` у такого заказа приходит пустым, и сам WMS на экране выдачи
 * показывает пустоту. Оно и понятно: FBS собирает продавец, ПВЗ получает
 * запечатанный пакет.
 *
 * Зато оператор регулярно бьёт по ШК ВНУТРИ пакета — тот виден через
 * плёнку, а свой ярлык пакета на обороте. Раньше это было расхождение:
 * «WMS о таком не знает», и оно висело до конца обхода. Теперь такой
 * удар — не ошибка, а сведение: следующий скан самого пакета связывает
 * их, ошибка уходит, а ШК остаётся в составе заказа. Со второго раза
 * такой ШК опознаётся сразу.
 */
function packageKey(record) {
  return globalThis.UCoreWmsParse.packageKey(record);
}

/**
 * Состав ИМЕННО ЭТОЙ коробки.
 *
 * Один заказ приезжает несколькими посылками в разные ячейки, и внутри
 * каждой своё. Поэтому ищем по ключу посылки; ключ заказа остаётся запасным
 * — под ним лежит то, что успели выучить сканами до появления посылок.
 */
function fbsOf(record) {
  const key = packageKey(record);
  if (key && state.fbs[key]) return state.fbs[key];
  const id = String(record && (record.orderId || record.orderBarcode) || '');
  return (id && state.fbs[id]) || null;
}

function fbsItems(record) {
  const box = fbsOf(record);
  if (!box || !box.items) return [];
  return Object.entries(box.items)
    .map(([barcode, info]) => ({ barcode, ...info }))
    .sort((a, b) => (b.count || 1) - (a.count || 1) || a.barcode.localeCompare(b.barcode));
}

/**
 * Уже известное вложение: ШК из описи, которую отдал WMS.
 *
 * СОСТАВ ПРИХОДИТ ТОЛЬКО СБОРОМ. Раньше здесь жила догадка: неопознанный
 * удар копился, и следующий скан пакета «объяснял» его — код записывался
 * в состав этого заказа. Догадка красивая, но она приписывает пакету то,
 * что оператор мог снять с соседней полки, и отменять её приходилось
 * руками. Опись WMS такого не требует: она либо есть, либо её нет, и
 * второе — честный ответ.
 */
function fbsOwnerOf(code) {
  for (const [id, box] of Object.entries(state.fbs || {})) {
    if (box && box.items && box.items[code]) return { id, box };
  }
  return null;
}

/** Записи этой посылки среди ожидаемых в ячейке. */
function recordsOfPackage(list, key) {
  return list.filter(r => packageKey(r) === key
    || String(r.orderId || r.orderBarcode || '') === key);
}

// ---------- загрузка ----------

function load() {
  chrome.storage.local.get([...SOURCE_KEYS, STORE_KEY], (data) => {
    // Заказы, которых WMS больше не показывает (клиент забрал), в
    // инвентаризации не участвуют: иначе оператор ищет на полке то, чего
    // там законно нет, и записывает это в недостачу.
    // ОДИН И ТОТ ЖЕ НАБОР, ЧТО У ПРИЁМКИ, — иначе числа не сойдутся.
    //   * gone — заказ забрал клиент, на полке его законно нет;
    //   * cargo — позиция в коробе, короб ещё не принят, ячейки у неё нет.
    // Всё остальное — полка. Из неё в обход попадают только позиции
    // С ЯЧЕЙКОЙ; те, у кого ячейки нет, обходом не покрываются, и об этом
    // должно быть сказано вслух, а не молчанием.
    const shelf = (data.priemkaRecords || []).filter(r => !r.gone && r.source !== 'cargo');
    // Разворачиваем строки в ЕДИНИЦЫ: «0 / 2 шт.» — это две вещи на полке,
    // и обойти надо обе.
    state.records = expandUnits(shelf.filter(r => r.cell));
    state.noCell = expandUnits(shelf.filter(r => !r.cell));
    state.shelfOrders = new Set(shelf.map(r => String(r.orderId || r.orderBarcode)).filter(Boolean)).size;
    state.session = data[STORE_KEY] || { cells: {}, startedAt: null };
    state.sku = data.priemkaSku || {};
    state.fbs = data.priemkaFbsContents || {};
    // ЧТО РАЗМЕЧЕНО РУКАМИ НА СХЕМЕ ЗАЛА — то и на обходе.
    //
    // Раньше схема жила сама по себе: оператор помечал ячейку «нет», а
    // инвентаризация продолжала её спрашивать. Пометка, которая ни на что
    // не влияет, хуже отсутствующей — на неё тратят время и ей верят.
    //
    // Берём ТОЛЬКО ручные пометки (`group.cells[код]`). Ячейки, которых
    // просто нет в справочнике WMS, схема тоже рисует серыми, но это её
    // догадка, а не решение человека, и обход по ней менять нельзя.
    const plan = planMarks(data.pvzLayout);
    state.planKind = plan.kind;
    state.planCells = plan.exists;
    state.missing = new Set([
      ...(data.priemkaMissingCells || []).map(String),
      ...plan.none
    ]);
    state.directory = (data.priemkaCells || []).map(String);
    const prefs = data.priemkaInvPrefs || {};
    state.sound = prefs.sound !== false;
    state.showAllCells = prefs.showAllCells === true;
    if (!state.session.cells) state.session.cells = {};

    state.byCell = new Map();
    state.inMissing = 0;
    for (const record of state.records) {
      const cell = String(record.cell);
      // Ячейки физически нет — но товар по ней ЧИСЛИТСЯ. Молча выбросить
      // такую строку значит потерять вещь: считаем их и говорим вслух.
      if (state.missing.has(cell)) { state.inMissing++; continue; }
      if (!state.byCell.has(cell)) state.byCell.set(cell, []);
      state.byCell.get(cell).push(record);
    }

    // Ячейки, которые по данным WMS ПУСТЫ, обычно не показываем — их сотни,
    // и обходить их незачем. Но если в такой ячейке что-то лежит, обычная
    // инвентаризация этого не заметит: туда просто никто не подойдёт.
    // Поэтому режим «показывать все» существует и включается кнопкой.
    //
    // СПРАВОЧНИК WMS — НЕ ОПИСЬ ЗАЛА. В нём остаются коды отделов, которых
    // на ПВЗ давно нет: на ТАШ-120 их 358 на четырнадцать секций. Гнать
    // оператора по ним — это сотни пустых подходов к стеллажу, которого
    // нет. Поэтому пустые ячейки берутся из СХЕМЫ: нарисован отдел — его
    // ячейки и предлагаем. Схема не нарисована — показываем весь справочник,
    // как раньше: без схемы у нас нет ничего лучше.
    //
    // Ячейки, в которых ЧТО-ТО ЧИСЛИТСЯ, это не касается: они попали в обход
    // выше и остаются там, даже если на схеме их нет.
    state.notOnPlan = 0;
    if (state.showAllCells) {
      for (const cell of state.directory) {
        if (state.missing.has(cell) || state.byCell.has(cell)) continue;
        if (state.planCells && !state.planCells.has(cell)) { state.notOnPlan++; continue; }
        state.byCell.set(cell, []);
      }
    }

    renderCells();
    renderStats();
    if (state.activeCell) renderWork();
    focusScanner();
  });
}

function saveSession() {
  if (!state.session.startedAt) state.session.startedAt = Date.now();
  chrome.storage.local.set({ [STORE_KEY]: state.session });
}

/**
 * Читаемое название позиции.
 *
 * `record.itemName` у записей из WMS почти всегда пустое — название лежит
 * в справочнике товаров, и там оно в поле `name` (это description у WMS),
 * а `title` — код поставщика вроде «OILATAN-OILA43». Раньше половина мест
 * в этом файле брала только itemName, и оператор видел голый штрихкод:
 * в подсказке при сканировании, в списке лишнего и в выгрузке расхождений.
 */
/** Полное название из WMS — как есть. Нужно для подсказки и для поиска. */
function fullNameOf(record) {
  if (!record) return '';
  if (record.itemName) return record.itemName;
  const sku = record.barcode ? state.sku[record.barcode] : null;
  return (sku && (sku.name || sku.title)) || '';
}

function nameByBarcode(code) {
  const sku = state.sku[code];
  return (sku && (sku.name || sku.title)) || '';
}

// ------------------------------------------------------------------
// «Только что отсканировано»
// ------------------------------------------------------------------
// В ячейке бывает полтора десятка позиций, и все отмеченные выглядят
// одинаково. После скана оператор должен за долю секунды увидеть, какая
// строка сработала, — иначе он ищет её глазами по названию, а это то же
// самое переключение внимания, от которого мы уходим.
//
// Подсветка гаснет сама: если бы она оставалась, через десять сканов
// светилась бы вся ячейка и смысл пропал бы.

const JUST_MS = 6000;
let justTimer = null;

function markScanned(key) {
  state.lastScan = key ? { key, at: Date.now() } : null;
  clearTimeout(justTimer);
  if (!key) return;
  justTimer = setTimeout(() => {
    state.lastScan = null;
    renderWork();
  }, JUST_MS);
}

function isJustScanned(key) {
  const last = state.lastScan;
  return !!(last && last.key === key && Date.now() - last.at < JUST_MS);
}

function cellState(cellId) {
  if (!state.session.cells[cellId]) {
    state.session.cells[cellId] = { found: [], missing: [], extra: [], done: false };
  }
  const c = state.session.cells[cellId];
  c.found = c.found || [];
  c.missing = c.missing || [];
  c.extra = c.extra || [];
  return c;
}

function cellStatus(cellId) {
  const expected = state.byCell.get(cellId) || [];
  const c = state.session.cells[cellId];
  if (!c) return 'pending';
  if ((c.extra || []).length || (c.missing || []).length) return 'issues';
  if (c.done) return 'done';
  if ((c.found || []).length === 0) return 'pending';
  return (c.found || []).length >= expected.length ? 'done' : 'partial';
}

// ---------- список ячеек ----------

function renderCells() {
  const query = state.filter.trim().toLowerCase();
  const cells = [...state.byCell.keys()].sort((a, b) => {
    const d = a.length - b.length;               // 244 раньше 1244
    return d !== 0 ? d : a.localeCompare(b);
  });

  const visible = cells.filter(cellId => {
    if (!query) return true;
    if (cellId.includes(query)) return true;
    return (state.byCell.get(cellId) || []).some(r =>
      [fullNameOf(r), r.clientName, r.barcode, r.orderId, r.orderBarcode, r.pid]
        .filter(Boolean).join(' ').toLowerCase().includes(query));
  });

  el.cellList.replaceChildren();
  for (const cellId of visible) {
    const row = document.createElement('div');
    row.className = 'cell-row';
    if (cellId === state.activeCell) row.dataset.active = '1';

    const id = document.createElement('span');
    id.className = 'cell-row__id';
    id.textContent = cellId;

    const count = document.createElement('span');
    count.className = 'cell-row__count';
    const expected = (state.byCell.get(cellId) || []).length;
    const found = (state.session.cells[cellId]?.found || []).length;
    count.textContent = found ? `${found}/${expected}` : `${expected} шт`;

    const dot = document.createElement('span');
    dot.className = 'cell-row__dot';
    dot.dataset.status = cellStatus(cellId);

    row.append(id, count, dot);

    // Разметка со схемы зала. У стены стоит крупногабарит, и знать об этом
    // надо ДО того, как оператор пойдёт к полке с пустыми руками.
    const mark = state.planKind && state.planKind.get(cellId);
    if (mark && PLAN_LABEL[mark]) {
      const tag = document.createElement('span');
      tag.className = 'cell-row__mark';
      tag.dataset.mark = mark;
      tag.textContent = PLAN_LABEL[mark];
      tag.title = 'Помечено на схеме зала';
      row.insertBefore(tag, dot);
    }
    row.addEventListener('click', () => selectCell(cellId));
    el.cellList.appendChild(row);
  }

  if (!visible.length) {
    const none = document.createElement('div');
    none.style.cssText = 'padding:18px 12px;font-size:12px;color:var(--ink-faint);line-height:1.5';
    none.textContent = state.byCell.size
      ? 'Ничего не найдено'
      : 'Ячеек пока нет. Соберите данные: попап → Приёмка → «Собрать всё из WMS».';
    el.cellList.appendChild(none);
  }
}

// ---------- статистика ----------

function renderStats() {
  const total = state.byCell.size;
  const done = [...state.byCell.keys()].filter(c => state.session.cells[c]?.done).length;
  let found = 0, missing = 0, extra = 0;
  for (const c of Object.values(state.session.cells)) {
    found += (c.found || []).length;
    missing += (c.missing || []).length;
    extra += (c.extra || []).length;
  }
  el.statCells.textContent = `${done}/${total}`;
  el.statCells.dataset.state = total && done === total ? 'good' : '';
  const noCell = (state.noCell || []).length;
  if (el.statNoCell) {
    el.statNoCell.textContent = noCell;
    el.statNoCell.dataset.state = noCell ? 'bad' : '';
  }
  if (el.ledger) {
    const placed = state.records.length;
    const bits = [
      `На полке ${placed + noCell} позиций в ${state.shelfOrders || 0} заказах`,
      `в обходе ${placed} позиций в ${total} ячейках`
    ];
    if (noCell) {
      bits.push(`БЕЗ ЯЧЕЙКИ ${noCell} — они в обход не попадут: соберите ещё раз, WMS отдаёт ячейку не с первого запроса`);
    }
    // Пометка «такой ячейки нет» скрывает ячейку с обхода. Если по ней
    // что-то числится, товар исчезает из инвентаризации молча — а молчание
    // здесь неотличимо от недостачи.
    if (state.inMissing) {
      bits.push(`В ПОМЕЧЕННЫХ «НЕТ» ЯЧЕЙКАХ числится ${state.inMissing} — снимите пометку на схеме зала или найдите товар`);
    }
    // Сколько пустых ячеек справочника не попало в обход, потому что их нет
    // на схеме. Молчать об этом нельзя: если схема нарисована неполно,
    // оператор должен понимать, почему ячеек меньше, чем он ждал.
    if (state.showAllCells && state.notOnPlan) {
      bits.push(`не показаны ${state.notOnPlan} пустых ячеек справочника — их нет на схеме зала`);
    }
    el.ledger.textContent = bits.join(' · ') + '.';
    el.ledger.dataset.state = (noCell || state.inMissing) ? 'warn' : '';
  }
  el.statFound.textContent = found;
  el.statFound.dataset.state = found ? 'good' : '';
  el.statMissing.textContent = missing;
  el.statExtra.textContent = extra;
}

// ---------- рабочая область ----------

function selectCell(cellId) {
  state.activeCell = cellId;
  cellState(cellId);
  renderCells();
  renderWork();
  focusScanner();
}

function renderWork() {
  const cellId = state.activeCell;
  if (!cellId) {
    el.workEmpty.style.display = '';
    el.workBody.style.display = 'none';
    return;
  }

  const expected = state.byCell.get(cellId) || [];
  const session = cellState(cellId);

  el.workEmpty.style.display = 'none';
  el.workBody.style.display = '';
  el.workCell.textContent = cellId;
  el.workMeta.textContent =
    `ожидается ${expected.length} · найдено ${session.found.length}` +
    (session.missing.length ? ` · нет на месте ${session.missing.length}` : '') +
    (session.done ? ' · проверена' : '');

  el.items.replaceChildren();
  // ОДИНАКОВЫЕ ВЕЩИ — ОДНОЙ СТРОКОЙ С КОЛИЧЕСТВОМ.
  //
  // В одном коробе у одного заказа бывает четыре одинаковых товара. Раньше
  // это были четыре одинаковые строки подряд: оператор видел стену повторов
  // и не понимал, надо ли искать четыре штуки или это дубли в базе. Теперь
  // строка одна, а рядом «×4» и счёт «2 из 4» — сразу видно, сколько ещё
  // держать в руках. Отметки при этом остаются поштучными: каждая единица
  // считается отдельно, иначе инвентаризация перестала бы быть подсчётом.
  for (const group of groupSame(expected)) {
    const record = group[0];
    const keys = group.map(keyOf);
    const foundIn = keys.filter(k => session.found.includes(k));
    const missingIn = keys.filter(k => session.missing.includes(k));
    const allFound = foundIn.length === keys.length;

    const item = document.createElement('div');
    item.className = 'item';
    if (allFound) item.dataset.found = '1';
    if (missingIn.length && !foundIn.length) item.dataset.missing = '1';
    if (keys.some(isJustScanned)) {
      item.dataset.just = '1';
      // Ячейка может не помещаться на экран: подводим свежую строку к глазам,
      // иначе подсветка загорается там, куда оператор не смотрит.
      requestAnimationFrame(() => item.scrollIntoView({ block: 'nearest' }));
    }

    const box = document.createElement('span');
    box.className = 'item__box';
    box.textContent = allFound ? '✓' : (missingIn.length && !foundIn.length ? '✕' : '');
    box.title = keys.length > 1 ? 'Отметить одну единицу найденной' : 'Отметить найденным';
    box.addEventListener('click', () => toggleFoundGroup(keys));

    const main = document.createElement('div');
    main.className = 'item__main';
    const name = document.createElement('div');
    name.className = 'item__name';
    // Название берём из заказа, иначе из справочника товаров по ШК.
    // В справочнике WMS `title` — код поставщика («OILATAN-OILA43»), а
    // читаемое имя лежит в `name` (оно же description у WMS). Показываем
    // человеку название, а код оставляем в подсказке.
    const sku = record.barcode ? state.sku[record.barcode] : null;
    // «БЕЗ НАЗВАНИЯ» НИЧЕГО НЕ ГОВОРИТ, а тип посылки говорит всё: FBS
    // собирает продавец, партнёрская приходит чужой коробкой. Названия
    // товара у них нет и не будет — WMS его не знает. Показываем то, что
    // оператор видит на полке: «FBS», «UZUM-BANK», «Aliexpress».
    // ЧТО ЭТО ЗА КОРОБКА. У посылки целиком названия товара нет, зато есть
    // состав — и он говорит больше, чем «FBO». Название первого товара с
    // хвостом «и ещё N» опознаётся глазом за долю секунды; тип посылки
    // остаётся запасным, когда состава ещё нет.
    const inside0 = fbsItems(record);
    let title = record.itemName || (sku && (sku.name || sku.title)) || '';
    if (!title && inside0.length) {
      const first = inside0[0].name || nameByBarcode(inside0[0].barcode) || inside0[0].barcode;
      const rest = inside0.reduce((n, x) => n + (x.count || 1), 0) - 1;
      title = rest > 0 ? `${first} и ещё ${rest}` : first;
    }
    name.textContent = title || typeLabel(record) || 'Без названия';
    if (sku && sku.unit) name.title = sku.unit;
    if (keys.length > 1) {
      const qty = document.createElement('span');
      qty.className = 'item__qty';
      qty.textContent = `${foundIn.length} из ${keys.length}`;
      qty.dataset.state = allFound ? 'done' : '';
      qty.title = 'Одинаковых единиц в этой ячейке';
      name.appendChild(qty);
    }
    const codes = document.createElement('div');
    codes.className = 'item__codes';
    codes.textContent = [record.barcode, record.orderId, record.gm].filter(Boolean).join(' · ') || '—';
    if (sku && sku.needsIdentifier) {
      // Товар с обязательным идентификатором (IMEI и подобное): при выдаче
      // его сканируют отдельно, и перепутать такой товар дороже всего.
      const flag = document.createElement('span');
      flag.className = 'item__flag';
      flag.textContent = 'IMEI';
      flag.title = 'Требует идентификатор при выдаче';
      name.appendChild(flag);
    }
    main.append(name, codes);

    const client = document.createElement('span');
    client.className = 'item__client';
    client.textContent = record.clientName || '';

    const miss = document.createElement('button');
    miss.className = 'item__miss';
    miss.textContent = missingIn.length ? 'вернуть' : 'нет на месте';
    miss.addEventListener('click', () => toggleMissingGroup(keys));

    item.append(box, main, client, miss);
    el.items.appendChild(item);

    // СОСТАВ ПАКЕТА — только у посылок целиком (FBS и партнёрских).
    // У потоварной позиции состав и есть она сама, кнопке там делать нечего.
    //
    // У ЗАПЕЧАТАННЫХ ПАРТНЁРСКИХ — не показываем вовсе, пока состав пуст.
    // «Что внутри — неизвестно» верно, но бесполезно: содержимое такой
    // посылки не знает и сам WMS, вкладки «Товары» у неё нет, и открывать
    // её на ПВЗ никто не будет. Строчка, которая ничего не сообщает и
    // ничего не предлагает, — это шум на каждой второй позиции.
    const sealed = SEALED_PARTNERS.has(typeLabel(record));
    if ((isWholeOrder(record) || record.partner) && !(sealed && !inside0.length)) {
      // Ключ — ПОСЫЛКА: у заказа их бывает несколько, и в каждой своё.
      const orderId = packageKey(record) || String(record.orderId || record.orderBarcode || '');
      const inside = inside0;
      const open = state.openFbs.has(orderId);
      const units = inside.reduce((n, x) => n + (x.count || 1), 0);

      const toggle = document.createElement('button');
      toggle.className = 'item__inside';
      toggle.dataset.open = open ? '1' : '0';
      toggle.textContent = inside.length
        ? `${open ? '▾' : '▸'} что внутри · ${units}`
        : `${open ? '▾' : '▸'} что внутри — неизвестно`;
      toggle.title = 'Содержимое этой коробки';
      toggle.addEventListener('click', () => {
        if (open) state.openFbs.delete(orderId); else state.openFbs.add(orderId);
        renderWork();
      });
      codes.appendChild(toggle);

      if (open) {
        const panel = document.createElement('div');
        panel.className = 'inside';
        if (!inside.length) {
          const hint = document.createElement('div');
          hint.className = 'inside__hint';
          // Партнёрская посылка и FBS — разные случаи, и путать их нельзя:
          // у первой состава нет вообще нигде, у второй он просто ещё не
          // собран. Совет «соберите ещё раз» партнёрской не поможет.
          hint.textContent = record.partner || typeLabel(record) !== 'FBS'
            ? 'Состав такой посылки не знает и сам WMS — вкладки «Товары» у неё нет.'
            : 'Состав приедет со следующим сбором: попап → Приёмка → «Собрать всё из WMS».';
          panel.appendChild(hint);
        }
        for (const one of inside) {
          const row = document.createElement('div');
          row.className = 'inside__row';
          const bc = document.createElement('span');
          bc.className = 'inside__bc';
          bc.textContent = one.barcode;
          const nm = document.createElement('span');
          nm.className = 'inside__name';
          nm.textContent = one.name || nameByBarcode(one.barcode) || '—';
          const qty = document.createElement('span');
          qty.className = 'inside__qty';
          qty.textContent = (one.count || 1) > 1 ? `× ${one.count}` : '';
          bc.dataset.src = 'wms';
          bc.title = 'Из описи WMS';
          row.append(bc, nm, qty);
          panel.appendChild(row);
        }
        el.items.appendChild(panel);
      }
    }
  }

  if (!expected.length) {
    const none = document.createElement('div');
    none.style.cssText = 'padding:16px;font-size:12.5px;color:var(--ink-faint)';
    none.textContent = 'По данным WMS в этой ячейке ничего не числится.';
    el.items.appendChild(none);
  }

  el.extras.replaceChildren();
  el.extraWrap.style.display = session.extra.length ? '' : 'none';
  for (const entry of session.extra) {
    const row = document.createElement('div');
    row.className = 'extra';
    const code = document.createElement('span');
    code.className = 'extra__code';
    code.textContent = entry.code;
    const note = document.createElement('span');
    const extraName = entry.itemName || nameByBarcode(entry.code);
    note.textContent = entry.belongsTo
      ? `числится в ячейке ${entry.belongsTo}${extraName ? ` — ${extraName}` : ''}`
      : 'в собранных данных не найдено';
    const drop = document.createElement('button');
    drop.className = 'item__miss';
    drop.textContent = 'убрать';
    drop.addEventListener('click', () => {
      session.extra = session.extra.filter(e => e.code !== entry.code);
      saveSession(); renderWork(); renderStats(); renderCells();
    });
    row.append(code, note, drop);
    el.extras.appendChild(row);
  }

  el.scanHint.textContent = `${session.found.length}/${expected.length}`;
}

/**
 * Одинаковые позиции ячейки — в одну группу.
 *
 * «Одинаковые» это один и тот же товар одного заказа: тот же штрихкод и тот
 * же заказ. Разные заказы не сливаем, даже если товар тот же, — их отдают
 * разным людям, и путать их нельзя.
 */
function groupSame(records) {
  const by = new Map();
  for (const r of records) {
    // РАЗНЫЕ ПОСЫЛКИ ОДНОГО ЗАКАЗА — РАЗНЫЕ СТРОКИ. Это разные коробки с
    // разным содержимым; слить их в «1 из 2» значит показать оператору
    // состав чужой коробки.
    const id = [r.orderId || r.orderBarcode || '', r.wmsOrderId || '',
                r.barcode || fullNameOf(r) || ''].join('|');
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(r);
  }
  return [...by.values()];
}

/** Отметить ЕЩЁ ОДНУ единицу группы найденной; когда все — снять все. */
function toggleFoundGroup(keys) {
  const s = cellState(state.activeCell);
  const notFound = keys.filter(k => !s.found.includes(k));
  if (notFound.length) {
    const key = notFound[0];
    s.found.push(key);
    s.missing = s.missing.filter(k => k !== key);
    markScanned(key);
  } else {
    s.found = s.found.filter(k => !keys.includes(k));
  }
  saveSession(); renderWork(); renderStats(); renderCells();
}

/** «Нет на месте» — на всю группу разом: искать по одной штуке незачем. */
function toggleMissingGroup(keys) {
  const s = cellState(state.activeCell);
  const marked = keys.some(k => s.missing.includes(k));
  if (marked) {
    s.missing = s.missing.filter(k => !keys.includes(k));
  } else {
    for (const k of keys) if (!s.missing.includes(k)) s.missing.push(k);
    s.found = s.found.filter(k => !keys.includes(k));
  }
  saveSession(); renderWork(); renderStats(); renderCells();
}

// ---------- действия ----------

function toggleFound(key) {
  const s = cellState(state.activeCell);
  if (s.found.includes(key)) s.found = s.found.filter(k => k !== key);
  else { s.found.push(key); s.missing = s.missing.filter(k => k !== key); }
  saveSession(); renderWork(); renderStats(); renderCells();
}

function toggleMissing(key) {
  const s = cellState(state.activeCell);
  if (s.missing.includes(key)) s.missing = s.missing.filter(k => k !== key);
  else { s.missing.push(key); s.found = s.found.filter(k => k !== key); }
  saveSession(); renderWork(); renderStats(); renderCells();
}

// ------------------------------------------------------------------
// Слышимый ответ сканера
// ------------------------------------------------------------------
// Оператор держит коробку двумя руками и смотрит на полку, а не в экран.
// Цветная плашка ему не поможет — нужен звук: короткий высокий «принято»,
// низкий двойной «не туда». Отключается кнопкой и запоминается.

// ГРОМЧЕ И РЕЗЧЕ, ЧЕМ ХОЧЕТСЯ В ТИХОЙ КОМНАТЕ.
//
// Сигнал слушают не в наушниках, а в зале: гудит холодильник, ездит рохля,
// рядом разговаривают. Прежний звук был синусоидой на громкости 0.12 —
// мягкий, круглый и в зале почти неразличимый.
//
// Что изменено и почему:
//   * ФОРМА ВОЛНЫ — прямоугольная вместо синуса. У синуса одна частота, и
//     она тонет в шуме; у прямоугольной куча высоких обертонов, за счёт
//     которых писк «прорезается», как у кассового сканера.
//   * АТАКА — 3 мс вместо 10. Резкий фронт слышен как щелчок и заметен
//     даже боковым слухом; плавный воспринимается как «что-то загудело».
//   * ГРОМКОСТЬ — втрое выше, но через компрессор: он держит пик и не даёт
//     динамику захрипеть, поэтому звук именно громкий, а не искажённый.
let audioCtx = null;
let audioOut = null;

function audioChain() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  // Вкладку могли открыть до первого клика — тогда контекст спит.
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  if (!audioOut) {
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 6;
    comp.ratio.value = 12;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    const master = audioCtx.createGain();
    master.gain.value = 0.9;
    comp.connect(master).connect(audioCtx.destination);
    audioOut = comp;
  }
  return audioOut;
}

function tone(freqs, ms) {
  if (!state.sound) return;
  try {
    const out = audioChain();
    let at = audioCtx.currentTime;
    for (const f of freqs) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.38, at + 0.003);
      gain.gain.setValueAtTime(0.38, at + ms / 1000 * 0.7);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
      osc.connect(gain).connect(out);
      osc.start(at);
      osc.stop(at + ms / 1000 + 0.02);
      at += ms / 1000 + 0.035;
    }
  } catch (e) { /* без звука тоже работаем */ }
}

/**
 * ЗВУК ОШИБКИ ДОЛЖЕН БЫТЬ НЕПРИЯТНЫМ.
 *
 * Прежний «бад» был двумя чистыми тонами — низковато, но в целом musical,
 * и на слух почти не отличался от «принято». А отличать надо мгновенно и
 * не думая: ошибка означает «убери товар из рук», и она обязана резать ухо.
 *
 * Что делает звук противным:
 *   * ДВЕ ПИЛЫ ВРАЗНОБОЙ. Пила — самая «грязная» из простых форм. Две
 *     штуки на 233 и 330 Гц дают тритон, тот самый интервал, который в
 *     музыке веками называли неблагозвучным.
 *   * БИЕНИЯ. Вторая пара расстроена на 7 Гц: слышно «вау-вау», от
 *     которого хочется, чтобы оно поскорее прекратилось.
 *   * ТРЕМОЛО 17 Гц — дребезг, как у неисправного зуммера.
 * Длится вдвое дольше «принято»: короткий неприятный звук можно принять
 * за помеху, длинный — уже нет.
 */
function buzz() {
  if (!state.sound) return;
  try {
    const out = audioChain();
    const t0 = audioCtx.currentTime;
    const dur = 0.42;

    const shape = audioCtx.createGain();
    shape.gain.setValueAtTime(0.0001, t0);
    shape.gain.exponentialRampToValueAtTime(0.42, t0 + 0.004);
    shape.gain.setValueAtTime(0.42, t0 + dur - 0.06);
    shape.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    shape.connect(out);

    // Дребезг: быстрая амплитудная модуляция поверх всего сигнала.
    const trem = audioCtx.createOscillator();
    const tremGain = audioCtx.createGain();
    trem.type = 'square';
    trem.frequency.value = 17;
    tremGain.gain.value = 0.35;
    trem.connect(tremGain).connect(shape.gain);
    trem.start(t0);
    trem.stop(t0 + dur);

    for (const f of [233, 233 * 1.02, 330, 330 * 0.985]) {
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      g.gain.value = 0.25;
      osc.connect(g).connect(shape);
      osc.start(t0);
      osc.stop(t0 + dur);
    }
  } catch (e) { /* без звука тоже работаем */ }
}

/**
 * СКАЗАТЬ НОМЕР ЯЧЕЙКИ ВСЛУХ.
 *
 * Оператор держит коробку двумя руками и смотрит на полку, а не в экран.
 * Звук ошибки говорит «не туда», но не говорит КУДА, и за этим приходится
 * идти к монитору — то самое переключение внимания, от которого весь этот
 * экран и затевался.
 *
 * Говорим ПОСЛЕ звука ошибки, а не поверх него: буззер длится 0.42 с, и
 * наложенная на него речь не разбирается. Число называется целиком —
 * «двести двадцать пять», а не «два-два-пять»: поток цифр приходится
 * собирать в число в голове, а руки заняты.
 */
function speak(text) {
  if (!state.sound || !text) return;
  if (!('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'ru-RU';
    u.rate = 1.0;
    speechSynthesis.speak(u);
  } catch (e) { /* без голоса тоже работаем */ }
}

const BUZZ_MS = 460;   // длина звука ошибки: речь начинается после него

/** «Не та ячейка» — и сразу вслух, какая нужна. */
function sayCell(cellId) {
  if (!cellId) return;
  clearTimeout(sayCell._timer);
  sayCell._timer = setTimeout(() => speak(String(cellId)), BUZZ_MS);
}

const SOUNDS = {
  wait: () => tone([520], 70),         // ушёл вопрос в WMS
  ok: () => tone([1046], 90),          // принято
  warn: () => tone([680], 130),        // уже отмечено
  bad: buzz,                            // не туда / неизвестно / ошибка
  done: () => tone([784, 1046], 120)   // ячейка закрыта
};

function flash(kind, text) {
  if (SOUNDS[kind]) SOUNDS[kind]();
  el.flash.dataset.on = '1';
  el.flash.dataset.kind = kind;
  el.flash.textContent = text;
  clearTimeout(el.flash._timer);
  el.flash._timer = setTimeout(() => { el.flash.dataset.on = '0'; }, 4000);
}

// ---------- обработка скана ----------
// Одно поле на всё: сканер вводит строку и жмёт Enter. Что именно
// прочитали — код ячейки или код товара — решаем по содержимому, чтобы
// оператору не приходилось переключать режимы одной свободной рукой.

function handleScan(raw) {
  const code = normalizeScan(raw);
  if (!code) return;

  // 1. Код ячейки.
  const cellCode = resolveCell(code);
  if (cellCode && state.byCell.has(cellCode)) {
    // ПОВТОРНЫЙ УДАР ПО ТОЙ ЖЕ ЯЧЕЙКЕ — ЭТО «Я ЗАКОНЧИЛ ЗДЕСЬ».
    //
    // Оператор идёт вдоль стеллажа со сканером в руке. Тянуться к мыши,
    // чтобы нажать «Ячейка проверена», значит на каждой ячейке отрывать
    // руку от работы. Поэтому закрывает ячейку тот же скан, который её
    // открыл, — и по звуку сразу понятно, чем всё кончилось.
    if (cellCode === state.activeCell) { closeByRescan(cellCode); return; }
    selectCell(cellCode);
    flash('ok', `Ячейка ${cellCode}: ожидается ${(state.byCell.get(cellCode) || []).length} позиций`);
    return;
  }

  if (!state.activeCell) {
    flash('warn', 'Сначала выберите ячейку — или отсканируйте её код.');
    return;
  }

  const expected = state.byCell.get(state.activeCell) || [];
  const session = cellState(state.activeCell);

  // 2. Товар из этой ячейки — отмечаем найденным.
  // ПРИ ОДИНАКОВЫХ ТОВАРАХ КАЖДЫЙ СКАН СЧИТАЕТ СЛЕДУЮЩУЮ ЕДИНИЦУ.
  // Раньше брали первое совпадение, и второй удар по такому же товару
  // отвечал «уже отмечен» — четыре одинаковые вещи считались одной.
  let matches = expected.filter(r => codesOf(r).includes(code));

  // УЖЕ ВЫУЧЕННОЕ ВЛОЖЕНИЕ. Этот ШК однажды объяснился как содержимое
  // пакета — значит удар по нему и есть удар по пакету, и переспрашивать
  // WMS незачем: он о таких кодах не знает и не узнает.
  let viaFbs = null;
  if (!matches.length) {
    const owner = fbsOwnerOf(code);
    if (owner) {
      const byOrder = recordsOfPackage(expected, owner.id);
      if (byOrder.length) { matches = byOrder; viaFbs = owner; }
    }
  }

  const hit = matches.find(r => !session.found.includes(keyOf(r))) || matches[0];
  if (hit) {
    const key = keyOf(hit);
    markScanned(key);
    if (viaFbs) {
      flash('ok', `✓ ${code} — вложение пакета ${hit.pid || hit.orderId || ''}`.trim());
      if (!session.found.includes(key)) {
        session.found.push(key);
        session.missing = session.missing.filter(k => k !== key);
        saveSession();
      }
      renderWork(); renderStats(); renderCells();
      return;
    }
    if (session.found.includes(key)) {
      const total = matches.length;
      flash('warn', total > 1
        ? `${code} — все ${total} единицы уже отмечены`
        : `${code} — уже отмечен в этой ячейке`);
    } else {
      session.found.push(key);
      session.missing = session.missing.filter(k => k !== key);
      saveSession();
      const total = matches.length;
      const done = matches.filter(r => session.found.includes(keyOf(r))).length;
      flash('ok', `✓ ${fullNameOf(hit) || code}`
        + (total > 1 ? ` — ${done} из ${total}` : '')
        + (hit.clientName ? ` · ${hit.clientName}` : ''));
    }
    renderWork(); renderStats(); renderCells();
    return;
  }

  // 3. Товар есть в данных, но числится за другой ячейкой. Это и есть самая
  //    полезная находка инвентаризации: сразу говорим, куда его отнести.
  //
  // ВЛОЖЕНИЕ ЧУЖОГО ПАКЕТА тоже сюда: код не наш, но мы знаем, в какой
  // посылке он лежит и где стоит она. Молчать об этом — значит отправить
  // оператора искать несуществующее расхождение.
  const ownerElsewhere = fbsOwnerOf(code);
  if (ownerElsewhere) {
    const pack = recordsOfPackage(state.records, ownerElsewhere.id)[0];
    if (pack) {
      if (!session.extra.some(e => e.code === code)) {
        session.extra.push({ code, belongsTo: String(pack.cell || ''),
                             itemName: (ownerElsewhere.box.items[code] || {}).name || null,
                             at: Date.now() });
        saveSession();
      }
      flash('bad', `${code} — вложение пакета ${pack.pid || pack.orderId}`
        + (pack.cell ? `, он числится в ячейке ${pack.cell}` : ', ячейка у пакета не назначена'));
      sayCell(pack.cell);
      renderWork(); renderStats(); renderCells();
      return;
    }
  }

  const elsewhere = state.records.find(r => codesOf(r).includes(code));
  if (elsewhere) {
    if (!session.extra.some(e => e.code === code)) {
      session.extra.push({
        code, belongsTo: String(elsewhere.cell),
        itemName: fullNameOf(elsewhere) || null, at: Date.now()
      });
      saveSession();
    }
    flash('bad', `${code} лежит не там: числится в ячейке ${elsewhere.cell}`
      + (fullNameOf(elsewhere) ? ` (${fullNameOf(elsewhere)})` : ''));
    sayCell(elsewhere.cell);
    renderWork(); renderStats(); renderCells();
    return;
  }

  // 4. В собранной базе кода нет — СПРАШИВАЕМ WMS ЖИВЬЁМ.
  //
  // Раньше здесь всё заканчивалось словами «такого нет, обновите сбор».
  // Но это и есть самый важный случай: товар приехал после сбора, или это
  // потоварная позиция, которой в списках заказов нет вовсе. WMS умеет
  // отвечать по штрихкоду — вернёт и заказ, и ЯЧЕЙКУ, и статус.
  flash('wait', `${code} — спрашиваю WMS…`);
  chrome.runtime.sendMessage({ type: 'ucore:lookup-barcode', barcode: code }, (res) => {
    if (chrome.runtime.lastError || !res) {
      return retryScan(code, 'не удалось спросить WMS');
    }
    // РАССИНХРОН И ОБРЫВ — НЕ «ТОВАРА НЕТ».
    // WMS отдаёт то прошлый ответ, то ошибку. Записать это расхождением
    // значит отправить оператора искать товар, который у него в руках.
    if (!res.ok && res.retryable) return retryScan(code, res.reason);
    if (!res.ok) return recordUnknown(session, code, res.reason);

    const rec = { ...(res.record || {}), phase: res.kind || null };
    const cell = rec.cell ? String(rec.cell) : null;
    const where = res.kind === 'acceptance' ? 'на приёмке'
      : res.kind === 'return' ? 'в возвратах' : 'на выдаче';
    const shelf = shelfState(rec);

    // ЯЧЕЙКА ЕСТЬ — ЕЩЁ НЕ ЗНАЧИТ, ЧТО ВЕЩЬ НА ПОЛКЕ.
    // Выданный заказ ячейку не теряет: WMS помнит, где он лежал. Засчитать
    // такой заказ найденным — значит закрыть ячейку, в которой на вещь
    // меньше, чем получилось по счёту.
    if (cell && cell === String(state.activeCell) && shelf.onShelf) {
      const s2 = cellState(state.activeCell);
      const key = keyOf(rec);
      if (!s2.found.includes(key)) s2.found.push(key);
      markScanned(key);
      saveSession();
      flash('ok', `✓ ${fullNameOf(rec) || code} — новый товар, числится в этой ячейке`);
      load();
      return;
    }

    const s2 = cellState(state.activeCell);
    if (!s2.extra.some(e => e.code === code)) {
      s2.extra.push({ code, belongsTo: cell, itemName: fullNameOf(rec) || null,
                      status: rec.status || null, at: Date.now() });
      saveSession();
    }
    if (!shelf.onShelf) {
      // Это не находка и не «лежит не там»: этой вещи на полке быть не
      // должно вовсе. Звук ошибки, а не «уже отмечено».
      flash('bad', `${code}: НЕ СЧИТАЕТСЯ — ${shelf.why}`
        + ` (заказ ${rec.orderId || '—'} ${where}${cell ? `, ячейка ${cell}` : ''})`);
    } else if (cell) {
      flash('bad', `${code} лежит не там: числится в ячейке ${cell} (${where})`);
      sayCell(cell);
    } else {
      // Раньше здесь стоял `warn` — тот же звук, что у повторного удара.
      // «Ячейка не назначена» повторным ударом не является: это ошибка,
      // и звучать она обязана как ошибка.
      flash('bad', `${code}: заказ ${rec.orderId || '—'} ${where}, статус ${rec.status || '—'}, ячейка не назначена`);
    }
    load();
  });
  renderWork(); renderStats(); renderCells();
}

/**
 * Закрытие ячейки повторным сканом её кода.
 *
 * Сходится всё — закрываем и говорим об этом хорошим звуком. Не сходится —
 * НЕ закрываем и даём звук ошибки: закрыть ячейку с недостачей молча значит
 * похоронить расхождение. Оператор либо доищет товар, либо закроет её
 * кнопкой осознанно.
 */
function closeByRescan(cellId) {
  const expected = state.byCell.get(cellId) || [];
  const s = cellState(cellId);
  const missing = expected.filter(r => !s.found.includes(keyOf(r)));
  const extra = (s.extra || []).length;

  if (!missing.length && !extra) {
    s.done = true;
    s.doneAt = Date.now();
    saveSession();
    renderWork(); renderStats(); renderCells();
    flash('done', `Ячейка ${cellId} закрыта: всё сошлось, ${expected.length} позиций`);
    return;
  }

  const bits = [];
  if (missing.length) bits.push(`не найдено ${missing.length} из ${expected.length}`);
  if (extra) bits.push(`лишнее ${extra}`);
  flash('bad', `Ячейка ${cellId} НЕ закрыта: ${bits.join(', ')}`);
}

/**
 * Ответ, которому нельзя верить: WMS не ответил или ответил про другой
 * товар. Ничего не записываем — просим пикнуть ещё раз.
 */
function retryScan(code, reason) {
  flash('warn', `${code}: ПОВТОРИТЕ СКАН — ${reason || 'WMS не ответил'}`);
}

/** Код, которого нет ни у нас, ни в WMS. */
function recordUnknown(session, code, reason) {
  if (!session.extra.some(e => e.code === code)) {
    session.extra.push({ code, belongsTo: null, itemName: null,
                         status: reason || null, at: Date.now() });
  }
  saveSession();
  flash('bad', `${code} — ${reason || 'WMS о таком не знает'}`);
  renderWork(); renderStats(); renderCells();
}

function focusScanner() {
  // У каждого состояния экрана своё поле сканера, и фокус всегда должен
  // быть в том, которое сейчас видно. Скрытому полю фокус не отдать, а
  // сканер об этом не знает — он просто «печатает», и удар пропадает.
  if (typeof blind !== 'undefined' && blind.active) {
    if (blindEl.scan) blindEl.scan.focus();
    return;
  }
  if (el.scan && el.workBody.style.display !== 'none') { el.scan.focus(); return; }
  if (el.scanIdle) el.scanIdle.focus();
}

// До выбора ячейки сканер бьёт сюда: код ячейки открывает её сам.
if (el.scanIdle) {
  el.scanIdle.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = el.scanIdle.value;
    el.scanIdle.value = '';
    handleScan(value);
  });
  // Фокус обязан возвращаться сам: оператор кликает мимо, а сканер
  // продолжает «печатать» — и удар уходит в пустоту.
  el.scanIdle.addEventListener('blur', () => {
    setTimeout(() => {
      if (blind.active) return;
      if (el.workBody.style.display === 'none' && document.activeElement !== el.search) {
        el.scanIdle.focus();
      }
    }, 0);
  });
}

el.scan.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const value = el.scan.value;
  el.scan.value = '';
  // Одно и то же поле обслуживает оба режима: обычный разбор и слепой обход.
  // Сканер печатает вслепую, и переключать поля свободной рукой некому.
  if (typeof blind !== 'undefined' && blind.active) blindScan(value);
  else handleScan(value);
});

// Сканер печатает «в никуда», если фокус ушёл. Возвращаем его на поле при
// любом наборе, кроме случая, когда человек печатает в поиске слева.
document.addEventListener('keydown', (event) => {
  if (event.target === el.scan || event.target === el.search) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.length === 1 || event.key === 'Enter') focusScanner();
});

document.getElementById('btn-priemka').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('priemka.html') });
});

document.getElementById('btn-scan-focus').addEventListener('click', focusScanner);

function savePrefs() {
  chrome.storage.local.set({
    priemkaInvPrefs: { sound: state.sound, showAllCells: state.showAllCells }
  });
}

document.getElementById('btn-sound').addEventListener('click', () => {
  state.sound = !state.sound;
  const btn = document.getElementById('btn-sound');
  btn.textContent = state.sound ? '🔊 Звук' : '🔇 Без звука';
  btn.setAttribute('aria-pressed', String(state.sound));
  savePrefs();
  if (state.sound) SOUNDS.ok();
});

document.getElementById('btn-all-cells').addEventListener('click', () => {
  state.showAllCells = !state.showAllCells;
  const btn = document.getElementById('btn-all-cells');
  btn.setAttribute('aria-pressed', String(state.showAllCells));
  savePrefs();
  load();
});

// Следующая непроверенная ячейка. Оператор не выбирает мышью из трёхсот
// строк — он жмёт одну кнопку и идёт дальше по залу.
document.getElementById('btn-next-cell').addEventListener('click', () => {
  const order = [...state.byCell.keys()].sort((a, b) => {
    const d = a.length - b.length;
    return d !== 0 ? d : a.localeCompare(b);
  });
  const from = state.activeCell ? order.indexOf(state.activeCell) + 1 : 0;
  const rotated = order.slice(from).concat(order.slice(0, from));
  const next = rotated.find(c => !state.session.cells[c]?.done);
  if (!next) {
    flash('done', 'Непроверенных ячеек не осталось.');
    return;
  }
  selectCell(next);
  flash('ok', `Ячейка ${next}: ожидается ${(state.byCell.get(next) || []).length} позиций`);
});

document.getElementById('btn-done').addEventListener('click', () => {
  const s = cellState(state.activeCell);
  const expected = state.byCell.get(state.activeCell) || [];
  // Всё, что не отмечено найденным, при закрытии ячейки становится
  // недостачей — иначе «проверено» означало бы «я посмотрел», а не
  // «я сверил», и расхождения бы тихо терялись.
  for (const record of expected) {
    const key = keyOf(record);
    if (!s.found.includes(key) && !s.missing.includes(key)) s.missing.push(key);
  }
  s.done = true;
  s.doneAt = Date.now();
  saveSession();
  renderWork(); renderStats(); renderCells();
  flash(s.missing.length ? 'warn' : 'done',
    s.missing.length
      ? `Ячейка закрыта: ${s.missing.length} позиций отмечены как отсутствующие`
      : 'Ячейка сошлась полностью');
});

document.getElementById('btn-all-found').addEventListener('click', () => {
  const s = cellState(state.activeCell);
  s.found = (state.byCell.get(state.activeCell) || []).map(keyOf);
  s.missing = [];
  saveSession();
  renderWork(); renderStats(); renderCells();
});

document.getElementById('btn-clear-cell').addEventListener('click', () => {
  state.session.cells[state.activeCell] = { found: [], missing: [], extra: [], done: false };
  saveSession();
  renderWork(); renderStats(); renderCells();
});

document.getElementById('btn-reset').addEventListener('click', () => {
  if (!confirm('Сбросить весь ход инвентаризации?\n\nСобранные из WMS данные останутся, стирается только отметки проверки.')) return;
  state.session = { cells: {}, startedAt: null };
  chrome.storage.local.set({ [STORE_KEY]: state.session }, () => {
    renderWork(); renderStats(); renderCells();
  });
});

/** Выгрузка таблицы в CSV. BOM обязателен, иначе Excel покажет кракозябры. */
function downloadCsv(rows, baseName) {
  const csv = rows.map(r => r.map(v => {
    const text = String(v ?? '');
    return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(';')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  link.href = url;
  link.download = `${baseName}-${stamp}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- экспорт ----------

document.getElementById('btn-export').addEventListener('click', () => {
  const rows = [['Ячейка', 'Расхождение', 'Товар', 'ШК', 'Заказ', 'Клиент', 'Числится в ячейке']];

  for (const [cellId, session] of Object.entries(state.session.cells)) {
    const expected = state.byCell.get(cellId) || [];
    const byKey = new Map(expected.map(r => [keyOf(r), r]));

    for (const key of session.missing || []) {
      const r = byKey.get(key);
      if (!r) continue;
      rows.push([cellId, 'нет на месте', fullNameOf(r), r.barcode || '', r.orderId || '', r.clientName || '', '']);
    }
    for (const entry of session.extra || []) {
      rows.push([cellId, 'лишнее', entry.itemName || nameByBarcode(entry.code), entry.code, '', '', entry.belongsTo || 'неизвестно']);
    }
  }

  // Позиции без ячейки обходом не покрываются. Не показать их в выгрузке
  // значит тихо потерять их из инвентаризации — то же самое, что недостача,
  // только незаметная.
  for (const r of state.noCell || []) {
    rows.push(['—', 'нет ячейки в WMS', fullNameOf(r), r.barcode || '', r.orderId || '', r.clientName || '', '']);
  }

  if (rows.length === 1) {
    flash('ok', 'Расхождений нет — выгружать нечего.');
    return;
  }

  downloadCsv(rows, 'инвентаризация-расхождения');
  flash('ok', `Выгружено расхождений: ${rows.length - 1}`);
});

// ==================================================================
// СЛЕПОЙ ОБХОД (blind count)
// ==================================================================
// Как это устроено физически. Оператор идёт вдоль стеллажа, в руках товар
// и сканер, ноутбук стоит где-то сбоку. Смотреть в него между каждым
// сканом невозможно — а именно этим и занимается «обычная» инвентаризация
// в WMS: скан, взгляд на экран, разбор ответа, следующий скан.
//
// Здесь наоборот. Экран — это цвет, который видно краем глаза, и звук.
// Порядок жёсткий и всегда один и тот же:
//
//   скан ЯЧЕЙКИ  -> ячейка открыта
//   скан товаров -> зелёный писк за каждый, красный за чужой
//   скан ТОЙ ЖЕ ЯЧЕЙКИ -> ячейка закрыта, недостача посчитана
//
// Слепой он в прямом смысле: до закрытия ячейки оператор не видит, что в
// ней должно лежать. Это не мешает — это защита. Когда список перед
// глазами, глаз «замыливается» и отмечает то, чего на полке нет.
//
// Красный экран ЗАПИРАЕТ сканер: чужой товар надо сначала отложить, а не
// пикать дальше. Разблокировка — пробелом, осознанным действием.

const blindEl = {
  root: document.getElementById('blind'),
  state: document.getElementById('blind-state'),
  big: document.getElementById('blind-big'),
  sub: document.getElementById('blind-sub'),
  count: document.getElementById('blind-count'),
  lock: document.getElementById('blind-lock'),
  scan: document.getElementById('blind-scan')
};

const blind = {
  active: false,
  cell: null,          // открытая сейчас ячейка
  locked: false,       // красный экран: сканер заперт до подтверждения
  pendingCell: null,   // отсканировали другую ячейку, не закрыв текущую
  counted: 0,          // сколько позиций принято в этой ячейке за этот заход
  busy: false,         // ждём ответа WMS — второй скан в это время не теряем
  revert: null         // таймер возврата к спокойному экрану
};

/**
 * Код ячейки или нет — и какой именно.
 *
 * На полках наклейки бывают разные: голое «351», «0351» с нулём, «CELL-351»
 * с префиксом принтера. Оператору не объяснишь, что расширение понимает
 * только один из вариантов, поэтому смотрим на цифры и сверяем со
 * справочником ячеек WMS. Совпало со справочником — это ячейка; не
 * совпало — считаем товаром и идём обычным путём.
 */
function resolveCell(code) {
  const known = (cell) => state.byCell.has(cell) || (state.directory || []).includes(cell);
  if (known(code)) return code;
  const digits = String(code).replace(/\D+/g, '');
  if (!digits) return null;
  if (known(digits)) return digits;
  const trimmed = digits.replace(/^0+/, '');
  if (trimmed && trimmed !== digits && known(trimmed)) return trimmed;
  return null;
}

function blindShow(kind, stateText, big, sub, { lock = false } = {}) {
  // ЛЮБОЙ НОВЫЙ ЭКРАН ОТМЕНЯЕТ ОТЛОЖЕННЫЙ ВОЗВРАТ ПРЕДЫДУЩЕГО.
  // Сканы идут чаще, чем гаснет экран: без этого таймер прошлого скана
  // через полсекунды затирал предупреждение о текущем, и оператор видел
  // спокойный экран там, где только что была ошибка.
  clearTimeout(blind.revert);
  blind.revert = null;
  blind.locked = lock;
  blindEl.root.dataset.kind = kind;
  blindEl.state.textContent = stateText;
  blindEl.big.textContent = big;
  blindEl.sub.textContent = sub || '';
  blindEl.lock.hidden = !lock;
  blindEl.count.textContent = blind.cell
    ? `ячейка ${blind.cell} · принято ${blind.counted}`
    : '';
}

/** Вернуться к спокойному экрану через паузу — если ничего не случилось раньше. */
function blindRevert(ms) {
  clearTimeout(blind.revert);
  blind.revert = setTimeout(() => {
    blind.revert = null;
    if (!blind.locked) blindIdle();
  }, ms);
}

/** Спокойное состояние: либо ждём ячейку, либо стоим в открытой. */
function blindIdle() {
  if (blind.locked) return;
  if (!blind.cell) {
    blindShow('idle', 'Отсканируйте ячейку', '—', 'Сканер ждёт код ячейки');
  } else {
    blindShow('open', 'Ячейка открыта', blind.cell,
      'Сканируйте товар · тот же код ячейки закроет её');
  }
}

function blindEnter() {
  blind.active = true;
  blind.cell = null;
  blind.locked = false;
  blind.counted = 0;
  blindEl.root.hidden = false;
  blindIdle();
  SOUNDS.ok();
  focusScanner();
}

function blindExit() {
  if (blind.cell) {
    // Уйти, не закрыв ячейку, — значит оставить её недосчитанной, а на
    // отчёте увидеть недостачу там, где её нет. Спрашиваем прямо.
    const leave = confirm(
      `Ячейка ${blind.cell} не закрыта.\n\n`
      + `Принято позиций: ${blind.counted}.\n`
      + `Выйти и оставить её незакрытой? Отметки сохранятся, но ячейка не будет считаться проверенной.`);
    if (!leave) { focusScanner(); return; }
  }
  blind.active = false;
  blind.cell = null;
  blind.locked = false;
  blindEl.root.hidden = true;
  renderCells(); renderStats(); renderWork();
}

// ---------- журнал ----------
// Каждое действие обхода ложится в журнал: ячейка, код, что решили, когда.
// Без него любой спор про «а этот товар точно сканировали?» упирается в
// память оператора. Журнал ограничен по длине: хранилище у расширения
// маленькое, и историю уже один раз пришлось чинить из-за переполнения.

const JOURNAL_KEY = 'priemkaInvJournal';
const JOURNAL_MAX = 5000;
let journalQueue = [];
let journalTimer = null;

function journal(entry) {
  journalQueue.push({ at: Date.now(), cell: blind.cell || state.activeCell || null, ...entry });
  clearTimeout(journalTimer);
  journalTimer = setTimeout(flushJournal, 400);
}

function flushJournal() {
  if (!journalQueue.length) return;
  const batch = journalQueue;
  journalQueue = [];
  chrome.storage.local.get([JOURNAL_KEY], (data) => {
    const all = (data[JOURNAL_KEY] || []).concat(batch);
    const kept = all.length > JOURNAL_MAX ? all.slice(all.length - JOURNAL_MAX) : all;
    chrome.storage.local.set({ [JOURNAL_KEY]: kept });
  });
}

// ---------- открытие и закрытие ячейки ----------

function blindOpenCell(cellId) {
  blind.cell = cellId;
  blind.pendingCell = null;
  const s = cellState(cellId);
  // СЛЕПОЙ ОБХОД ПРОДОЛЖАЕТ ОБЫЧНЫЙ, А НЕ НАЧИНАЕТ ЗАНОВО.
  //
  // Ячейку могли частично проверить руками на обычном экране — эти отметки
  // никуда не делись, они в той же сессии. Считать их заново значит
  // заставить оператора искать то, что уже сосчитано, а на закрытии ячейки
  // объявить недостачей то, что лежит на полке.
  blind.counted = s.found.length;
  s.openedAt = Date.now();
  s.done = false;                       // повторный обход отменяет прошлое «проверено»
  saveSession();
  const expected = (state.byCell.get(cellId) || []).length;
  journal({ code: cellId, result: 'ячейка открыта',
            detail: blind.counted ? `уже отмечено ${blind.counted}` : null });
  SOUNDS.ok();
  blindShow('open', 'Ячейка открыта', cellId,
    blind.counted
      ? `уже отмечено ${blind.counted} из ${expected} — сканируйте остальное`
      : 'Сканируйте товар');
}

function blindCloseCell() {
  const cellId = blind.cell;
  const expected = state.byCell.get(cellId) || [];
  const s = cellState(cellId);

  // Всё, чего не коснулись, — недостача. «Закрыл» значит «сверил», иначе
  // закрытие ячейки не значит ничего.
  for (const record of expected) {
    const key = keyOf(record);
    if (!s.found.includes(key) && !s.missing.includes(key)) s.missing.push(key);
  }
  s.done = true;
  s.doneAt = Date.now();
  saveSession();

  const short = s.missing.length;
  const extra = (s.extra || []).length;
  journal({ code: cellId, result: 'ячейка закрыта',
            detail: `принято ${blind.counted}, недостача ${short}, лишнее ${extra}` });

  blind.cell = null;
  blind.pendingCell = null;

  if (short) {
    SOUNDS.bad();
    blindShow('bad', 'Ячейка закрыта · НЕ ХВАТАЕТ', String(short),
      `в ячейке ${cellId} не найдено ${short} из ${expected.length}`, { lock: true });
  } else {
    SOUNDS.done();
    blindShow('done', 'Ячейка сошлась', cellId,
      `принято ${blind.counted} из ${expected.length}` + (extra ? ` · лишнее ${extra}` : ''));
    blindRevert(1400);
  }
  renderCells(); renderStats(); renderWork();
}

// ---------- разбор скана в режиме обхода ----------

function blindScan(raw) {
  const code = normalizeScan(raw);
  if (!code) return;

  // Заперто красным — принимаем только подтверждение, не товар.
  if (blind.locked) {
    SOUNDS.warn();
    blindEl.sub.textContent = 'Сначала нажмите пробел — товар надо отложить';
    return;
  }
  if (blind.busy) { SOUNDS.warn(); return; }

  // 1. Код ячейки
  const cellCode = resolveCell(code);
  if (cellCode) {
    if (!blind.cell) { blindOpenCell(cellCode); return; }
    if (cellCode === blind.cell) { blindCloseCell(); return; }

    // Другая ячейка при открытой. Один раз предупреждаем, второй скан
    // того же кода принимаем как «да, закрываем и идём дальше».
    if (blind.pendingCell === cellCode) {
      blindCloseCell();
      blindOpenCell(cellCode);
      return;
    }
    blind.pendingCell = cellCode;
    SOUNDS.warn();
    journal({ code: cellCode, result: 'попытка перейти, ячейка не закрыта' });
    blindShow('warn', `Ячейка ${blind.cell} не закрыта`, blind.cell,
      `Отсканируйте ${cellCode} ещё раз, чтобы закрыть ${blind.cell} и перейти`);
    return;
  }

  if (!blind.cell) {
    SOUNDS.warn();
    journal({ code, result: 'товар без открытой ячейки' });
    blindShow('warn', 'Сначала ячейка', '?', 'Отсканируйте код ячейки, потом товар');
    return;
  }

  const expected = state.byCell.get(blind.cell) || [];
  const s = cellState(blind.cell);

  // 2. Товар этой ячейки
  const matches = expected.filter(r => codesOf(r).includes(code));
  const hit = matches.find(r => !s.found.includes(keyOf(r))) || matches[0];
  if (hit) {
    const key = keyOf(hit);
    markScanned(key);
    if (s.found.includes(key)) {
      SOUNDS.warn();
      journal({ code, result: 'повторный скан' });
      blindShow('warn', 'Уже считан', String(blind.counted), fullNameOf(hit) || code);
      blindRevert(900);
      return;
    }
    s.found.push(key);
    s.missing = s.missing.filter(k => k !== key);
    blind.counted++;
    saveSession();
    journal({ code, result: 'принято', detail: fullNameOf(hit) || null });
    SOUNDS.ok();
    blindShow('ok', 'Принято', String(blind.counted),
      `${fullNameOf(hit) || code}${expected.length ? ` · ${s.found.length} из ${expected.length}` : ''}`);
    blindRevert(700);
    renderCells(); renderStats(); renderWork();
    return;
  }

  // 3. Товар известен, но числится за другой ячейкой — главная находка
  //    инвентаризации. Красный, номер нужной ячейки во весь экран, замок.
  const elsewhere = state.records.find(r => codesOf(r).includes(code));
  if (elsewhere) {
    if (!s.extra.some(e => e.code === code)) {
      s.extra.push({ code, belongsTo: String(elsewhere.cell),
                     itemName: fullNameOf(elsewhere) || null, at: Date.now() });
      saveSession();
    }
    journal({ code, result: 'не та ячейка', detail: `числится в ${elsewhere.cell}` });
    SOUNDS.bad();
    // Экран оператор не видит — он смотрит на полку. Номер нужной ячейки
    // называем вслух, сразу после звука ошибки.
    sayCell(elsewhere.cell);
    blindShow('bad', 'НЕ ТА ЯЧЕЙКА · отнести в', String(elsewhere.cell),
      fullNameOf(elsewhere) || code, { lock: true });
    renderCells(); renderStats(); renderWork();
    return;
  }

  // 4. Кода нет в собранной базе — спрашиваем WMS живьём.
  //    Именно здесь живёт потоварка: у таких позиций в списках заказов
  //    штрихкода товара нет вовсе, и узнать ячейку можно только так.
  blind.busy = true;
  SOUNDS.wait();
  blindShow('warn', 'Спрашиваю WMS', '…', code);
  chrome.runtime.sendMessage({ type: 'ucore:lookup-barcode', barcode: code }, (res) => {
    blind.busy = false;
    const answer = res || { ok: false, retryable: true, reason: 'нет ответа от расширения' };

    // РАССИНХРОН И ОБРЫВ — НЕ «ТОВАРА НЕТ».
    // WMS регулярно отдаёт прошлый ответ или падает. Записать это как
    // недостачу значит отправить оператора искать то, что лежит в руках.
    if (!answer.ok && answer.retryable) {
      journal({ code, result: 'повторите скан', detail: answer.reason || null });
      SOUNDS.bad();
      blindShow('warn', 'ПОВТОРИТЕ СКАН', '↻', answer.reason || 'WMS не ответил', { lock: true });
      return;
    }
    if (!answer.ok) {
      if (!s.extra.some(e => e.code === code)) {
        s.extra.push({ code, belongsTo: null, itemName: null,
                       status: answer.reason || null, at: Date.now() });
        saveSession();
      }
      journal({ code, result: 'WMS не знает', detail: answer.reason || null });
      SOUNDS.bad();
      blindShow('bad', 'WMS НЕ ЗНАЕТ', '?', answer.reason || code, { lock: true });
      renderCells(); renderStats(); renderWork();
      return;
    }

    const rec = { ...(answer.record || {}), phase: answer.kind || null };
    const cell = rec.cell ? String(rec.cell) : null;
    const shelf = shelfState(rec);

    // ЯЧЕЙКА ЕСТЬ — ЕЩЁ НЕ ЗНАЧИТ, ЧТО ВЕЩЬ НА ПОЛКЕ: выданный заказ
    // ячейку не теряет. Считать его найденным — прятать недостачу.
    if (!shelf.onShelf) {
      if (!s.extra.some(e => e.code === code)) {
        s.extra.push({ code, belongsTo: cell, itemName: fullNameOf(rec) || null,
                       status: rec.status || null, at: Date.now() });
        saveSession();
      }
      journal({ code, result: 'не считается', detail: shelf.why || rec.status || null });
      SOUNDS.bad();
      blindShow('bad', 'НЕ СЧИТАЕТСЯ', '!',
        `${shelf.why} · заказ ${rec.orderId || '—'}`, { lock: true });
      renderCells(); renderStats(); renderWork();
      load();
      return;
    }

    if (cell && cell === String(blind.cell)) {
      const key = keyOf(rec);
      if (!s.found.includes(key)) s.found.push(key);
      markScanned(key);
      blind.counted++;
      saveSession();
      journal({ code, result: 'принято (живой поиск)', detail: rec.orderId || null });
      SOUNDS.ok();
      blindShow('ok', 'Принято', String(blind.counted),
        `${fullNameOf(rec) || code} · этой ячейки`);
      blindRevert(700);
      load();
      return;
    }

    if (!s.extra.some(e => e.code === code)) {
      s.extra.push({ code, belongsTo: cell, itemName: fullNameOf(rec) || null,
                     status: rec.status || null, at: Date.now() });
      saveSession();
    }
    SOUNDS.bad();
    if (cell) {
      journal({ code, result: 'не та ячейка (живой поиск)', detail: `числится в ${cell}` });
      sayCell(cell);
      blindShow('bad', 'НЕ ТА ЯЧЕЙКА · отнести в', cell, fullNameOf(rec) || code, { lock: true });
    } else {
      journal({ code, result: 'ячейка не назначена', detail: rec.status || null });
      blindShow('bad', 'ЯЧЕЙКА НЕ НАЗНАЧЕНА', '!',
        `заказ ${rec.orderId || '—'} · статус ${rec.status || '—'}`, { lock: true });
    }
    load();
  });
}

// ---------- клавиши обхода ----------

document.addEventListener('keydown', (event) => {
  if (!blind.active) return;
  if (event.key === 'Escape') { event.preventDefault(); blindExit(); return; }
  if (event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    if (blind.locked) { blind.locked = false; blindEl.lock.hidden = true; blindIdle(); }
    return;
  }
}, true);

blindEl.scan.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const value = blindEl.scan.value;
  blindEl.scan.value = '';
  blindScan(value);
});

// Фокус в обходе обязан возвращаться сам: оператор кликает мимо, окно
// теряет фокус, сканер продолжает «печатать». Держим поле активным.
blindEl.scan.addEventListener('blur', () => {
  if (blind.active) setTimeout(() => { if (blind.active) blindEl.scan.focus(); }, 0);
});

document.getElementById('btn-blind').addEventListener('click', () => {
  if (blind.active) blindExit(); else blindEnter();
});

// ---------- выгрузка журнала ----------

document.getElementById('btn-journal').addEventListener('click', () => {
  flushJournal();
  setTimeout(() => {
    chrome.storage.local.get([JOURNAL_KEY], (data) => {
      const list = data[JOURNAL_KEY] || [];
      if (!list.length) { flash('warn', 'Журнал пуст — обход ещё не начинали.'); return; }
      const rows = [['Время', 'Ячейка', 'Код', 'Результат', 'Подробности']];
      for (const e of list) {
        rows.push([
          new Date(e.at).toLocaleString('ru-RU'),
          e.cell || '', e.code || '', e.result || '', e.detail || ''
        ]);
      }
      downloadCsv(rows, 'инвентаризация-журнал');
      flash('ok', `Журнал выгружен: ${list.length} записей`);
    });
  }, 450);
});

el.search.addEventListener('input', () => {
  state.filter = el.search.value;
  renderCells();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Схема зала и пометки ячеек правятся в СОСЕДНЕЙ вкладке. Без этого
  // оператор менял разметку и не видел изменений на обходе, пока не
  // перезагружал страницу, — и справедливо считал, что правка не работает.
  if ('priemkaRecords' in changes || 'pvzLayout' in changes
      || 'priemkaMissingCells' in changes || 'priemkaSku' in changes) load();
  // Составы приезжают сбором из соседней вкладки. Полную перезагрузку тут
  // делать нельзя — мы и сами пишем сюда при каждой привязке и затирали бы
  // собственный экран; достаточно подменить данные и перерисовать.
  if ('priemkaFbsContents' in changes) {
    state.fbs = changes.priemkaFbsContents.newValue || {};
    if (state.activeCell) renderWork();
  }
});

load();
