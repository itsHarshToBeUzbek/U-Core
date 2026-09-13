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

const KEYS = ['priemkaRecords', 'priemkaCells', 'priemkaSku', 'priemkaMissingCells', 'priemkaSync'];

const state = {
  records: [],
  cells: [],
  sku: {},
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

function load() {
  chrome.storage.local.get(KEYS, (data) => {
    state.records = data.priemkaRecords || [];
    state.cells = (data.priemkaCells || []).map(String);
    state.sku = data.priemkaSku || {};
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
    const named = !!fullNameOf(r);
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
            r.phone, fullNameOf(r), r.partner]
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
    const name = fullNameOf(r);
    if (name) {
      nameTd.textContent = name;
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
        small.textContent = [sku.unit, dims, tier].filter(Boolean).join(' · ');
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
  const named = state.records.filter((r) => fullNameOf(r)).length;
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
  const noName = state.records.filter((r) => r.barcode && !fullNameOf(r)).length;
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
  ui.runName.textContent = fullNameOf(r) || globalThis.UCoreWmsParse.typeLabel(r) || 'Без названия';
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
      r.cell, r.orderId || r.orderBarcode, r.pid, r.barcode, fullNameOf(r), sku.unit,
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

load();
