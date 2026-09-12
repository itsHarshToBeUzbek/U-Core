// ==========================================
// allocation-core.js — ядро распределения товаров по ячейкам ПВЗ
// ==========================================
// Чистый ES6-модуль: НЕТ обращений к chrome.*, НЕТ обращений к DOM.
// Один и тот же файл работает и внутри расширения, и в обычном Node
// (`node test-allocation.mjs`), поэтому логику можно проверять тестами,
// не открывая браузер.
//
// Реализует ровно ту модель, что описана в RECOMMENDATION-VARIABLES.md:
//   §2  — две НЕЗАВИСИМЫЕ оси размещения: секция (по РАЗМЕРУ) и этаж (по ВЕСУ)
//   §3  — три типа ячеек: standard / big / wall (КГТ)
//   §4  — двойной порог: что уходит в общий пул, а что получает свою ячейку
//   §5  — перевод size_tier в число (size score)
//   §6  — жёсткий запрет: два разных клиента с одинаковым simplified_name
//         НИКОГДА не лежат в одной ячейке
//   §7  — упаковка "плотно, а не поровну" внутри общего пула
//   §8  — карты / RX / SX: максимальный разброс, без эскалации в big/wall
//   §9  — физически несуществующие ячейки
//   §10 — бессрочная привязка клиента к ячейке + учёт ручных переносов
//
// Все числовые пороги живут в config (pvz-config.example.json) — в коде
// намеренно нет ни одного "магического" числа про конкретный ПВЗ.

// ------------------------------------------------------------------
// Константы
// ------------------------------------------------------------------

export const CELL_KINDS = Object.freeze({
  STANDARD: 'standard',
  BIG: 'big',
  WALL: 'wall'
});

export const ORDER_TIERS = Object.freeze({
  SHARED_POOL: 'shared_pool',
  DEDICATED_STANDARD: 'dedicated_standard',
  BIG: 'big',
  WALL: 'wall'
});

// Причины, по которым получилось именно такое (или никакое) размещение.
// Возвращаются в результате allocateBatch — чтобы UI мог объяснить оператору,
// почему товар едет именно сюда, а не "просто цифра с потолка".
export const PLACEMENT_REASONS = Object.freeze({
  RESERVATION: 'existing_reservation',
  DEDICATED: 'dedicated_cell',
  SHARED_PACKED: 'shared_pool_packed',
  SHARED_NEW: 'shared_pool_new_cell',
  SPECIAL_UNTOUCHED: 'special_untouched_cell',
  SPECIAL_DOUBLED: 'special_doubled_up',
  SPECIAL_DISABLED: 'special_type_disabled',
  NO_CAPACITY: 'no_capacity'
});

// ------------------------------------------------------------------
// Разбор кодов ячеек
// ------------------------------------------------------------------
// Ячейка кодируется как СЕКЦИЯ+ЭТАЖ+ПОЗИЦИЯ, где этаж и позиция — всегда
// одна цифра, а секция — всё, что перед ними (может быть двузначной).
// Настенные (КГТ) ячейки — отдельный тип со своей шкалой тяжести (§3),
// и задаются они явно, см. комментарий к wallMatcher ниже.

// ВАЖНО (проверено на живом WMS, ТАШ-120, GET /de/delivery-point/cells):
// «четыре цифры = настенная КГТ-ячейка» — НЕВЕРНО. В реальном справочнике
// 358 ячеек, из них 115 четырёхзначных, и это обычные ячейки секций 10-14:
// секция пишется без ведущего нуля, поэтому секции 1-9 дают трёхзначный код,
// а 10-14 — четырёхзначный. Правило по длине кода записало бы 115 обычных
// ячеек в КГТ. Поэтому настенные ячейки задаются ЯВНО — списком секций или
// списком кодов, и по умолчанию выключены, пока их не укажут для конкретного
// ПВЗ. idPattern оставлен как дополнительная возможность для других ПВЗ,
// но ни на что не влияет, пока не задан.
function wallMatcher(config) {
  const wall = config?.wallCells || {};
  const ids = new Set((wall.ids || []).map(String));
  const sections = new Set((wall.sections || []).map(String));
  const pattern = wall.idPattern ? new RegExp(wall.idPattern) : null;
  return (id, section) =>
    ids.has(id) || (section !== null && sections.has(section)) || (pattern ? pattern.test(id) : false);
}

function isBigCell(section, floor, position, config) {
  const pattern = config?.bigCellPattern;
  if (!pattern) return false;
  if (pattern.floor !== undefined && String(pattern.floor) !== floor) return false;
  if (Array.isArray(pattern.positions) && !pattern.positions.map(String).includes(position)) return false;
  if (Array.isArray(pattern.sections) && !pattern.sections.map(String).includes(section)) return false;
  return true;
}

/**
 * Строит индекс ячеек: разбирает коды, отсеивает несуществующие (§9),
 * раскладывает по типам (§3).
 */
export function buildCellIndex(cellIds, config) {
  const missing = new Set((config?.nonexistentCells || []).map(String));
  const isWall = wallMatcher(config);
  const wallEnabled = config?.wallCells?.enabled === true;

  const byId = new Map();
  const standard = [];
  const big = [];
  const wall = [];

  for (const rawId of cellIds || []) {
    const id = String(rawId);
    if (missing.has(id)) continue;          // §9: физически нет такой ячейки
    if (byId.has(id)) continue;             // дубликат в справочнике — игнорируем

    // Формат кода (снят с живого справочника): СЕКЦИЯ + ЭТАЖ + ПОЗИЦИЯ,
    // где этаж и позиция — всегда по одной цифре, а секция — всё остальное
    // (1..14). Поэтому разбираем С КОНЦА, а не по фиксированной длине:
    //   "244"  -> секция 2,  этаж 4, позиция 4
    //   "1244" -> секция 12, этаж 4, позиция 4
    if (!/^\d{3,}$/.test(id)) {
      byId.set(id, { id, kind: null, section: null, floor: null, position: null, unparsed: true });
      continue;
    }

    const section = id.slice(0, -2);
    const floor = id.slice(-2, -1);
    const position = id.slice(-1);

    if (wallEnabled && isWall(id, section)) {
      byId.set(id, { id, kind: CELL_KINDS.WALL, section, floor, position });
      wall.push(id);
      continue;
    }

    const kind = isBigCell(section, floor, position, config) ? CELL_KINDS.BIG : CELL_KINDS.STANDARD;
    byId.set(id, { id, kind, section, floor, position });
    (kind === CELL_KINDS.BIG ? big : standard).push(id);
  }

  const unparsed = [...byId.values()].filter(m => m.unparsed).map(m => m.id);

  return { byId, standard, big, wall, unparsed };
}

// ------------------------------------------------------------------
// §5. Размер
// ------------------------------------------------------------------

/**
 * Числовой "вес" одного товара по его size_tier. Неизвестный тир считаем
 * самым мелким из настроенных, а не 0 — иначе товар с опечаткой в тире
 * стал бы невидимым для порогов и бесконечно наполнял бы общую ячейку.
 */
/**
 * Тир размера по НАСТОЯЩИМ габаритам из справочника WMS.
 *
 * Единицы — миллиметры, подтверждено на живых данных 30.08.2026:
 * дезодорант-спрей приходит как 168×46×29, то есть баллончик 16.8 см.
 *
 * Раньше габаритов не было вовсе, и всякая позиция считалась самой мелкой
 * (`sizeScore` возвращал минимум). Из-за этого раскладка не отличала
 * баллончик от коробки мыла 33×32×32 см и одинаково охотно предлагала им
 * одну и ту же полку.
 *
 * Порогов два, и срабатывает ЛЮБОЙ: объём и наибольшая сторона. Длинная
 * плоская коробка занимает полку целиком, даже когда её объём невелик.
 */
export function sizeTierFromDimensions(dims) {
  const l = Number(dims?.length);
  const w = Number(dims?.width);
  const h = Number(dims?.height);
  if (![l, w, h].every(v => Number.isFinite(v) && v > 0)) return null;

  const volume = l * w * h;               // мм³
  const longest = Math.max(l, w, h);      // мм

  if (longest >= 600 || volume >= 30e6) return 'extra_large';   // от 60 см / 30 л
  if (longest >= 350 || volume >= 8e6) return 'large';          // от 35 см / 8 л
  if (longest >= 200 || volume >= 1e6) return 'medium';         // от 20 см / 1 л
  return 'small';
}

export function sizeScore(item, config) {
  const scores = config?.sizeTierScores || {};
  const tier = item?.size_tier;
  if (tier !== undefined && scores[tier] !== undefined) return Number(scores[tier]) || 0;
  const values = Object.values(scores).map(Number).filter(Number.isFinite);
  return values.length ? Math.min(...values) : 1;
}

function groupSizeScore(items, config) {
  return items.reduce((sum, item) => sum + sizeScore(item, config), 0);
}

function groupMaxWeight(items) {
  return items.reduce((max, item) => {
    const w = Number(item?.weight_estimate_kg);
    return Number.isFinite(w) && w > max ? w : max;
  }, 0);
}

// ------------------------------------------------------------------
// §4. Двойной порог: выделенная ячейка или общий пул
// ------------------------------------------------------------------

/**
 * Определяет тир заказа клиента. Срабатывает ЛЮБОЙ из порогов —
 * не "оба сразу" (см. §4).
 */
export function classifyTier(items, config) {
  const th = config?.thresholds || {};
  const shared = th.sharedPool || {};
  const dedicated = th.dedicatedStandard || {};
  // Настенный тир по умолчанию ВЫКЛЮЧЕН: пока для ПВЗ явно не перечислены
  // настенные ячейки, отправлять туда КГТ просто некуда.
  const wallEnabled = config?.wallCells?.enabled === true;

  const score = groupSizeScore(items, config);
  const count = items.length;

  if (wallEnabled && th.kgtSizeScore !== undefined && score >= Number(th.kgtSizeScore)) {
    return { tier: ORDER_TIERS.WALL, score, count };
  }

  const overCount = shared.maxItemCount !== undefined && count > Number(shared.maxItemCount);
  const overSize = shared.maxSizeScore !== undefined && score > Number(shared.maxSizeScore);

  if (overCount || overSize) {
    if (dedicated.maxSizeScore !== undefined && score > Number(dedicated.maxSizeScore)) {
      return { tier: ORDER_TIERS.BIG, score, count, trippedBy: overSize ? 'size' : 'count' };
    }
    return {
      tier: ORDER_TIERS.DEDICATED_STANDARD,
      score,
      count,
      trippedBy: overCount && !overSize ? 'count' : (overSize && !overCount ? 'size' : 'both')
    };
  }

  return { tier: ORDER_TIERS.SHARED_POOL, score, count };
}

// ------------------------------------------------------------------
// §2.1. Ось X — секция, по РАЗМЕРУ
// ------------------------------------------------------------------

function sectionOrder(config, kind) {
  if (kind === CELL_KINDS.WALL) {
    return (config?.wallCells?.severityOrder || []).map(String);
  }
  return (config?.sectionSeverityOrder || []).map(String);
}

/**
 * Куда по шкале тяжести секций "целится" заказ такого размера.
 * 0 — самая удобная секция (начало списка), последний индекс — самая
 * неудобная. Крупное едет в неудобные секции, мелочь остаётся в удобных:
 * мелких заказов на порядок больше, и именно им важна быстрая досягаемость.
 */
function sectionStartIndex(score, sections, config) {
  if (sections.length <= 1) return 0;
  const ceiling = Number(config?.thresholds?.kgtSizeScore) || 0;
  if (!ceiling) return 0;
  const normalized = Math.max(0, Math.min(1, score / ceiling));
  return Math.round(normalized * (sections.length - 1));
}

/**
 * Секции в порядке предпочтения для конкретного заказа: сначала "своя"
 * по градиенту, дальше — ближайшие соседи. При равном расстоянии выбираем
 * БОЛЕЕ тяжёлую секцию, чтобы не съедать удобные секции под заказы,
 * которым они не обязательны.
 */
function sectionsByPreference(score, config, kind) {
  const sections = sectionOrder(config, kind);
  if (!sections.length) return [];
  const start = sectionStartIndex(score, sections, config);

  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => {
      const da = Math.abs(a.index - start);
      const db = Math.abs(b.index - start);
      if (da !== db) return da - db;
      return b.index - a.index; // при равном расстоянии — более тяжёлая секция
    })
    .map(entry => entry.section);
}

// ------------------------------------------------------------------
// §2.2. Ось Y — этаж, по ВЕСУ
// ------------------------------------------------------------------

/**
 * Порядок этажей для заданного веса. Сначала — этажи из подходящей
 * весовой полосы (в порядке, как они записаны в config), затем остальные,
 * отсортированные по удалённости от первого предпочтительного: так тяжёлое
 * при заполненности сползает на соседний низкий этаж, а не улетает наверх.
 *
 * ВАЖНО: для группы берём ВЕС САМОГО ТЯЖЁЛОГО товара, а не суммарный —
 * ограничение здесь физическое ("сколько человек может поднять на эту
 * высоту"), и определяется оно самым тяжёлым предметом в группе.
 */
function floorsByPreference(weightKg, config, availableFloors) {
  const bands = config?.weightBandsKg || [];
  const band = bands.find(b => weightKg <= Number(b.max)) || bands[bands.length - 1];
  const preferred = (band?.preferredFloors || []).map(String);

  const all = [...new Set([...preferred, ...availableFloors.map(String)])];
  const anchor = Number(preferred[0]);

  const rest = all
    .filter(f => !preferred.includes(f))
    .sort((a, b) => {
      if (!Number.isFinite(anchor)) return Number(a) - Number(b);
      const da = Math.abs(Number(a) - anchor);
      const db = Math.abs(Number(b) - anchor);
      if (da !== db) return da - db;
      return Number(a) - Number(b); // при равной удалённости — ниже безопаснее
    });

  return [...preferred, ...rest];
}

// ------------------------------------------------------------------
// Состояние
// ------------------------------------------------------------------

export function createEmptyState() {
  return {
    version: 1,
    cells: {},          // cellId -> { items: [...], dedicatedTo: clientId|null }
    reservations: {}     // clientId -> cellId  (§10, бессрочно)
  };
}

function cellState(state, cellId) {
  if (!state.cells[cellId]) {
    state.cells[cellId] = { items: [], dedicatedTo: null };
  }
  return state.cells[cellId];
}

function cellItems(state, cellId) {
  return state.cells[cellId]?.items || [];
}

function cellCount(state, cellId) {
  return cellItems(state, cellId).length;
}

function cellScore(state, cellId) {
  return cellItems(state, cellId).reduce((sum, it) => sum + (Number(it.sizeScore) || 0), 0);
}

function cellClients(state, cellId) {
  return new Set(cellItems(state, cellId).map(it => it.clientId));
}

function isDedicated(state, cellId) {
  return !!state.cells[cellId]?.dedicatedTo;
}

// ------------------------------------------------------------------
// §6. Жёсткий запрет на совпадающие названия у РАЗНЫХ клиентов
// ------------------------------------------------------------------
// Намеренно НЕ вынесено в config: это правило про то, чтобы не отдать
// покупателю чужой товар, а не про удобство раскладки. Ослабление —
// изменение логики, а не настройки (см. §6 справочника).

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function hasNameCollision(state, cellId, clientId, incomingNames) {
  if (!incomingNames.size) return false;
  for (const item of cellItems(state, cellId)) {
    if (item.clientId === clientId) continue;      // свой же товар — не конфликт
    if (incomingNames.has(normalizeName(item.simplifiedName))) return true;
  }
  return false;
}

function namesOf(items) {
  return new Set(
    items
      .map(it => normalizeName(it.simplified_name))
      .filter(Boolean)
  );
}

// ------------------------------------------------------------------
// Подбор ячеек
// ------------------------------------------------------------------

function candidateCells(index, kind, score, weightKg, config) {
  const pool = kind === CELL_KINDS.WALL ? index.wall
    : kind === CELL_KINDS.BIG ? index.big
      : index.standard;

  const metas = pool.map(id => index.byId.get(id)).filter(Boolean);

  if (kind === CELL_KINDS.WALL) {
    // У настенных ячеек своя шкала: сортируем по позиции кода в
    // wallCells.severityOrder, всё неперечисленное — в конец.
    const order = sectionOrder(config, CELL_KINDS.WALL);
    return metas
      .slice()
      .sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        const ra = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
        const rb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
        if (ra !== rb) return ra - rb;
        return a.id.localeCompare(b.id); // не перечисленные — стабильно по коду
      })
      .map(m => m.id);
  }

  const sections = sectionsByPreference(score, config, kind);
  const availableFloors = [...new Set(metas.map(m => m.floor))];
  const floors = floorsByPreference(weightKg, config, availableFloors);

  const sectionRank = new Map(sections.map((s, i) => [s, i]));
  const floorRank = new Map(floors.map((f, i) => [f, i]));
  const last = Number.MAX_SAFE_INTEGER;

  return metas
    .slice()
    .sort((a, b) => {
      const sa = sectionRank.has(a.section) ? sectionRank.get(a.section) : last;
      const sb = sectionRank.has(b.section) ? sectionRank.get(b.section) : last;
      if (sa !== sb) return sa - sb;
      const fa = floorRank.has(a.floor) ? floorRank.get(a.floor) : last;
      const fb = floorRank.has(b.floor) ? floorRank.get(b.floor) : last;
      if (fa !== fb) return fa - fb;
      return Number(a.position) - Number(b.position);
    })
    .map(m => m.id);
}

function isUntouched(state, cellId) {
  return cellCount(state, cellId) === 0 && !isDedicated(state, cellId);
}

/**
 * Выделенная ячейка (§4, тиры dedicated_standard / big / wall):
 * подходит только полностью пустая — по определению "одна ячейка, один клиент".
 */
function findDedicatedCell(state, index, kind, score, weightKg, config) {
  for (const cellId of candidateCells(index, kind, score, weightKg, config)) {
    if (isUntouched(state, cellId)) return cellId;
  }
  return null;
}

/**
 * §7. Общий пул: сначала уже начатые ячейки, из них — САМАЯ ЗАПОЛНЕННАЯ,
 * в которую заказ ещё влезает и где нет коллизии по названию (§6).
 * Пустую ячейку открываем только когда занятых вариантов не осталось.
 */
function findSharedCell(state, index, group, config) {
  const shared = config?.thresholds?.sharedPool || {};
  const maxCount = shared.maxItemCount !== undefined ? Number(shared.maxItemCount) : Infinity;
  const maxScore = shared.maxSizeScore !== undefined ? Number(shared.maxSizeScore) : Infinity;

  const ordered = candidateCells(index, CELL_KINDS.STANDARD, group.score, group.weightKg, config);
  const rank = new Map(ordered.map((id, i) => [id, i]));

  const started = ordered.filter(cellId =>
    cellCount(state, cellId) > 0 &&
    !isDedicated(state, cellId) &&
    cellCount(state, cellId) + group.count <= maxCount &&
    cellScore(state, cellId) + group.score <= maxScore &&
    !hasNameCollision(state, cellId, group.clientId, group.names)
  );

  if (started.length) {
    started.sort((a, b) => {
      const fa = Math.max(cellCount(state, a) / maxCount, cellScore(state, a) / maxScore);
      const fb = Math.max(cellCount(state, b) / maxCount, cellScore(state, b) / maxScore);
      if (fa !== fb) return fb - fa;                 // плотнее — раньше
      return rank.get(a) - rank.get(b);
    });
    return { cellId: started[0], reason: PLACEMENT_REASONS.SHARED_PACKED };
  }

  for (const cellId of ordered) {
    if (isUntouched(state, cellId)) {
      return { cellId, reason: PLACEMENT_REASONS.SHARED_NEW };
    }
  }
  return { cellId: null, reason: PLACEMENT_REASONS.NO_CAPACITY };
}

/**
 * §8. Карты / RX / SX: ни размера, ни названия — только максимальный разброс.
 * Никогда не эскалируем в big/wall.
 */
function findSpecialCell(state, index, subtype, config) {
  const ordered = candidateCells(index, CELL_KINDS.STANDARD, 0, 0, config);

  for (const cellId of ordered) {
    if (isUntouched(state, cellId)) {
      return { cellId, reason: PLACEMENT_REASONS.SPECIAL_UNTOUCHED };
    }
  }

  const usable = ordered.filter(cellId => !isDedicated(state, cellId));
  if (!usable.length) return { cellId: null, reason: PLACEMENT_REASONS.NO_CAPACITY };

  const rank = new Map(ordered.map((id, i) => [id, i]));
  const sameSubtype = (cellId) =>
    cellItems(state, cellId).filter(it => it.specialType === subtype).length;

  usable.sort((a, b) => {
    const sa = sameSubtype(a);
    const sb = sameSubtype(b);
    if (sa !== sb) return sa - sb;                   // меньше таких же — лучше
    const ca = cellCount(state, a);
    const cb = cellCount(state, b);
    if (ca !== cb) return ca - cb;
    return rank.get(a) - rank.get(b);
  });

  return { cellId: usable[0], reason: PLACEMENT_REASONS.SPECIAL_DOUBLED };
}

// ------------------------------------------------------------------
// Запись результата в состояние
// ------------------------------------------------------------------

function commit(state, cellId, item, config, { dedicatedTo = null } = {}) {
  const cell = cellState(state, cellId);
  cell.items.push({
    clientId: item.client_id,
    simplifiedName: item.simplified_name || null,
    sizeScore: item.special_type ? 0 : sizeScore(item, config),
    specialType: item.special_type || null,
    itemId: item.item_id || item.barcode || null
  });
  if (dedicatedTo) cell.dedicatedTo = dedicatedTo;
  if (item.client_id !== undefined && item.client_id !== null) {
    state.reservations[item.client_id] = cellId;      // §10: бессрочно
  }
}

// ------------------------------------------------------------------
// Движок
// ------------------------------------------------------------------

export class AllocationEngine {
  constructor(config, cellIds, initialState) {
    this.config = config || {};
    this.cellIds = (cellIds || []).map(String);
    this.index = buildCellIndex(this.cellIds, this.config);
    this.state = initialState ? JSON.parse(JSON.stringify(initialState)) : createEmptyState();
    if (!this.state.cells) this.state.cells = {};
    if (!this.state.reservations) this.state.reservations = {};
  }

  static fromState(config, cellIds, state) {
    return new AllocationEngine(config, cellIds, state);
  }

  exportState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  /**
   * Основной вход. items — уже обогащённые записи:
   *   { item_id?, client_id, simplified_name?, size_tier?, weight_estimate_kg?, special_type? }
   * special_type ∈ { 'card', 'rx', 'sx' } — для них size/name игнорируются (§8).
   *
   * Возвращает массив результатов В ТОМ ЖЕ ПОРЯДКЕ, что и вход.
   */
  allocateBatch(items) {
    const list = Array.isArray(items) ? items : [];
    const results = new Map();

    // Группируем по клиенту, сохраняя порядок первого появления —
    // так результат детерминирован и воспроизводим в тестах.
    const groups = new Map();
    list.forEach((item, idx) => {
      const key = String(item?.client_id ?? `__anon_${idx}`);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ item, idx });
    });

    for (const [clientId, entries] of groups) {
      // Сначала обычные (размерные) товары: именно они определяют тир и,
      // если ячейка ещё не закреплена, создают привязку. Спецтипы после —
      // тогда они просто попадут в уже закреплённую ячейку клиента.
      const normal = entries.filter(e => !e.item.special_type);
      const special = entries.filter(e => !!e.item.special_type);

      if (normal.length) this._placeNormalGroup(clientId, normal, results);
      for (const entry of special) this._placeSpecial(clientId, entry, results);
      // (спецтипы намеренно после обычных: если группа только что получила
      // ячейку, карта/RX/SX того же клиента поедет туда же, а не "разбросом")
    }

    return list.map((item, idx) => results.get(idx) || {
      item,
      clientId: item?.client_id ?? null,
      cellId: null,
      tier: null,
      cellKind: null,
      reason: PLACEMENT_REASONS.NO_CAPACITY
    });
  }

  _placeNormalGroup(clientId, entries, results) {
    const items = entries.map(e => e.item);
    const reserved = this.state.reservations[clientId];

    // §10: у клиента уже есть ячейка — тир заново НЕ считаем, кладём туда же.
    if (reserved) {
      for (const { item, idx } of entries) {
        commit(this.state, reserved, item, this.config);
      }
      for (const { item, idx } of entries) {
        results.set(idx, this._result(item, clientId, reserved, null, PLACEMENT_REASONS.RESERVATION));
      }
      return;
    }

    const { tier, score, count, trippedBy } = classifyTier(items, this.config);
    const weightKg = groupMaxWeight(items);

    if (tier === ORDER_TIERS.SHARED_POOL) {
      const { cellId, reason } = findSharedCell(this.state, this.index, {
        clientId, score, count, weightKg, names: namesOf(items)
      }, this.config);
      this._commitGroup(results, entries, cellId, clientId, tier, reason, { trippedBy });
      return;
    }

    const kind = tier === ORDER_TIERS.WALL ? CELL_KINDS.WALL
      : tier === ORDER_TIERS.BIG ? CELL_KINDS.BIG
        : CELL_KINDS.STANDARD;

    let cellId = findDedicatedCell(this.state, this.index, kind, score, weightKg, this.config);

    // Деградация вниз по типам, а не отказ: если настенных/больших ячеек
    // не осталось, крупный заказ лучше положить в обычную выделенную ячейку,
    // чем не дать рекомендации вообще. Чужую занятую ячейку при этом
    // не трогаем ни при каких условиях.
    if (!cellId && kind === CELL_KINDS.WALL) {
      cellId = findDedicatedCell(this.state, this.index, CELL_KINDS.BIG, score, weightKg, this.config);
    }
    if (!cellId && (kind === CELL_KINDS.WALL || kind === CELL_KINDS.BIG)) {
      cellId = findDedicatedCell(this.state, this.index, CELL_KINDS.STANDARD, score, weightKg, this.config);
    }

    this._commitGroup(
      results,
      entries,
      cellId,
      clientId,
      tier,
      cellId ? PLACEMENT_REASONS.DEDICATED : PLACEMENT_REASONS.NO_CAPACITY,
      { trippedBy, dedicated: true }
    );
  }

  _placeSpecial(clientId, entry, results) {
    const { item, idx } = entry;
    const subtype = item.special_type;
    const enabled = this.config?.specialTypeToggles?.[subtype];

    if (!enabled) {
      // Выключенный тип не получает рекомендации вообще — оператор
      // пользуется родной подсказкой WMS (§8).
      results.set(idx, this._result(item, clientId, null, null, PLACEMENT_REASONS.SPECIAL_DISABLED));
      return;
    }

    const reserved = this.state.reservations[clientId];
    if (reserved) {
      commit(this.state, reserved, item, this.config);
      results.set(idx, this._result(item, clientId, reserved, null, PLACEMENT_REASONS.RESERVATION));
      return;
    }

    const { cellId, reason } = findSpecialCell(this.state, this.index, subtype, this.config);
    if (cellId) commit(this.state, cellId, item, this.config);
    results.set(idx, this._result(item, clientId, cellId, null, reason));
  }

  _commitGroup(results, entries, cellId, clientId, tier, reason, extra = {}) {
    for (const { item } of entries) {
      if (cellId) {
        commit(this.state, cellId, item, this.config, {
          dedicatedTo: extra.dedicated ? clientId : null
        });
      }
    }
    // Результаты пишем ВТОРЫМ проходом, когда состояние ячейки уже обновлено
    // целиком — иначе первый товар группы отражал бы ещё пустую ячейку.
    for (const { item, idx } of entries) {
      results.set(idx, this._result(item, clientId, cellId, tier, reason, extra));
    }
  }

  _result(item, clientId, cellId, tier, reason, extra = {}) {
    const meta = cellId ? this.index.byId.get(cellId) : null;
    return {
      item,
      clientId,
      cellId,
      tier: tier || null,
      cellKind: meta ? meta.kind : null,
      section: meta ? meta.section : null,
      floor: meta ? meta.floor : null,
      reason,
      ...extra
    };
  }

  /**
   * §10. Ручной перенос: оператор положил товар не туда, куда советовали.
   * Только бухгалтерия — минус в старой ячейке, плюс в новой. Никакой
   * истории и никакого обучения на этом не строится.
   */
  applyOverride({ clientId, fromCellId, toCellId, itemId = null }) {
    const from = this.state.cells[fromCellId];
    if (from) {
      const pos = from.items.findIndex(it =>
        String(it.clientId) === String(clientId) &&
        (itemId === null || String(it.itemId) === String(itemId))
      );
      if (pos !== -1) {
        const [moved] = from.items.splice(pos, 1);
        const target = cellState(this.state, toCellId);
        target.items.push(moved);
        if (from.dedicatedTo && String(from.dedicatedTo) === String(clientId) && !from.items.length) {
          from.dedicatedTo = null;
          target.dedicatedTo = clientId;
        }
      }
    }
    this.state.reservations[clientId] = toCellId;
    return this.exportState();
  }

  /** Плоский снимок "что где лежит" — для таблицы в UI. */
  snapshot() {
    return Object.entries(this.state.cells)
      .filter(([, cell]) => cell.items.length)
      .map(([cellId, cell]) => ({
        cellId,
        kind: this.index.byId.get(cellId)?.kind || null,
        dedicatedTo: cell.dedicatedTo,
        count: cell.items.length,
        score: cell.items.reduce((s, it) => s + (Number(it.sizeScore) || 0), 0),
        clients: [...new Set(cell.items.map(it => it.clientId))],
        items: cell.items.slice()
      }))
      .sort((a, b) => a.cellId.localeCompare(b.cellId));
  }
}
