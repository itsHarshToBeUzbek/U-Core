/**
 * Полноэкранная приёмка.
 *
 * Зачем отдельная страница, а не попап. Попап Chrome узкий, закрывается от
 * любого клика мимо и режет список: показывалось 300 строк из тысячи, и
 * оператор не мог убедиться, что видит всё. Здесь список полный, шрифт
 * крупный, а действие ровно одно и заметное — «Начать приёмку».
 *
 * Режим приёмки. Оператор идёт по позициям, у которых ЕСТЬ ячейка, и
 * раскладывает их. Экран показывает одну позицию разом: номер ячейки
 * огромными цифрами, название товара, штрихкод. Номер ячейки при этом
 * ПРОГОВАРИВАЕТСЯ вслух — оператор идёт по залу с коробкой и слушает,
 * а не всматривается в экран. Говорит синтез речи браузера; если его нет,
 * остаётся короткий сигнал.
 *
 * Страница ничего не меняет в WMS: только читает собранное расширением.
 */

import { sizeTierFromDimensions } from './allocation-core.js';

const parser = () => globalThis.UCoreWmsParse;

const KEYS = ['priemkaRecords', 'priemkaCells', 'priemkaSku', 'priemkaMissingCells',
              'priemkaSync', 'skuNameCache'];

const state = {
  records: [],
  cells: [],
  sku: {},
  names: {},          // готовые переводы: штрихкод -> { text, src, by }
  missing: new Set(),
  queue: [],          // позиции режима приёмки
  at: -1,             // текущий индекс в очереди
  running: false,
  sound: true,
  done: new Set()     // ключи уже разложенных позиций
};

const el = (id) => document.getElementById(id);
const ui = {
  rows: el('rows'), empty: el('empty'), foot: el('foot'), note: el('note'),
  q: el('q'), src: el('src'), mode: el('mode'), shown: el('shown'),
  thRec: el('th-rec'),
  start: el('btn-start'), next: el('btn-next'), stop: el('btn-stop'),
  sound: el('btn-sound'), sync: el('btn-sync'), exp: el('btn-export'),
  run: el('run'), runCell: el('run-cell'), runName: el('run-name'),
  runSub: el('run-sub'), runCount: el('run-count'), runRepeat: el('run-repeat'),
  sTotal: el('s-total'), sCell: el('s-cell'), sNoCell: el('s-nocell'),
  sCells: el('s-cells'), sGm: el('s-gm'), sNamed: el('s-named'), sIncoming: el('s-incoming'), sGone: el('s-gone')
};

// ------------------------------------------------------------------
// Озвучка ячейки
// ------------------------------------------------------------------
// Говорит синтез речи браузера (ru-RU); если его нет — короткий писк.
//
// Раньше первым уровнем шли mp3-файлы sounds/<цифра>.mp3: считалось, что
// живой голос разборчивее. На деле их никто не записал, каждый номер ячейки
// сначала пытался проиграть десяток несуществующих файлов, ждал их отказа и
// только потом говорил — озвучка отставала от шага оператора. Синтез
// произносит число целиком и сразу, поэтому файлов больше нет.
//
// ЧИСЛО НАЗЫВАЕТСЯ ЦЕЛИКОМ: «двести двадцать пять», а не «два-два-пять».
// Сначала было наоборот — по цифрам казалось разборчивее. На практике вышло
// хуже: поток цифр приходится собирать в число в голове, а руки в этот
// момент заняты коробкой. Целое число слышится как одно слово и совпадает
// с тем, что написано на полке.

let audioCtx = null;

function speak(text) {
  if (!('speechSynthesis' in window)) return false;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.lang = 'ru-RU';
    u.rate = 1.0;
    speechSynthesis.speak(u);
    return true;
  } catch (e) {
    return false;
  }
}

function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch (e) { /* совсем без звука — не беда */ }
}

function announce(cellId) {
  if (!state.sound || !cellId) return;
  if (!speak(String(cellId))) beep();
}

// ------------------------------------------------------------------
// Данные
// ------------------------------------------------------------------

function skuOf(record) {
  return record.barcode ? state.sku[record.barcode] : null;
}

function fullNameOf(record) {
  if (record.itemName) return record.itemName;
  const sku = skuOf(record);
  return (sku && (sku.name || sku.title)) || '';
}

/**
 * Короткое русское название; оригинал остаётся в подсказке и в поиске.
 *
 * Источников два, и порядок между ними один: сохранённый перевод модели, а
 * если его нет или он про другое название — словарь. Решение принимает
 * displayName в sku-name.js, чтобы список и попап не разошлись во мнениях.
 */
function nameOf(record) {
  const full = fullNameOf(record);
  if (!full) return '';
  const lib = globalThis.UCoreSkuName;
  if (!lib) return full;
  return lib.displayName(full, state.names[record.barcode]).text || full;
}

function load() {
  chrome.storage.local.get(KEYS, (data) => {
    state.records = data.priemkaRecords || [];
    state.cells = (data.priemkaCells || []).map(String);
    state.sku = data.priemkaSku || {};
    state.names = data.skuNameCache || {};
    state.missing = new Set((data.priemkaMissingCells || []).map(String));
    render();
  });
}

function filtered() {
  const q = ui.q.value.trim().toLowerCase();
  const src = ui.src.value;
  const mode = ui.mode.value;

  return state.records.filter((r) => {
    if (src) {
      const key = r.partner ? `partner:${r.partner}` : (r.source || 'unknown');
      if (key !== src) return false;
    }
    const named = !!nameOf(r);
    // «БЕЗ ЯЧЕЙКИ» — ЭТО ПРО ПОЛКУ, А НЕ ПРО КОРОБА.
    //
    // Счётчик сверху всегда считал только полку, а фильтр — нет: в список
    // попадали ещё и позиции грузомест, у которых ячейки не может быть в
    // принципе. Оператор видел «600 без ячейки» при 256 к приёмке и не мог
    // понять, кому верить. Теперь и счётчик, и список означают одно и то же.
    if (mode === 'cell' && !r.cell) return false;
    if (mode === 'nocell' && (r.cell || r.source === 'cargo')) return false;
    if (mode === 'incoming' && r.source !== 'cargo') return false;
    if (mode === 'incoming' && r.gone) return false;
    if (mode === 'gone' && !r.gone) return false;
    if (mode !== 'gone' && mode !== 'all' && r.gone) return false;
    if (mode === 'named' && !named) return false;
    if (mode === 'unnamed' && named) return false;
    if (!q) return true;
    // Ищем и по короткому названию, и по оригиналу: оператор набирает то
    // «мыло», то «sovun» — смотря что у него перед глазами.
    return [r.cell, r.orderId, r.orderBarcode, r.pid, r.barcode, r.gm, r.clientName,
            r.phone, nameOf(r), fullNameOf(r), r.partner]
      .some((v) => v && String(v).toLowerCase().includes(q));
  });
}

const SRC = { fbo: 'FBO', fbs: 'FBS', partner: 'Партнёр', cargo: 'Грузоместо', csv: 'CSV', unknown: '—' };

/**
 * Что показывать в графе «Источник».
 *
 * Тип (FBO/FBS) и партнёр (uzum-bank, JOOM, AliExpress, Uzum Global) —
 * РАЗНЫЕ вещи: партнёрский заказ приходит как FBO с кодом партнёра.
 * Оператору важнее партнёр — по нему отличается и упаковка, и порядок
 * выдачи, — поэтому показываем его, а тип оставляем в подсказке.
 */
function sourceLabel(record) {
  if (record.partner) return String(record.partner).toUpperCase();
  return SRC[record.source] || record.source || '—';
}

function sourceTitle(record) {
  const bits = [];
  if (record.partner) bits.push(`партнёр: ${record.partner}`);
  if (record.source) bits.push(`тип: ${SRC[record.source] || record.source}`);
  return bits.join(' · ');
}

function td(text, cls) {
  const cell = document.createElement('td');
  if (cls) cell.className = cls;
  if (text === null || text === undefined || text === '') {
    cell.textContent = '—';
    cell.classList.add('muted');
  } else {
    cell.textContent = String(text);
  }
  return cell;
}

function render() {
  const rows = filtered();

  ui.rows.replaceChildren();
  // Полный список без урезания — ради этого страница и сделана. Тысячи
  // строк рисуются во фрагменте, чтобы не дёргать вёрстку на каждой.
  const frag = document.createDocumentFragment();

  for (const r of rows) {
    const tr = document.createElement('tr');
    const key = parser().recordKey(r);
    if (state.done.has(key)) tr.dataset.done = '1';
    // Заказ, которого WMS больше не показывает: клиент забрал. Строку не
    // прячем — оператор должен видеть, что было и куда делось, — но
    // помечаем, чтобы её не искали на полке.
    if (r.gone) { tr.dataset.gone = '1'; tr.title = r.goneStatus || 'выдан или убыл'; }

    tr.appendChild(td(r.cell, 'c-cell'));
    if (ui.thRec.style.display !== 'none') tr.appendChild(td('', 'rec'));
    tr.appendChild(td(r.orderId || r.orderBarcode, 'c-mono'));
    tr.appendChild(td(r.pid, 'c-mono'));
    tr.appendChild(td(r.barcode, 'c-mono'));

    const sku = skuOf(r);
    const nameTd = document.createElement('td');
    nameTd.className = 'c-name';
    const name = nameOf(r);
    const fullName = fullNameOf(r);
    if (name) {
      nameTd.textContent = name;
      // Оригинал WMS — по наведению: он длинный и по-узбекски, но именно он
      // написан на коробке, и иногда сверять надо именно с ним.
      if (fullName && fullName !== name) nameTd.title = fullName;
      if (sku && sku.needsIdentifier) {
        const f = document.createElement('span');
        f.className = 'flag'; f.textContent = 'IMEI';
        f.title = 'Требует идентификатор при выдаче';
        nameTd.appendChild(f);
      }
      if (sku && (sku.unit || sku.length)) {
        const small = document.createElement('small');
        const dims = sku.length ? `${sku.length}×${sku.width}×${sku.height} мм` : '';
        const tier = sizeTierFromDimensions(sku);
        // ВЕС WMS НЕ ОТДАЁТ. Заявленный в названии берём как есть, остальное
        // считаем по объёму — и помечаем тильдой, чтобы оценку не приняли
        // за факт.
        const lib = globalThis.UCoreSkuName;
        const weight = lib ? lib.weightText(lib.weightKg(sku, fullName)) : '';
        small.textContent = [sku.unit, dims, tier, weight].filter(Boolean).join(' · ');
        nameTd.appendChild(small);
      }
    } else {
      // НАЗВАНИЯ НЕТ И НЕ БУДЕТ — но тип посылки известен всегда.
      // FBS собирает продавец, партнёрская приезжает чужой коробкой; WMS
      // содержимого не знает. Прочерк не говорит ничего, «FBS» и
      // «UZUM-BANK» говорят, что оператор держит в руках.
      const kind = globalThis.UCoreWmsParse.typeLabel(r);
      nameTd.textContent = kind || '—';
      nameTd.classList.add('muted');
      if (kind) nameTd.title = 'Название товара WMS для таких заказов не отдаёт: это посылка целиком';
    }
    tr.appendChild(nameTd);

    tr.appendChild(td(r.clientName || r.phone));
    tr.appendChild(td(r.gm, 'c-mono'));

    const srcTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.dataset.src = r.partner ? 'partner' : (r.source || 'unknown');
    badge.textContent = sourceLabel(r);
    badge.title = sourceTitle(r);
    srcTd.appendChild(badge);
    tr.appendChild(srcTd);

    const actTd = document.createElement('td');
    if (r.cell) {
      const btn = document.createElement('button');
      btn.className = 'row-btn';
      btn.textContent = state.missing.has(String(r.cell)) ? 'ячейки нет ✓' : 'нет такой ячейки';
      btn.title = 'Пометить ячейку как физически отсутствующую — её перестанут предлагать и спрашивать при инвентаризации';
      btn.addEventListener('click', () => toggleMissing(String(r.cell)));
      actTd.appendChild(btn);
    }
    tr.appendChild(actTd);

    frag.appendChild(tr);
  }
  ui.rows.appendChild(frag);

  ui.empty.style.display = state.records.length ? 'none' : 'block';
  ui.shown.textContent = rows.length === state.records.length
    ? `показаны все ${rows.length}`
    : `показано ${rows.length} из ${state.records.length}`;

  // ---------- счётчики ----------
  // Позиции из грузомест считаем отдельно: короб ещё не принят, ячейки у
  // них не может быть в принципе, и мешать их с товаром на полке — значит
  // показывать «без ячейки 750» там, где на полке всё в порядке.
  const shelf = state.records.filter((r) => r.source !== 'cargo' && !r.gone);
  const gone = state.records.filter((r) => r.gone);
  const incoming = state.records.filter((r) => r.source === 'cargo');
  const withCell = shelf.filter((r) => r.cell).length;
  const named = state.records.filter((r) => nameOf(r)).length;
  ui.sTotal.textContent = shelf.length;
  ui.sCell.textContent = withCell;
  ui.sNoCell.textContent = shelf.length - withCell;
  if (ui.sIncoming) ui.sIncoming.textContent = incoming.length;
  if (ui.sGone) ui.sGone.textContent = gone.length;
  ui.sCells.textContent = new Set(state.records.map((r) => r.cell).filter(Boolean)).size;
  ui.sGm.textContent = new Set(state.records.map((r) => r.gm).filter(Boolean)).size;
  ui.sNamed.textContent = named;

  // ---------- фильтр источников ----------
  // В фильтре перечисляем и типы, и партнёров: оператор ищет «покажи
  // только uzum-bank», а не «покажи только FBO».
  const sources = [...new Set(state.records.map((r) => r.partner
    ? `partner:${r.partner}` : (r.source || 'unknown')))].sort();
  if (sources.join(',') !== (ui.src.dataset.built || '')) {
    const current = ui.src.value;
    ui.src.replaceChildren();
    const all = document.createElement('option');
    all.value = ''; all.textContent = 'Все источники';
    ui.src.appendChild(all);
    for (const s of sources) {
      const o = document.createElement('option');
      o.value = s;
      o.textContent = s.startsWith('partner:') ? s.slice(8).toUpperCase() : (SRC[s] || s);
      ui.src.appendChild(o);
    }
    ui.src.dataset.built = sources.join(',');
    ui.src.value = sources.includes(current) ? current : '';
  }

  // ---------- подсказки ----------
  const noName = state.records.filter((r) => r.barcode && !nameOf(r)).length;
  const missingCount = state.missing.size;
  const bits = [];
  if (noName) bits.push(`${noName} позиций без названия — справочник товаров подтянется при следующем сборе`);
  if (missingCount) bits.push(`${missingCount} ячеек помечены как отсутствующие`);
  ui.note.textContent = bits.join('. ');
  ui.note.dataset.on = bits.length ? '1' : '0';

  // Числа под таблицей — те же, что на вкладках WMS, чтобы сверять глазами:
  //   «Товары К выдаче» = FBO + FBS без партнёров
  //   «Заказы К выдаче» = то же плюс партнёрские
  const orderIds = (list) => new Set(list.map((r) => String(r.orderId || r.orderBarcode)).filter(Boolean));
  const b2c = orderIds(shelf.filter((r) => !r.partner));
  const partnerOrders = orderIds(shelf.filter((r) => r.partner));
  const allOrders = orderIds(shelf);
  // СТРОК И ЗАКАЗОВ — РАЗНОЕ КОЛИЧЕСТВО, и это надо видеть.
  // У потоварной выдачи один заказ лежит несколькими единицами, иногда в
  // разных ячейках. Оператор пересчитывает ЕДИНИЦЫ на полке, а на вкладке
  // WMS видит своё число, — показываем обе меры, чтобы не гадать.
  const units = (list) => globalThis.UCoreWmsParse.countUnits(list);
  const b2cLines = units(shelf.filter((r) => !r.partner));
  ui.foot.textContent =
    `На полке единиц: ${units(shelf)} (без партнёров ${b2cLines}). `
    + `Заказов: «Товары» ${b2c.size} + партнёров ${partnerOrders.size} = «Заказы» ${allOrders.size}. `
    + `Ячеек в справочнике WMS: ${state.cells.length}. `
    + `Названий товаров: ${Object.keys(state.sku).length}.`;
}

function toggleMissing(cellId) {
  if (state.missing.has(cellId)) state.missing.delete(cellId);
  else state.missing.add(cellId);
  chrome.storage.local.set({ priemkaMissingCells: [...state.missing] }, render);
}

// ------------------------------------------------------------------
// Режим приёмки
// ------------------------------------------------------------------

function buildQueue() {
  // Идём по ячейкам по порядку: секция, этаж, позиция. Оператор проходит
  // зал один раз, а не бегает туда-сюда за каждым следующим заказом.
  // Выданные заказы в обход не берём: их на полке уже нет.
  const withCell = filtered().filter((r) => r.cell && !r.gone && !state.missing.has(String(r.cell)));
  const num = (c) => {
    const t = String(c);
    return [Number(t.slice(0, -2)) || 0, Number(t.slice(-2, -1)) || 0, Number(t.slice(-1)) || 0];
  };
  return withCell.sort((a, b) => {
    const x = num(a.cell), y = num(b.cell);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}

function showCurrent() {
  const r = state.queue[state.at];
  if (!r) return finish();
  ui.runCell.textContent = r.cell;
  ui.runName.textContent = nameOf(r) || globalThis.UCoreWmsParse.typeLabel(r) || 'Без названия';
  ui.runSub.textContent = [r.barcode, r.orderId, r.pid, r.clientName].filter(Boolean).join(' · ');
  ui.runCount.textContent = `${state.at + 1} из ${state.queue.length}`;
  announce(r.cell);
}

function start() {
  state.queue = buildQueue();
  if (!state.queue.length) {
    ui.note.textContent = 'Нечего раскладывать: среди показанных позиций нет ни одной с ячейкой.';
    ui.note.dataset.on = '1';
    return;
  }
  state.running = true;
  state.at = 0;
  ui.run.dataset.on = '1';
  ui.start.style.display = 'none';
  ui.next.style.display = '';
  ui.stop.style.display = '';
  showCurrent();
}

function nextItem() {
  const r = state.queue[state.at];
  if (r) state.done.add(parser().recordKey(r));
  state.at++;
  if (state.at >= state.queue.length) return finish();
  showCurrent();
  render();
}

function finish() {
  state.running = false;
  ui.run.dataset.on = '0';
  ui.start.style.display = '';
  ui.next.style.display = 'none';
  ui.stop.style.display = 'none';
  ui.note.textContent = `Приёмка закончена: пройдено ${state.done.size} позиций.`;
  ui.note.dataset.on = '1';
  render();
}

// ------------------------------------------------------------------
// Выгрузка
// ------------------------------------------------------------------

function exportCsv() {
  const head = ['Ячейка', 'Заказ', 'PID', 'ШК товара', 'Товар', 'Единица', 'Габариты мм',
                'Клиент', 'Телефон', 'ГМ', 'Источник', 'Партнёр', 'Номер WMS'];
  const esc = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[",;\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = [head.join(';')];
  for (const r of filtered()) {
    const sku = skuOf(r) || {};
    lines.push([
      r.cell, r.orderId || r.orderBarcode, r.pid, r.barcode, nameOf(r), sku.unit,
      sku.length ? `${sku.length}x${sku.width}x${sku.height}` : '',
      r.clientName, r.phone, r.gm, SRC[r.source] || r.source, r.partner, r.wmsOrderId
    ].map(esc).join(';'));
  }
  // BOM — иначе Excel открывает кириллицу кракозябрами.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `priemka-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ------------------------------------------------------------------

ui.start.addEventListener('click', start);
ui.next.addEventListener('click', nextItem);
ui.stop.addEventListener('click', finish);
ui.runRepeat.addEventListener('click', () => {
  const r = state.queue[state.at];
  if (r) announce(r.cell);
});
ui.sound.addEventListener('click', () => {
  state.sound = !state.sound;
  ui.sound.setAttribute('aria-pressed', String(state.sound));
  ui.sound.textContent = state.sound ? '🔊 Звук' : '🔇 Без звука';
});
ui.sync.addEventListener('click', () => {
  ui.sync.disabled = true;
  ui.sync.textContent = 'Собираю…';
  chrome.runtime.sendMessage({ type: 'ucore:sync-all' }, () => {
    ui.sync.disabled = false;
    ui.sync.textContent = 'Обновить данные';
    load();
  });
});
ui.exp.addEventListener('click', exportCsv);
el('btn-inv').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('inventory.html') });
});

for (const control of [ui.q, ui.src, ui.mode]) {
  control.addEventListener('input', render);
  control.addEventListener('change', render);
}

// Пробел и стрелка вправо — «дальше»: оператор идёт с коробкой и жмёт
// одну клавишу, не целясь мышью. В поиске пробел работает как обычно.
document.addEventListener('keydown', (event) => {
  if (!state.running) return;
  if (event.target && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
  if (event.key === ' ' || event.key === 'ArrowRight' || event.key === 'Enter') {
    event.preventDefault();
    nextItem();
  }
  if (event.key === 'Escape') finish();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && KEYS.some((k) => k in changes)) load();
});

// ------------------------------------------------------------------
// Панель «Названия товаров»
// ------------------------------------------------------------------
// Настройки перевода и его ход. Сама работа идёт в service worker: попап
// можно закрыть, вкладку переключить, а перевод продолжится. Отсюда мы
// только показываем, что происходит, и просим у Chrome право на адрес
// модели — его нельзя запросить из фонового кода, только из окна и только
// по клику человека.
//
// КЛЮЧ. Поле ключа никогда не заполняется из хранилища: прочитать его
// обратно панель не может и не должна. Пустое поле значит «не меняем», а
// введён ли ключ вообще — видно по строке состояния.

const np = {
  panel: el('names-panel'), open: el('btn-names'), close: el('names-close'),
  mode: el('names-mode'), provider: el('names-provider'), model: el('names-model'),
  key: el('names-key'), keysWhere: el('names-keys-where'), batch: el('names-batch'),
  probe: el('names-probe'), run: el('names-run'), again: el('names-again'),
  stop: el('names-stop'), bar: el('names-bar'), state: el('names-state'), log: el('names-log')
};

let namesTimer = null;
let providers = {};

const ask = (message) => new Promise((resolve) => {
  chrome.runtime.sendMessage(message, (answer) => {
    if (chrome.runtime.lastError) resolve({ ok: false, reason: chrome.runtime.lastError.message });
    else resolve(answer || {});
  });
});

/**
 * Право ходить на адрес модели. Запрашиваем ПЕРВЫМ ДЕЙСТВИЕМ обработчика
 * клика и без предварительных проверок: Chrome разрешает спрашивать только
 * пока «жив» клик человека, и любое ожидание перед этим его тратит. Если
 * право уже есть, окно не появляется.
 */
function askAccess(base) {
  let origin;
  try {
    origin = `${new URL(base).origin}/*`;
  } catch (e) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      chrome.permissions.request({ origins: [origin] }, (granted) => {
        resolve(chrome.runtime.lastError ? false : !!granted);
      });
    } catch (err) {
      resolve(false);
    }
  });
}

function currentBase() {
  const chosen = providers[np.provider.value];
  return chosen ? chosen.base : '';
}

function namesPatchFromForm() {
  const chosen = providers[np.provider.value] || {};
  return {
    enabled: np.mode.value === 'llm',
    provider: np.provider.value,
    base: chosen.base,
    model: np.model.value.trim() || chosen.model,
    batch: Math.max(1, Math.min(50, Number(np.batch.value) || 25))
  };
}

/** Сохранить настройки. Ключ уходит отдельным полем и только если введён. */
async function saveNames() {
  const patch = namesPatchFromForm();
  const message = { type: 'ucore:names-settings', patch };
  if (np.key.value) {
    message.key = np.key.value;
    np.key.value = '';                 // в поле его больше не держим
  }
  return ask(message);
}

function fillProviders(list, chosen) {
  if (np.provider.options.length && np.provider.dataset.filled === '1') return;
  np.provider.textContent = '';
  for (const [id, info] of Object.entries(list)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = info.title;
    np.provider.appendChild(option);
  }
  np.provider.dataset.filled = '1';
  np.provider.value = chosen;
}

function showNamesStatus(status) {
  if (!status || !status.settings) return;
  const s = status.settings;
  providers = status.providers || providers;
  fillProviders(providers, s.provider);
  np.provider.value = s.provider;
  np.mode.value = s.enabled ? 'llm' : 'rules';
  if (document.activeElement !== np.model) np.model.value = s.model;
  if (document.activeElement !== np.batch) np.batch.value = s.batch;

  const where = (providers[s.provider] || {}).keys;
  np.keysWhere.textContent = where ? `взять на ${where}` : 'местной модели ключ не нужен';
  np.key.placeholder = status.hasKey ? 'ключ введён — оставьте пустым' : 'вставьте свой ключ';

  const run = status.run || {};
  const running = !!run.running;
  np.stop.hidden = !running;
  np.run.disabled = running || !s.enabled;
  np.again.hidden = !status.cached;
  np.again.disabled = running || !s.enabled;
  np.bar.hidden = !running;
  if (running && run.total) {
    np.bar.firstElementChild.style.width = `${Math.round(100 * run.done / run.total)}%`;
  }

  const parts = [];
  // Про испорченный ключ говорим первым делом и своими словами: это
  // единственная ошибка, которую человек исправляет сам и за десять секунд.
  if (status.keyProblem) parts.push(`Ключ не сохранён: ${status.keyProblem}`);
  if (running) parts.push(`Перевожу: ${run.done} из ${run.total}`);
  else if (run.error) parts.push(`Остановилось: ${run.error}`);
  else if (run.finished && run.total) {
    parts.push(`Готово: ${run.ok} из ${run.total} за ${run.requests} запросов`);
  }
  parts.push(`переведено и сохранено ${status.cached}`);
  if (status.pending) parts.push(`ждут перевода ${status.pending}`);
  if (s.enabled && !status.granted) parts.push('нет разрешения на адрес модели');
  if (s.enabled && status.granted && !status.hasKey && where) parts.push('не введён ключ');
  np.state.textContent = parts.join(' · ');

  // Отклонённые ответы показываем как есть. Оператору они не нужны, а тому,
  // кто выбирает модель, нужны только они: по строкам «придумано число» и
  // «ответ не про этот товар» видно, что именно идёт не так.
  const bad = (run.rejected || []).slice(0, 8);
  np.log.textContent = '';
  if (!running && bad.length) {
    const head = document.createElement('div');
    head.innerHTML = '<b>Что модель ответила не так</b>';
    np.log.appendChild(head);
    for (const item of bad) {
      const row = document.createElement('div');
      row.textContent = `${item.name} → «${item.answer}» — ${item.why}`;
      np.log.appendChild(row);
    }
  }
}

async function refreshNames() {
  const status = await ask({ type: 'ucore:names-status' });
  showNamesStatus(status);
  clearTimeout(namesTimer);
  const running = !!(status && status.run && status.run.running);
  if (running && !np.panel.hidden) namesTimer = setTimeout(refreshNames, 1200);
  return status;
}

np.open.addEventListener('click', () => {
  np.panel.hidden = !np.panel.hidden;
  if (!np.panel.hidden) refreshNames();
});
np.close.addEventListener('click', () => { np.panel.hidden = true; clearTimeout(namesTimer); });

np.provider.addEventListener('change', async () => {
  const chosen = providers[np.provider.value] || {};
  np.model.value = chosen.model || '';
  showNamesStatus(await saveNames());
});
for (const control of [np.mode, np.model, np.batch, np.key]) {
  control.addEventListener('change', async () => {
    const enabling = np.mode.value === 'llm';
    if (enabling) await askAccess(currentBase());
    showNamesStatus(await saveNames());
  });
}

np.probe.addEventListener('click', async () => {
  const granted = await askAccess(currentBase());
  np.state.textContent = 'Проверяю…';
  await saveNames();
  if (!granted) { np.state.textContent = 'Без разрешения на адрес модели проверить нечем'; return; }
  const answer = await ask({ type: 'ucore:names-probe' });
  if (!answer.ok) { np.state.textContent = answer.error || 'не получилось'; return; }
  const list = answer.models.slice(0, 12).join(', ') || 'ни одной модели';
  np.state.textContent = answer.hasModel
    ? `Связь есть, модель на месте. Доступны: ${list}`
    : `Связь есть, но «${np.model.value}» в списке нет. Доступны: ${list}`;
});

async function startNames(all) {
  const granted = await askAccess(currentBase());
  await saveNames();
  if (!granted) { np.state.textContent = 'Нужно разрешение на адрес модели'; return; }
  const answer = await ask({ type: 'ucore:names-run', all });
  if (!answer.ok) np.state.textContent = answer.reason || 'не удалось начать';
  refreshNames();
}

np.run.addEventListener('click', () => startNames(false));
np.again.addEventListener('click', () => startNames(true));
np.stop.addEventListener('click', async () => {
  await ask({ type: 'ucore:names-stop' });
  refreshNames();
});


load();
