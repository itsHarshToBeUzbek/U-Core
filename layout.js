// ==========================================
// layout.js — редактор схемы зала
// ==========================================
// То, чего НЕТ и не может быть ни в каком API WMS: как стеллажи стоят в
// комнате, что до чего рукой подать, где к ячейке пристроена стена под
// габарит. Справочник ячеек WMS отдаёт сам — а расположение знает только
// человек, который в этом зале стоял.
//
// Порядок работы задан заказчиком и идёт от грубого к точному:
//   1) рисуем прямоугольник здания сверху (точность не нужна);
//   2) рисуем внутри отделы — мышью, как квадраты;
//   3) у каждого отдела указываем секцию WMS, этажи и позиции;
//   4) размечаем ячейки: обычная / большая / стена (КГТ) / негабарит / нет.
//
// АУДИТОРИЯ — специалист внедрения, а не сотрудник ПВЗ. Поэтому интерфейс
// плотный и технический: показываем коды ячеек, расхождения со справочником
// и сырой конфиг, не пряча это за «дружелюбностью».
//
// ЗАЧЕМ РИСОВАТЬ, А НЕ ПРОСТО ВВЕСТИ СПИСОК. Из геометрии считается
// sectionSeverityOrder — порядок отделов по удалённости от входа. Это
// единственное поле конфига, которое иначе пришлось бы угадывать руками
// (см. RECOMMENDATION-VARIABLES.md §2.1). Порядок предлагается, но не
// навязывается: его можно перетащить, потому что «далеко» и «неудобно» —
// не одно и то же (к секции можно идти близко, но разворачиваться).

const STORE_KEY = 'pvzLayout';
const SNAP = 10;
const SVG_NS = 'http://www.w3.org/2000/svg';

const CELL_KINDS = ['standard', 'big', 'wall', 'oversize', 'none'];
const KIND_LABEL = {
  standard: 'обычная', big: 'большая', wall: 'стена (КГТ)',
  oversize: 'негабарит', none: 'нет'
};

const state = {
  layout: {
    building: { x: 80, y: 60, w: 840, h: 520 },
    entrance: { x: 500, y: 600 },
    groups: []
  },
  knownCells: new Set(),      // справочник из WMS
  selected: null,
  mode: 'select',             // select | draw | entrance
  brush: 'none',              // каким типом красим ячейки
  severityOverride: null
};

const svg = document.getElementById('plan');
const side = document.getElementById('side');
const hint = document.getElementById('hint');

// ------------------------------------------------------------------
// загрузка / сохранение
// ------------------------------------------------------------------

function load() {
  chrome.storage.local.get([STORE_KEY, 'priemkaCells', 'priemkaRecords'], (data) => {
    if (data[STORE_KEY]) state.layout = { ...state.layout, ...data[STORE_KEY] };
    if (state.layout.brush && CELL_KINDS.includes(state.layout.brush)) state.brush = state.layout.brush;
    if (!state.layout.groups) state.layout.groups = [];

    // ЧТО СЧИТАТЬ СУЩЕСТВУЮЩИМ. Только справочник ячеек WMS.
    //
    // Раньше сюда подмешивались ячейки из собранных записей — и любая
    // случайная строка в поле `cell` порождала ОТДЕЛ. Так на схеме и
    // завелись отделы 700 и дальше: физически их нет, в справочнике их
    // нет, а на плане они были и не удалялись. Записи — данные о том, что
    // где лежит; какие ячейки существуют, знает только справочник.
    state.knownCells = new Set((data.priemkaCells || []).map(String));
    state.recordCells = new Set((data.priemkaRecords || []).map(r => r.cell).filter(Boolean).map(String));
    if (!Array.isArray(state.layout.removedSections)) state.layout.removedSections = [];

    // Первый запуск: если отделов ещё нет, а данные уже собраны — предлагаем
    // заготовку по секциям, которые реально используются. Рисовать с нуля
    // всё равно придётся, но хотя бы не гадать, сколько их.
    if (!state.layout.groups.length && state.knownCells.size) {
      seedFromData();
    }
    render();
  });
}

function seedFromData() {
  // УДАЛЁННОЕ НЕ ВОСКРЕШАЕМ. Отдел, убранный руками, — это решение
  // человека о своём зале. Заготовка, которая приносит его обратно при
  // следующем открытии страницы, обесценивает саму возможность удалить.
  const forgotten = new Set((state.layout.removedSections || []).map(String));
  const sections = [...new Set([...state.knownCells].map(parseSection).filter(Boolean))]
    .filter(sec => !forgotten.has(String(sec)))
    .sort((a, b) => Number(a) - Number(b));
  if (!sections.length) return;

  const perRow = Math.ceil(Math.sqrt(sections.length));
  const b = state.layout.building;
  const w = Math.floor((b.w - 40) / perRow) - 20;
  const h = 120;

  sections.forEach((section, i) => {
    const col = i % perRow, row = Math.floor(i / perRow);
    state.layout.groups.push({
      id: `g${section}`,
      section,
      name: `Отдел ${section}`,
      x: b.x + 20 + col * (w + 20),
      y: b.y + 20 + row * (h + 20),
      w, h,
      floors: floorsOf(section),
      positions: positionsOf(section),
      cells: {}
    });
  });
  state.layout.seeded = true;
}

function parseSection(code) {
  const text = String(code);
  return /^\d{3,}$/.test(text) ? text.slice(0, -2) : null;
}

function cellsOfSection(section) {
  return [...state.knownCells].filter(c => parseSection(c) === String(section));
}

/**
 * ФАНТОМНЫЙ ОТДЕЛ — привязан к секции, которой в справочнике WMS нет вовсе.
 *
 * Отдел без привязки фантомом НЕ считается: его только что нарисовали, и
 * секцию ещё предстоит выбрать. А вот отдел, привязанный к секции 700, у
 * которой ноль ячеек, — след старой заготовки, и на плане ему не место.
 */
function isPhantom(group) {
  return !!(group && group.section && state.knownCells.size
            && !cellsOfSection(group.section).length);
}

function phantomGroups() {
  return state.layout.groups.filter(isPhantom);
}

/** Запомнить, что отдел убран руками: заготовка не должна его вернуть. */
function forgetSections(sections) {
  const set = new Set((state.layout.removedSections || []).map(String));
  for (const sec of sections) if (sec) set.add(String(sec));
  state.layout.removedSections = [...set];
}

function floorsOf(section) {
  const floors = cellsOfSection(section).map(c => Number(c.slice(-2, -1)));
  return floors.length ? Math.max(...floors) : 6;
}

function positionsOf(section) {
  const pos = cellsOfSection(section).map(c => Number(c.slice(-1)));
  return pos.length ? Math.max(...pos) : 5;
}

function save(silent) {
  chrome.storage.local.set({ [STORE_KEY]: state.layout }, () => {
    if (!silent) flashHint('Схема сохранена');
  });
}

function flashHint(text) {
  hint.textContent = text;
  clearTimeout(hint._t);
  hint._t = setTimeout(() => { hint.textContent = modeHint(); }, 2500);
}

function modeHint() {
  if (state.mode === 'draw') return 'Потяните мышью по плану, чтобы нарисовать отдел';
  if (state.mode === 'entrance') return 'Кликните, где находится вход / стойка выдачи';
  return 'Кликните отдел, чтобы настроить его ячейки';
}

// ------------------------------------------------------------------
// отрисовка плана
// ------------------------------------------------------------------

function el(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function render() {
  renderPlan();
  renderSide();
}

function renderPlan() {
  svg.replaceChildren();

  for (let x = 0; x <= 1000; x += 40) el('line', { x1: x, y1: 0, x2: x, y2: 640, class: 'grid-line' }, svg);
  for (let y = 0; y <= 640; y += 40) el('line', { x1: 0, y1: y, x2: 1000, y2: y, class: 'grid-line' }, svg);

  const b = state.layout.building;
  el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 6, class: 'building' }, svg);

  for (const group of state.layout.groups) {
    const mapped = !!group.section && cellsOfSection(group.section).length > 0;
    const rect = el('rect', {
      x: group.x, y: group.y, width: group.w, height: group.h, rx: 5,
      class: 'group-rect',
      'data-selected': state.selected === group.id ? '1' : '0',
      'data-unmapped': mapped ? '0' : '1',
      // Фантом и «секция не задана» выглядят одинаково пустыми, но это
      // разные вещи: первое надо убрать, второе — дозаполнить.
      'data-phantom': isPhantom(group) ? '1' : '0'
    }, svg);
    rect.addEventListener('pointerdown', (e) => startDragGroup(e, group));

    el('text', { x: group.x + group.w / 2, y: group.y + group.h / 2 - 2, 'text-anchor': 'middle', class: 'group-label' }, svg)
      .textContent = group.name || `Отдел ${group.section || '?'}`;

    const counted = countKinds(group);
    el('text', { x: group.x + group.w / 2, y: group.y + group.h / 2 + 15, 'text-anchor': 'middle', class: 'group-sub' }, svg)
      .textContent = isPhantom(group)
        ? `секция ${group.section} — в WMS такой нет`
        : (group.section ? `секция ${group.section} · ${counted.total} яч.` : 'секция не задана');

    if (state.selected === group.id) {
      const handle = el('rect', {
        x: group.x + group.w - 7, y: group.y + group.h - 7, width: 14, height: 14, rx: 3, class: 'handle'
      }, svg);
      handle.addEventListener('pointerdown', (e) => startResizeGroup(e, group));
    }
  }

  const en = state.layout.entrance;
  const marker = el('circle', { cx: en.x, cy: en.y, r: 11, class: 'entrance' }, svg);
  marker.addEventListener('pointerdown', startDragEntrance);
  el('text', { x: en.x, y: en.y - 17, 'text-anchor': 'middle', class: 'entrance-label' }, svg).textContent = 'вход';
}

function countKinds(group) {
  const kinds = { standard: 0, big: 0, wall: 0, oversize: 0, none: 0, total: 0 };
  for (const code of allCodes(group)) {
    const kind = kindOf(group, code);
    kinds[kind]++;
    if (kind !== 'none') kinds.total++;
  }
  return kinds;
}

function allCodes(group) {
  const codes = [];
  if (!group.section) return codes;
  for (let f = 1; f <= (group.floors || 0); f++) {
    for (let p = 1; p <= (group.positions || 0); p++) codes.push(`${group.section}${f}${p}`);
  }
  return codes;
}

/**
 * Тип ячейки: сначала то, что размечено руками, потом разумное значение
 * по умолчанию. По умолчанию берём два факта, уже подтверждённые данными:
 * ячейки этажа 1 позиций 1-2 — большие, а кода, которого нет в справочнике
 * WMS, физически не существует.
 */
function kindOf(group, code) {
  if (group.cells && group.cells[code]) return group.cells[code];
  if (state.knownCells.size && !state.knownCells.has(code)) return 'none';
  const floor = code.slice(-2, -1), pos = code.slice(-1);
  if (floor === '1' && (pos === '1' || pos === '2')) return 'big';
  return 'standard';
}

// ------------------------------------------------------------------
// мышь
// ------------------------------------------------------------------

function svgPoint(event) {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const scale = Math.min(rect.width / vb.width, rect.height / vb.height);
  const offX = (rect.width - vb.width * scale) / 2;
  const offY = (rect.height - vb.height * scale) / 2;
  return {
    x: Math.round((event.clientX - rect.left - offX) / scale / SNAP) * SNAP,
    y: Math.round((event.clientY - rect.top - offY) / scale / SNAP) * SNAP
  };
}

let drag = null;

// Захват указателя — удобство (не терять перетаскивание за краем svg), а не
// необходимость. Он бросает NotFoundError на событии без валидного
// pointerId, и без этой обёртки такая ошибка обрывала бы весь обработчик,
// не дав ни выделить отдел, ни перерисовать панель.
function capture(event) {
  try { svg.setPointerCapture(event.pointerId); } catch (e) { /* не критично */ }
}

svg.addEventListener('pointerdown', (event) => {
  if (event.target !== svg && !event.target.classList.contains('grid-line')
      && !event.target.classList.contains('building')) return;

  const p = svgPoint(event);

  if (state.mode === 'entrance') {
    state.layout.entrance = p;
    setMode('select');
    save(true); render();
    return;
  }

  if (state.mode !== 'draw') { state.selected = null; render(); return; }

  drag = { type: 'create', start: p, current: p };
  capture(event);
});

svg.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const p = svgPoint(event);

  if (drag.type === 'create') {
    drag.current = p;
    renderPlan();
    const x = Math.min(drag.start.x, p.x), y = Math.min(drag.start.y, p.y);
    el('rect', {
      x, y, width: Math.abs(p.x - drag.start.x), height: Math.abs(p.y - drag.start.y),
      rx: 5, class: 'draft'
    }, svg);
    return;
  }

  if (drag.type === 'move') {
    drag.group.x = drag.origin.x + (p.x - drag.start.x);
    drag.group.y = drag.origin.y + (p.y - drag.start.y);
    renderPlan();
    return;
  }

  if (drag.type === 'resize') {
    drag.group.w = Math.max(60, drag.origin.w + (p.x - drag.start.x));
    drag.group.h = Math.max(50, drag.origin.h + (p.y - drag.start.y));
    renderPlan();
  }
});

svg.addEventListener('pointerup', (event) => {
  if (!drag) return;
  const finished = drag;
  drag = null;
  try { svg.releasePointerCapture(event.pointerId); } catch (e) { /* уже отпущен */ }

  if (finished.type === 'create') {
    const p = finished.current;
    const w = Math.abs(p.x - finished.start.x);
    const h = Math.abs(p.y - finished.start.y);
    if (w < 40 || h < 40) { render(); return; }   // случайный клик — не создаём

    const next = nextSection();
    const group = {
      id: `g${Date.now().toString(36)}`,
      section: next,
      name: next ? `Отдел ${next}` : 'Новый отдел',
      x: Math.min(finished.start.x, p.x), y: Math.min(finished.start.y, p.y),
      w, h,
      floors: next ? floorsOf(next) : 6,
      positions: next ? positionsOf(next) : 5,
      cells: {}
    };
    state.layout.groups.push(group);
    state.selected = group.id;
    setMode('select');
  }

  save(true);
  render();
});

/** Первая секция из справочника WMS, ещё не привязанная ни к одному отделу. */
function nextSection() {
  const used = new Set(state.layout.groups.map(g => String(g.section)));
  const all = [...new Set([...state.knownCells].map(parseSection).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));
  return all.find(s => !used.has(s)) || '';
}

function startDragGroup(event, group) {
  event.stopPropagation();
  state.selected = group.id;
  if (state.mode === 'draw') setMode('select');
  drag = { type: 'move', group, start: svgPoint(event), origin: { x: group.x, y: group.y } };
  capture(event);
  render();
}

function startResizeGroup(event, group) {
  event.stopPropagation();
  drag = { type: 'resize', group, start: svgPoint(event), origin: { w: group.w, h: group.h } };
  capture(event);
}

function startDragEntrance(event) {
  event.stopPropagation();
  drag = { type: 'move', group: state.layout.entrance, start: svgPoint(event),
           origin: { x: state.layout.entrance.x, y: state.layout.entrance.y } };
  capture(event);
}

function setMode(mode) {
  state.mode = mode;
  document.getElementById('mode-draw').dataset.on = mode === 'draw' ? '1' : '0';
  document.getElementById('mode-entrance').dataset.on = mode === 'entrance' ? '1' : '0';
  hint.textContent = modeHint();
}

document.getElementById('mode-draw').addEventListener('click', () => setMode(state.mode === 'draw' ? 'select' : 'draw'));
document.getElementById('mode-entrance').addEventListener('click', () => setMode(state.mode === 'entrance' ? 'select' : 'entrance'));
document.getElementById('btn-delete').addEventListener('click', deleteSelected);
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected && !typing) {
    e.preventDefault();
    deleteSelected();
    return;
  }
  // Кисть с клавиатуры: рука не уходит с плана к списку типов.
  if (!typing && /^[1-5]$/.test(e.key)) {
    const kind = CELL_KINDS[Number(e.key) - 1];
    if (kind) { state.brush = kind; saveBrush(); render(); }
  }
});

function deleteSelected() {
  if (!state.selected) { flashHint('Сначала выберите отдел'); return; }
  const gone = state.layout.groups.find(g => g.id === state.selected);
  state.layout.groups = state.layout.groups.filter(g => g.id !== state.selected);
  if (gone && gone.section) forgetSections([gone.section]);
  state.selected = null;
  save(true); render();
  flashHint('Отдел убран — заготовка его больше не вернёт');
}

/** Убрать разом всё, чему в справочнике WMS не соответствует ни одна ячейка. */
function dropPhantoms() {
  const gone = phantomGroups();
  if (!gone.length) { flashHint('Фантомных отделов нет'); return; }
  const ids = new Set(gone.map(g => g.id));
  state.layout.groups = state.layout.groups.filter(g => !ids.has(g.id));
  forgetSections(gone.map(g => g.section));
  if (ids.has(state.selected)) state.selected = null;
  save(true); render();
  flashHint(`Убрано отделов: ${gone.length}`);
}

// ------------------------------------------------------------------
// порядок тяжести секций
// ------------------------------------------------------------------

/**
 * Предложение порядка: по расстоянию от входа до центра отдела.
 * Это ПОДСКАЗКА, а не истина — «далеко» и «неудобно» совпадают не всегда
 * (пример из справочника: к секции можно идти близко, но разворачиваться
 * к ней спиной). Поэтому список можно перетащить руками, и ручной порядок
 * побеждает расчётный.
 */
function suggestedSeverity() {
  const en = state.layout.entrance;
  return state.layout.groups
    .filter(g => g.section)
    .map(g => ({
      section: String(g.section),
      name: g.name,
      distance: Math.round(Math.hypot(g.x + g.w / 2 - en.x, g.y + g.h / 2 - en.y))
    }))
    .sort((a, b) => a.distance - b.distance);
}

function severityOrder() {
  const suggested = suggestedSeverity();
  if (!state.layout.severityOrder) return suggested;
  const byId = new Map(suggested.map(s => [s.section, s]));
  const ordered = state.layout.severityOrder.map(s => byId.get(String(s))).filter(Boolean);
  const rest = suggested.filter(s => !ordered.includes(s));
  return [...ordered, ...rest];
}

// ------------------------------------------------------------------
// боковая панель
// ------------------------------------------------------------------

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function renderSide() {
  side.replaceChildren();
  const group = state.layout.groups.find(g => g.id === state.selected);
  if (group) renderGroupPanel(group);
  else renderOverviewPanel();
}

function renderOverviewPanel() {
  side.appendChild(node('h2', null, 'Зал целиком'));

  const known = state.knownCells.size;
  const note = node('div', known ? 'note note--good' : 'note note--warn');
  note.textContent = known
    ? `Справочник WMS: ${known} ячеек. Коды, которых в нём нет, помечаются как несуществующие.`
    : 'Справочник ячеек ещё не собран. Откройте попап → Приёмка → «Собрать всё из WMS», иначе разметку не с чем сверить.';
  side.appendChild(note);

  const mapped = state.layout.groups.filter(g => g.section).length;
  const info = node('div', 'note');
  info.textContent = `Отделов на схеме: ${state.layout.groups.length}, из них с привязкой к секции: ${mapped}.`;
  side.appendChild(info);

  // ФАНТОМЫ. Отделы, привязанные к секциям, которых в справочнике WMS нет.
  // Такие остались от старых заготовок, когда отдел заводился по любой
  // строке в поле «ячейка», включая мусорную.
  const phantoms = phantomGroups();
  if (phantoms.length) {
    const warn = node('div', 'note note--warn');
    warn.textContent = `Фантомные отделы: ${phantoms.length} `
      + `(${phantoms.map(g => g.section).join(', ')}). `
      + 'В справочнике WMS у этих секций нет ни одной ячейки — на полу их тоже нет. '
      + 'Они не участвуют ни в обходе, ни в рекомендациях, но мешают читать схему.';
    side.appendChild(warn);

    const drop = node('button', 'btn btn--bad', `Убрать ${phantoms.length} фантомных отделов`);
    drop.addEventListener('click', dropPhantoms);
    side.appendChild(drop);
  }

  // Ячейки, которые встречаются в собранных записях, но которых нет в
  // справочнике. Раньше каждая такая строка заводила отдел; теперь она
  // просто названа вслух — молчать о расхождении тоже нельзя.
  const strays = [...(state.recordCells || [])].filter(c => !state.knownCells.has(c));
  if (state.knownCells.size && strays.length) {
    const note2 = node('div', 'note note--warn');
    note2.textContent = `В собранных записях ${strays.length} ячеек, которых нет в справочнике WMS: `
      + strays.slice(0, 8).join(', ') + (strays.length > 8 ? ' и другие. ' : '. ')
      + 'Отделы по ним не заводятся — сверьте на месте.';
    side.appendChild(note2);
  }

  side.appendChild(node('h3', null, 'Порядок по досягаемости'));
  const explain = node('div', 'note');
  explain.textContent = 'Считается от входа. Первый — самый удобный. Перетащите, если реальная досягаемость другая: к секции можно идти близко, но разворачиваться.';
  side.appendChild(explain);

  const list = node('div', 'severity');
  const order = severityOrder();
  order.forEach((entry, index) => {
    const item = node('div', 'sev-item');
    item.draggable = true;
    item.dataset.section = entry.section;
    item.append(
      node('span', 'sev-item__n', String(index + 1)),
      node('span', null, entry.name || `Отдел ${entry.section}`),
      node('span', 'sev-item__d', `${entry.distance}`)
    );
    item.addEventListener('dragstart', () => { item.dataset.drag = '1'; state._dragSection = entry.section; });
    item.addEventListener('dragend', () => { item.dataset.drag = '0'; });
    item.addEventListener('dragover', (e) => e.preventDefault());
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = state._dragSection;
      if (!from || from === entry.section) return;
      const current = severityOrder().map(s => s.section);
      const next = current.filter(s => s !== from);
      next.splice(next.indexOf(entry.section), 0, from);
      state.layout.severityOrder = next;
      save(true); renderSide();
    });
    list.appendChild(item);
  });
  side.appendChild(list);

  if (state.layout.severityOrder) {
    const reset = node('button', 'btn', 'Вернуть расчётный порядок');
    reset.style.marginTop = '8px';
    reset.addEventListener('click', () => {
      delete state.layout.severityOrder;
      save(true); renderSide();
    });
    side.appendChild(reset);
  }

  side.appendChild(node('h3', null, 'Что попадёт в конфиг'));
  const preview = node('div', 'note');
  const wall = collectKind('wall');
  const oversize = collectKind('oversize');
  preview.textContent =
    `sectionSeverityOrder: ${order.map(s => s.section).join(', ') || '—'}\n` +
    `wallCells.ids: ${wall.join(', ') || 'не размечены'}\n` +
    `негабарит: ${oversize.join(', ') || 'не размечен'}`;
  preview.style.whiteSpace = 'pre-line';
  preview.style.fontFamily = 'var(--font-mono)';
  side.appendChild(preview);
}

function collectKind(kind) {
  const out = [];
  for (const group of state.layout.groups) {
    for (const code of allCodes(group)) {
      if (kindOf(group, code) === kind) out.push(code);
    }
  }
  return out.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

function renderGroupPanel(group) {
  side.appendChild(node('h2', null, group.name || 'Отдел'));

  const back = node('button', 'btn', '← Ко всему залу');
  back.addEventListener('click', () => { state.selected = null; render(); });
  side.appendChild(back);

  const nameField = node('div', 'field');
  nameField.append(node('label', null, 'Название'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = group.name || '';
  nameInput.addEventListener('input', () => { group.name = nameInput.value; save(true); renderPlan(); });
  nameField.appendChild(nameInput);
  side.appendChild(nameField);

  const sectionField = node('div', 'field');
  sectionField.append(node('label', null, 'Секция WMS (первые цифры кода ячейки)'));
  const sectionSelect = document.createElement('select');
  const sections = [...new Set([...state.knownCells].map(parseSection).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = '— не задана —';
  sectionSelect.appendChild(blank);
  for (const s of sections) {
    const option = document.createElement('option');
    option.value = s;
    option.textContent = `${s} (${cellsOfSection(s).length} ячеек)`;
    sectionSelect.appendChild(option);
  }
  sectionSelect.value = group.section || '';
  sectionSelect.addEventListener('change', () => {
    group.section = sectionSelect.value;
    // Секцию вернули на план осознанно — значит и запрет на заготовку снят.
    if (group.section) {
      state.layout.removedSections =
        (state.layout.removedSections || []).filter(s => String(s) !== String(group.section));
    }
    if (group.section) {
      group.floors = floorsOf(group.section);
      group.positions = positionsOf(group.section);
    }
    save(true); render();
  });
  sectionField.appendChild(sectionSelect);
  side.appendChild(sectionField);

  const grid = node('div', 'row2');
  for (const [key, label] of [['floors', 'Этажей'], ['positions', 'Ячеек в ряду']]) {
    const field = node('div', 'field');
    field.append(node('label', null, label));
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '12';
    input.value = group[key] || 0;
    input.addEventListener('input', () => {
      group[key] = Math.max(0, Math.min(12, Number(input.value) || 0));
      save(true); render();
    });
    field.appendChild(input);
    grid.appendChild(field);
  }
  side.appendChild(grid);

  if (!group.section) {
    const warn = node('div', 'note note--warn');
    warn.textContent = 'Пока секция не выбрана, коды ячеек не вычисляются. Секцию видно на ярлыке любой ячейки этого отдела: первые цифры её кода.';
    side.appendChild(warn);
    return;
  }

  side.appendChild(node('h3', null, 'Ячейки'));

  // КИСТЬ ВМЕСТО ПЕРЕБОРА.
  //
  // Раньше тип менялся повторными нажатиями по кругу: чтобы из «обычной»
  // сделать «нет», надо было ударить по ячейке четыре раза, а промахнувшись
  // на один — пройти круг заново. На ряд из двенадцати ячеек это полсотни
  // кликов вслепую.
  //
  // Теперь тип выбирается ОДИН раз кистью, а дальше он просто наносится:
  // клик — одна ячейка, протяжка — сколько угодно подряд, клик по «этаж N»
  // — весь ряд. Правая кнопка снимает ручную пометку и возвращает ячейку
  // к значению по умолчанию.
  const brushWrap = node('div', 'brush');
  brushWrap.appendChild(node('span', 'brush__label', 'Кисть:'));
  for (const [i, kind] of CELL_KINDS.entries()) {
    const b = document.createElement('button');
    b.className = 'brush__btn';
    b.dataset.kind = kind;
    b.dataset.on = state.brush === kind ? '1' : '0';
    b.textContent = `${i + 1} ${KIND_LABEL[kind]}`;
    b.title = `Клавиша ${i + 1}`;
    b.addEventListener('click', () => { state.brush = kind; saveBrush(); render(); });
    brushWrap.appendChild(b);
  }
  side.appendChild(brushWrap);

  const counted = countKinds(group);
  const summary = node('div', 'note');
  summary.textContent = `существует ${counted.total} · больших ${counted.big} · стен ${counted.wall} · негабарит ${counted.oversize} · нет ${counted.none}`;
  side.appendChild(summary);

  const paint = (code) => {
    group.cells = group.cells || {};
    group.cells[code] = state.brush;
    save(true);
  };

  // Этажи сверху вниз: так же, как они выглядят на стеллаже.
  for (let floor = group.floors; floor >= 1; floor--) {
    const row = node('div', 'floor');
    const label = node('button', 'floor__label', `этаж ${floor}`);
    label.title = 'Нанести кисть на весь этаж';
    label.addEventListener('click', () => {
      for (let pos = 1; pos <= group.positions; pos++) paint(`${group.section}${floor}${pos}`);
      render();
    });
    row.appendChild(label);
    const cells = node('div', 'floor__cells');
    for (let pos = 1; pos <= group.positions; pos++) {
      const code = `${group.section}${floor}${pos}`;
      const kind = kindOf(group, code);
      const box = node('div', 'cellbox', code);
      box.dataset.kind = kind;
      if (group.cells && group.cells[code]) box.dataset.manual = '1';
      if (state.knownCells.size && !state.knownCells.has(code) && kind !== 'none') box.dataset.missing = '1';
      box.title = `${KIND_LABEL[kind]}`
        + `${state.knownCells.has(code) ? '' : ' · в справочнике WMS такого кода нет'}`
        + '\nЛевая кнопка — нанести кисть, правая — снять пометку';

      box.addEventListener('pointerdown', (e) => {
        if (e.button === 2) return;                 // правую разбираем отдельно
        e.preventDefault();
        painting = true;
        paint(code); render();
      });
      // Протяжка: кисть идёт по ячейкам, пока кнопка нажата.
      box.addEventListener('pointerenter', () => {
        if (!painting) return;
        if (kindOf(group, code) === state.brush) return;
        paint(code); render();
      });
      box.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (group.cells) delete group.cells[code];
        save(true); render();
      });
      cells.appendChild(box);
    }
    row.appendChild(cells);
    side.appendChild(row);
  }

  const foot = node('div', 'note');
  foot.textContent = 'Протяните мышью по ячейкам, чтобы покрасить сразу несколько. '
    + 'Правая кнопка снимает ручную пометку. Ячейки «нет» пропускаются на инвентаризации.';
  side.appendChild(foot);

  const legend = node('div', 'legend');
  for (const kind of CELL_KINDS) {
    const item = node('span');
    const swatch = node('i');
    swatch.style.borderColor = { standard: 'var(--line)', big: 'var(--brand)', wall: 'var(--warn)', oversize: 'var(--bad)', none: 'var(--ink-faint)' }[kind];
    swatch.style.background = { standard: 'var(--surface)', big: 'var(--brand-soft)', wall: 'var(--warn-soft)', oversize: 'var(--bad-soft)', none: 'var(--line-soft)' }[kind];
    item.append(swatch, node('span', null, KIND_LABEL[kind]));
    legend.appendChild(item);
  }
  side.appendChild(legend);
}

// Нажата ли кнопка мыши: протяжка красит только пока держат.
let painting = false;
window.addEventListener('pointerup', () => { painting = false; });
window.addEventListener('pointercancel', () => { painting = false; });

function saveBrush() {
  state.layout.brush = state.brush;
  save(true);
}

// ------------------------------------------------------------------
// выгрузка конфига
// ------------------------------------------------------------------

function buildConfig() {
  const order = severityOrder().map(s => s.section);
  const wall = collectKind('wall');
  const oversize = collectKind('oversize');
  const missing = [];
  for (const group of state.layout.groups) {
    for (const code of allCodes(group)) {
      if (kindOf(group, code) !== 'none' && state.knownCells.size && !state.knownCells.has(code)) missing.push(code);
    }
  }

  return {
    _comment: 'Сгенерировано редактором схемы зала (layout.html). Разметка отделов и ячеек — ручная; список существующих ячеек сверен со справочником WMS.',
    _generatedAt: new Date().toISOString(),
    sectionSeverityOrder: order,
    wallCells: {
      enabled: wall.length > 0,
      sections: [],
      ids: wall,
      severityOrder: wall
    },
    oversizeCells: oversize,
    _sectionsOnPlan: state.layout.groups
      .filter(g => g.section)
      .map(g => ({ section: g.section, name: g.name, floors: g.floors, positions: g.positions })),
    _codesNotInWmsDirectory: missing
  };
}

document.getElementById('btn-save').addEventListener('click', () => save(false));

document.getElementById('btn-export').addEventListener('click', () => {
  const config = buildConfig();
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'pvz-layout.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  chrome.storage.local.set({ pvzLayoutConfig: config }, () => {
    flashHint('Конфиг выгружен и сохранён в расширении');
  });
});

setMode('select');
load();

export { buildConfig, suggestedSeverity, kindOf, parseSection };

// КОЛЕСО МЫШИ НЕ МЕНЯЕТ ЧИСЛА. У number-инпута в фокусе колесо крутит
// значение, и прокрутка страницы над таким полем молча его переписывает.
document.addEventListener('wheel', (event) => {
  const el = document.activeElement;
  if (!el || el.type !== 'number') return;
  if (el !== event.target && !el.contains(event.target)) return;
  event.preventDefault();
}, { passive: false, capture: true });
