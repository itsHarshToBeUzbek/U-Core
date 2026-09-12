// ==========================================
// background.js — массовая выгрузка данных WMS
// ==========================================
// Service worker (MV3, тип "module"). Живёт отдельно от попапа намеренно:
// попап закрывается, как только оператор кликнул мимо, а выгрузка сотен
// заказов идёт минуты. Здесь она переживает закрытие попапа, а попап просто
// показывает прогресс из chrome.storage.
//
// ГРАНИЦА БЕЗОПАСНОСТИ, которую нельзя размывать при доработках:
// сюда попадают только GET-запросы по адресам, которые страница WMS уже
// делала сама (каталог шаблонов из content.js), и только те, что прошли
// проверку isSafeToReplay. Ни одного придуманного адреса, ни одного POST,
// ничего из изменяющих эндпоинтов. Массовое листание списка — это то же
// самое, что оператор делает глазами, только быстрее.

import './wms-parse.js';
import { AllocationEngine, PLACEMENT_REASONS, sizeTierFromDimensions, sizeScore } from './allocation-core.js';
import {
  KNOWN_ENDPOINTS,
  setApiBase,
  setAuthHeaders,
  hasAuthHeaders,
  setFetcher,
  getLastTransport,
  getLastBridgeError,
  fetchAllPages,
  fetchOrderItems,
  fetchOrderContents,
  fetchSkuCatalog,
  searchShipment,
  apiGet,
  sleep
} from './wms-api.js';

// Словарь названий. Классический скрипт: он же подключается на страницах
// расширения тегом <script>, поэтому наружу отдаёт себя через globalThis, а
// не через export. Импорт нужен ради побочного эффекта — после него
// globalThis.UCoreSkuName есть и в service worker.
import './sku-name.js';
import * as nameLlm from './name-llm.js';

const LOG = '[U-Core sync]';

// Версия формата собранных записей. Меняется, когда меняется НАБОР
// источников или разбор полей. При несовпадении накопленные записи
// сбрасываются один раз: иначе после обновления в таблице остаётся смесь
// старых, собранных сломанным кодом строк (без ячеек, без источника) и
// новых — и понять, работает расширение или нет, невозможно. Справочники
// ячеек и товаров при этом сохраняются: они не портились.
// 4 — сменился ключ записи (в него вошёл внутренний номер отправления) и
//     правила обрезки хранилища. Накопленное сбрасывается один раз: у тех,
//     кто работал на прежней версии, база успела раздуться до потолка, и
//     обрезка выбрасывала из неё живые заказы. Чистый старт надёжнее любой
//     миграции, а весь список заказов возвращается одним нажатием кнопки.
// 5 — накопленные записи РАЗДВОЕНЫ. Строка заказа переливала в строку
//     товара внутренний номер отправления, а он входит в ключ: на каждом
//     следующем сборе та же вещь ложилась в таблицу заново. В ячейке
//     появлялось «1 из 2» там, где лежит одна вещь, ячейка не закрывалась,
//     и недостача выглядела настоящей до прихода клиента. Само собой это
//     не рассосётся: у заказа, все вещи которого уже с ячейками, товары
//     больше не запрашиваются, и чистить нечем. Поэтому — чистый старт.
const RECORDS_SCHEMA = 5;

async function resetStaleRecords() {
  const { priemkaSchema } = await chrome.storage.local.get(['priemkaSchema']);
  if (priemkaSchema === RECORDS_SCHEMA) return false;
  await chrome.storage.local.set({ priemkaRecords: [], priemkaSchema: RECORDS_SCHEMA });
  console.log(`${LOG} формат записей обновлён до ${RECORDS_SCHEMA}, накопленное очищено`);
  return true;
}
// СКОЛЬКО ЗАПИСЕЙ ХРАНИМ.
//
// У ПВЗ 358 ячеек; живых строк на полке — сотни, не тысячи. Остальное —
// история выданных заказов, и она росла без всякого предела: каждый сбор
// добавлял пару сотен записей. Упёршись в прежний потолок 20000, обрезка
// начинала выбрасывать ЖИВЫЕ заказы — недобор на несколько десятков,
// который выглядел как пропажа товара.
//
// Теперь потолок ниже (chrome.storage.local даёт всего 10 МБ, а 20000
// записей — это почти 7 МБ), а истории отведена своя доля: живому всегда
// остаётся на порядок больше места, чем ему нужно.
const MAX_RECORDS = 8000;
const MAX_HISTORY = 3000;

const parser = () => globalThis.UCoreWmsParse;

// ------------------------------------------------------------------
// Запросы руками открытой вкладки WMS
// ------------------------------------------------------------------
// Почему так, а не своим fetch: у вкладки авторизация заведомо рабочая —
// это та же сессия, в которой оператор прямо сейчас работает, с тем же
// токеном, который приложение само обновляет. Любая попытка её повторить
// со стороны расширения — догадка, и именно на этой догадке всё ломалось
// (401 при живой сессии). Просить вкладку — единственный способ не гадать.
//
// Вкладка выполняет только GET и только по адресам /de/ и /or/; список
// запрещённых путей проверяется на её стороне ещё раз (wms-harvester.js),
// так что ошибка здесь не может превратиться в изменяющий запрос.

// Адреса вкладок берём из манифеста, а не строкой в коде. В этом проекте
// зашитый домен ломал всё уже четыре раза: код молча ничего не делал и
// при этом не проверялся тестами. Манифест — единственное место, где
// список страниц WMS должен быть записан.
function pageTabPatterns() {
  try {
    const manifest = chrome.runtime.getManifest();
    const patterns = (manifest.content_scripts || [])
      .flatMap(entry => entry.matches || []);
    return [...new Set(patterns)];
  } catch (e) {
    return [];
  }
}

function isWmsUrl(url) {
  return pageTabPatterns().some((pattern) => {
    const re = new RegExp('^' + pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*') + '$');
    return re.test(url);
  });
}

async function findWmsTabs() {
  const patterns = pageTabPatterns();
  if (!patterns.length) return [];
  try {
    const tabs = await chrome.tabs.query({ url: patterns });
    // Один и тот же таб может подойти под несколько шаблонов.
    const seen = new Set();
    return tabs.filter(tab => (seen.has(tab.id) ? false : seen.add(tab.id)));
  } catch (e) {
    return [];
  }
}

async function pageFetch(url, { method = 'GET', body = null } = {}) {
  const tabs = await findWmsTabs();
  if (!tabs.length) return { ok: false, error: 'нет открытой вкладки dp.uzum.uz' };
  // Активная вкладка первой: у неё точно не выгружен процесс рендера.
  tabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  let lastError = 'вкладка не ответила';
  for (const tab of tabs) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, {
        type: 'ucore:page-fetch', url, method, body
      });
      if (reply) {
        if (reply.ok || typeof reply.status === 'number') return reply;
        lastError = reply.error || lastError;
      }
    } catch (err) {
      lastError = String(err && err.message || err);
    }
  }
  return { ok: false, error: lastError };
}

// ---------- состояние прогресса ----------

// СТАТУС ПИШЕМ НЕ ЧАЩЕ, ЧЕМ ЕГО МОЖНО ПРОЧЕСТЬ.
//
// Каждый вызов — это чтение и запись целого объекта в хранилище. В цикле на
// две сотни заказов таких вызовов набегали сотни, и они заметно замедляли
// сам сбор — ради строки, которую глаз всё равно не успевает прочитать.
// Поэтому промежуточные сообщения о ходе работы склеиваются: не чаще раза
// в 250 мс. Важные (конец шага, ошибка) идут сразу — с флагом now.
const STATUS_THROTTLE_MS = 250;
let statusPending = null;
let statusLastAt = 0;
let statusTimer = null;

async function flushStatus() {
  if (!statusPending) return;
  const patch = statusPending;
  statusPending = null;
  statusLastAt = Date.now();
  const { priemkaSync } = await chrome.storage.local.get(['priemkaSync']);
  const next = { ...(priemkaSync || {}), ...patch, at: Date.now() };
  await chrome.storage.local.set({ priemkaSync: next });
  return next;
}

async function setStatus(patch, { now = false } = {}) {
  statusPending = { ...(statusPending || {}), ...patch };
  const since = Date.now() - statusLastAt;
  if (now || since >= STATUS_THROTTLE_MS) {
    clearTimeout(statusTimer);
    statusTimer = null;
    return flushStatus();
  }
  if (!statusTimer) {
    statusTimer = setTimeout(() => { statusTimer = null; flushStatus(); },
                             STATUS_THROTTLE_MS - since);
  }
  return null;
}

async function getStatus() {
  const { priemkaSync } = await chrome.storage.local.get(['priemkaSync']);
  return priemkaSync || { running: false };
}

// ------------------------------------------------------------------
// Одновременные запросы
// ------------------------------------------------------------------
// Раньше сбор шёл строго по одному запросу за раз и ещё спал по 120 мс
// между ними. На живом ПВЗ это 215 заказов без ячейки: 215 обращений
// подряд, каждое через мост во вкладку, плюс 26 секунд чистого сна. Сбор
// занимал минуты, и оператор просто переставал им пользоваться.
//
// Теперь запросы идут пулом: несколько одновременно, но не больше POOL.
// Это не «долбить сервер» — столько же соединений открывает сама страница
// WMS, когда рисует список. Порядок результатов сохраняется, а любой
// работник может остановить весь пул (истёкшая сессия, потеря связи).

const POOL = 6;

async function mapPool(items, worker, { limit = POOL, onProgress } = {}) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  let stopped = null;

  const runner = async () => {
    while (true) {
      if (stopped) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i, () => { stopped = stopped || new Error('stop'); });
      } catch (err) {
        results[i] = { __error: err };
      }
      done++;
      if (onProgress) await onProgress(done, items.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return results;
}

// ---------- разбор и слияние ----------

async function mergeRecords(incoming) {
  if (!incoming.length) return { added: 0, enriched: 0, total: 0, dropped: 0, droppedLive: 0, restored: 0 };
  const { priemkaRecords } = await chrome.storage.local.get(['priemkaRecords']);
  const result = parser().mergeRecords(priemkaRecords || [], incoming, MAX_RECORDS);
  await chrome.storage.local.set({
    priemkaRecords: result.records,
    priemkaUpdatedAt: Date.now()
  });
  return {
    added: result.added,
    enriched: result.enriched,
    total: result.records.length,
    dropped: result.dropped || 0,
    droppedLive: result.droppedLive || 0,
    restored: result.restored || 0
  };
}

/**
 * ЧИСТКА ИСТОРИИ — чтобы хранилище не упиралось в предел.
 *
 * Записи о выданных заказах не удаляются: оператор должен видеть, что было.
 * Но «было» — это последние недели, а не последние месяцы. Без чистки база
 * росла на пару сотен записей за каждый сбор, упиралась в предел, и обрезка
 * начинала выбрасывать ЖИВЫЕ заказы — тот самый недобор на несколько
 * десятков, который невозможно было объяснить.
 */
const HISTORY_DAYS = 21;

async function purgeHistory(counters) {
  const { priemkaRecords } = await chrome.storage.local.get(['priemkaRecords']);
  const records = priemkaRecords || [];
  if (!records.length) return { skipped: true };

  const edge = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const fresh = records.filter(r => !(r.gone && Number(r.goneAt) && Number(r.goneAt) < edge));

  // И по числу тоже: у истории своя доля, чтобы живое никогда не боролось
  // с ней за место. Оставляем самые свежие пометки.
  const live = fresh.filter(r => !r.gone);
  const history = fresh.filter(r => r.gone)
    .sort((a, b) => (Number(a.goneAt) || 0) - (Number(b.goneAt) || 0));
  const keptHistory = history.length > MAX_HISTORY
    ? history.slice(history.length - MAX_HISTORY)
    : history;
  const kept = keptHistory.concat(live);
  const removed = records.length - kept.length;
  if (!removed) return { skipped: true };

  await chrome.storage.local.set({ priemkaRecords: kept, priemkaUpdatedAt: Date.now() });
  counters.purged = removed;
  await setStatus({ step: `Чистка истории: убрано ${removed} записей старше ${HISTORY_DAYS} дней` });
  return { removed };
}

/**
 * Итоги слияния — в счётчики сбора, одним местом на все шаги.
 * Возврат пометки «выдан» теперь случается прямо в слиянии, и посчитать его
 * надо там же: иначе оператор не узнает, что заказ вернулся на полку.
 */
function tally(counters, part) {
  counters.added += part.added;
  counters.enriched += part.enriched;
  counters.restored = (counters.restored || 0) + (part.restored || 0);
  counters.dropped = (counters.dropped || 0) + (part.dropped || 0);
  counters.droppedLive = (counters.droppedLive || 0) + (part.droppedLive || 0);
  return part;
}

async function saveCells(cells) {
  if (!cells || !cells.length) return 0;
  const { priemkaCells } = await chrome.storage.local.get(['priemkaCells']);
  const merged = [...new Set([...(priemkaCells || []), ...cells])].sort();
  await chrome.storage.local.set({ priemkaCells: merged, priemkaCellsAt: Date.now() });
  return merged.length;
}

/** Приводит страницу ответа к записям тем же разбором, что и пассивный перехват. */
function recordsFromPage(url, data) {
  return parser().normalizeCapture({ url, method: 'GET', status: 200, response: data, at: Date.now() }).records;
}

// ---------- ключ ПВЗ ----------

/**
 * Номер ПВЗ (298 для ТАШ-120). Всё остальное расширение знает само:
 * адреса эндпоинтов зафиксированы в wms-api.js и проверены на живой
 * системе. Раньше здесь был «каталог подсмотренных шаблонов» — расширение
 * запоминало запросы страницы и потом их повторяло. Он больше не нужен и
 * удалён: угадывать нечего, а лишний слой ломался чаще, чем помогал.
 */
async function resolveDpKey() {
  const { priemkaDpKey } = await chrome.storage.local.get(['priemkaDpKey']);
  return priemkaDpKey ? String(priemkaDpKey) : null;
}

// ---------- шаги выгрузки ----------

/**
 * Постраничное чтение списка с СОХРАНЕНИЕМ КАЖДОЙ СТРАНИЦЫ СРАЗУ.
 *
 * Раньше страницы копились в памяти и записывались одним куском в конце.
 * Обрыв на последней странице (сеть моргнула, вкладку обновили, WMS ответил
 * ошибкой) выбрасывал ВСЁ, что уже прочитали, — и сбор молча заканчивался
 * на части данных. Теперь каждая страница ложится в хранилище сразу:
 * прерванный сбор теряет только недочитанное, а не всё сразу.
 */
async function syncList(url, label, counters, progress) {
  let got = 0;
  let saved = 0;
  // СЧИТАЕМ ДВЕ РАЗНЫЕ ВЕЩИ, А НЕ ОДНУ.
  //
  // Строка списка и заказ — это НЕ одно и то же. У потоварной выдачи один
  // заказ приходит несколькими строками (по строке на товар), и у них общий
  // b2cOrderId. Пока сбор сравнивал «уникальные заказы в базе» со счётчиком
  // WMS, он вычитал одно из другого и объявлял недостачу на ровном месте.
  // Теперь видно и то, и другое — и сравнивать есть с чем.
  const b2cRowsSeen = { rows: 0, orders: new Set() };
  const partnerRowsSeen = { rows: 0, orders: new Set() };

  // ПРОЧИТАННОЕ — НЕ НЕУДАЧА, ДАЖЕ ЕСЛИ ДАЛЬШЕ ОБОРВАЛОСЬ.
  //
  // Страницы ложатся в хранилище сразу, поэтому обрыв на четвёртой странице
  // означает «прочитано триста заказов из трёхсот пятидесяти», а не «сбор не
  // состоялся». Бросать отсюда ошибку значит превратить частичный успех в
  // полный отказ — и заслонить единственное, что оператору здесь важно:
  // список дочитан не до конца, числа неполные.
  //
  // А вот если не прочиталось НИЧЕГО — это настоящая неудача шага, и её
  // надо бросить наверх, иначе сбор с мёртвой вкладкой отрапортует «готово».
  let broke = null;
  try {
  await fetchAllPages(url, {
    // Пятисотка на странице — не конец сбора: пробуем ещё, и говорим об этом
    // вслух, чтобы пауза не выглядела зависанием.
    onRetry: async ({ page, attempt, of }) => {
      await setStatus({ step: `${label}: страница ${page + 1} не отдалась, попытка ${attempt} из ${of}…` });
    },
    onPage: async (data, page, count) => {
      const pageRecords = recordsFromPage(url, data);
      got += pageRecords.length;

      // Запоминаем, что WMS показал СЕЙЧАС — по этому списку потом видно,
      // какие заказы исчезли (клиент забрал) со времени прошлого сбора.
      for (const r of pageRecords) {
        const id = r.orderId || r.orderBarcode;
        if (progress && progress.seenOrders && id) progress.seenOrders.add(String(id));
        const bucket = r.partner ? partnerRowsSeen : b2cRowsSeen;
        bucket.rows++;
        if (id) bucket.orders.add(String(id));
      }

      if (pageRecords.length) {
        tally(counters, await mergeRecords(pageRecords));
        saved += pageRecords.length;
      }

      counters.pages++;
      await setStatus({
        step: `${label}: страница ${page + 1}, получено ${got}`,
        pages: counters.pages
      });
    }
  });

  } catch (err) {
    if (!saved) throw err;
    broke = err;
    await setStatus({
      step: `${label}: оборвалось на странице ${counters.pages + 1}, прочитано ${got}`
    }, { now: true });
  }

  // Список дочитан до конца — только теперь сверке можно доверять.
  if (progress && !broke) progress.complete = true;
  counters.listGot = got;
  counters.listSaved = saved;
  counters.listB2CRows = b2cRowsSeen.rows;
  counters.listB2COrders = b2cRowsSeen.orders.size;
  counters.listPartnerRows = partnerRowsSeen.rows;
  counters.listPartnerOrders = partnerRowsSeen.orders.size;
  return { added: 0, enriched: 0, got, saved, incomplete: !!broke };
}

/**
 * ПОЗИЦИИ ЗАКАЗА — СНИМОК, А НЕ ПРИБАВКА.
 *
 * `/de/v2/delivery-point/b2c-orders/items?b2cOrderId=X` отдаёт ВСЁ текущее
 * содержимое заказа X. Значит всё, что мы держим по этому заказу и чего в
 * свежем ответе нет, — это прошлое, и хранить его нельзя.
 *
 * Зачем это понадобилось. В ключе записи есть `skuItemId` — номер физической
 * единицы; он и разводит одинаковые товары одного заказа, чтобы четыре
 * одинаковые вещи считались четырьмя. Но этот номер у WMS не вечный: когда
 * позицию перекладывают или переоформляют, она приходит с НОВЫМ номером. По
 * ключу это другая запись, и рядом с настоящей единицей оставался её призрак.
 *
 * На экране это выглядело как «1 из 2» там, где лежит ровно одна вещь:
 * ячейка не закрывалась никогда, а оператор искал товар, которого нет.
 * Хуже того — недостача выглядела настоящей ровно до того момента, когда за
 * заказом придёт клиент.
 *
 * Трогаем ТОЛЬКО те заказы, по которым сейчас пришёл ответ, и только строки
 * с товаром (у них есть штрихкод). Заголовки заказов, позиции коробов и
 * заказы, по которым WMS ответил ошибкой, остаются нетронутыми.
 */
async function dropStaleItems(fresh, answeredOrders) {
  if (!answeredOrders || !answeredOrders.size) return 0;

  const { priemkaRecords } = await chrome.storage.local.get(['priemkaRecords']);
  const records = priemkaRecords || [];
  if (!records.length) return 0;

  const keyOf = (r) => parser().recordKey(r);
  const freshKeys = new Set((fresh || []).map(keyOf));

  const kept = records.filter((r) => {
    if (!r || r.source === 'cargo') return true;
    if (!r.barcode) return true;                       // не строка товара
    if (!answeredOrders.has(String(r.orderId))) return true;
    return freshKeys.has(keyOf(r));                    // есть в свежем ответе
  });

  const dropped = records.length - kept.length;
  if (dropped) {
    await chrome.storage.local.set({ priemkaRecords: kept, priemkaUpdatedAt: Date.now() });
  }
  return dropped;
}

/**
 * ЧТО ВНУТРИ ПОСЫЛКИ — у FBS и всего, что приезжает заказом целиком.
 *
 * Потоварный заказ расписан по вещам, и у каждой своя ячейка. У FBS вещь
 * одна — запечатанный пакет, а что в нём, `b2c-orders/items` не отдаёт:
 * поле `items` приходит пустым. Из-за этого оператор, ударивший по ШК
 * ВНУТРИ пакета (он виден через плёнку, а ярлык пакета — на обороте),
 * получал «WMS о таком не знает» и настоящее расхождение на ровном месте.
 *
 * Состав живёт в ДРУГОЙ службе WMS — `/or/orders/v2?b2cOrderId=`. Это тот
 * самый запрос, которым сам WMS рисует вкладку «Товары» в карточке заказа
 * на экране «Заказы». Ответ разложен по ФИЗИЧЕСКИМ посылкам: у каждой свой
 * штрихкод, и состав привязывается к ней, а не к заказу целиком.
 *
 * Партнёрские (uzum-bank, Uzum Global, Aliexpress) отвечают пятисоткой —
 * их состав неизвестен и самому WMS, у них и вкладки «Товары» нет. Это не
 * ошибка сбора: такие заказы просто пропускаются.
 *
 * Названия и ШК товаров берутся из того же справочника, что и везде:
 * `POST /de/sku/basic/all/id` по skuId.
 */
// СОСТАВ ЗАПЕЧАТАННОГО ПАКЕТА НЕ МЕНЯЕТСЯ.
//
// Его сложил продавец до отправки, и до самой выдачи внутрь никто не лезет.
// Значит спрашивать его повторно не за чем: на живом ПВЗ это девяносто один
// одинаковый ответ на каждое нажатие кнопки.
//
// Заказы, по которым WMS состав не отдаёт (партнёрские — пятисотка), тоже
// запоминаются: иначе каждый сбор снова упирался бы в ту же стену. Через
// сутки пробуем ещё раз — вдруг у WMS что-то поменялось.
const PACKAGE_MISS_TTL_MS = 24 * 60 * 60 * 1000;

async function syncPackageContents(counters) {
  const { priemkaRecords, priemkaFbsContents, priemkaPackageMisses } =
    await chrome.storage.local.get(['priemkaRecords', 'priemkaFbsContents', 'priemkaPackageMisses']);

  const have = priemkaFbsContents || {};
  const misses = priemkaPackageMisses || {};
  const now = Date.now();

  // ОДИН ЗАПРОС НА ЗАКАЗ, НО СОСТАВ — НА КАЖДУЮ ПОСЫЛКУ.
  //
  // Ответ про заказ приходит сразу обо всех его коробках, поэтому спрашиваем
  // по заказу. А раскладываем по посылкам: у заказа их бывает восемь, и лежат
  // они в разных ячейках со своим содержимым в каждой.
  const packagesOf = new Map();          // заказ -> ключи его посылок
  for (const r of priemkaRecords || []) {
    if (!r || r.gone || r.source === 'cargo' || r.partner) continue;
    if (!parser().isWholeOrder(r) || !r.orderId) continue;
    const id = String(r.orderId);
    if (!/^\d+$/.test(id)) continue;
    if (!packagesOf.has(id)) packagesOf.set(id, new Set());
    packagesOf.get(id).add(parser().packageKey(r));
  }
  const wanted = [...packagesOf.keys()];

  // Спрашиваем только то, чего ещё нет. Заказ считается известным, только
  // если известна КАЖДАЯ его посылка: приехавшая позже вторая коробка
  // иначе осталась бы без состава навсегда.
  // СЧИТАЕМ ПО ЗАКАЗУ, А НЕ ПО СОВПАДЕНИЮ КЛЮЧЕЙ. Ключ в хранилище приходит
  // из ответа WMS (номер отправления), ключ записи — из списка заказов. В
  // живых данных это одно и то же число, но полагаться на совпадение нельзя:
  // разойдись они — и заказ спрашивался бы заново каждый сбор. Поэтому
  // сравниваем КОЛИЧЕСТВО: известных посылок заказа должно быть не меньше,
  // чем его строк на полке. Приехавшая позже вторая коробка так и находится.
  const storedFor = new Map();
  for (const [key, box] of Object.entries(have)) {
    if (!box || box.source !== 'wms' || !box.items || !Object.keys(box.items).length) continue;
    const id = String(box.orderId || key);
    storedFor.set(id, (storedFor.get(id) || 0) + 1);
  }
  const ids = forceFull ? wanted : wanted.filter((id) => {
    if ((storedFor.get(id) || 0) < packagesOf.get(id).size) {
      const missedAt = Number(misses[id]) || 0;
      return !(missedAt && now - missedAt < PACKAGE_MISS_TTL_MS);
    }
    return false;
  });

  counters.packagesKnown = wanted.length - ids.length;

  if (!ids.length) {
    await setStatus({
      step: wanted.length
        ? `Составы посылок: все ${wanted.length} уже известны`
        : 'Составы посылок: посылок целиком нет'
    });
    return { skipped: true };
  }

  await setStatus({ step: `Составы посылок: ${ids.length} новых из ${wanted.length}` });

  const noContents = [];
  let authError = null;
  const answers = await mapPool(ids, async (id, _i, stop) => {
    try {
      return { id, shipments: await fetchOrderContents(id) };
    } catch (err) {
      const status = err && err.status;
      // 401/403 — сессия кончилась, дальше идти незачем.
      if (status === 401 || status === 403) { authError = err; stop(); return null; }
      noContents.push(id);
      return null;
    }
  }, {
    onProgress: async (done, total) => {
      await setStatus({ step: `Составы посылок: ${done} из ${total} заказов` });
    }
  });

  if (authError) {
    await setStatus({ step: `Составы посылок: остановлено — WMS отклонил авторизацию (${authError.status})` },
                    { now: true });
    throw authError;
  }

  // Один запрос справочника на весь сбор, а не по заказу.
  const skuIds = [];
  for (const answer of answers) {
    if (!answer) continue;
    for (const shipment of answer.shipments) for (const item of shipment.items) skuIds.push(item.skuId);
  }
  const rows = skuIds.length
    ? await fetchSkuCatalog(KNOWN_ENDPOINTS.skuCatalog(), skuIds)
    : [];
  const bySku = new Map();
  for (const row of rows) if (row && row.id) bySku.set(Number(row.id), row);

  const store = { ...(priemkaFbsContents || {}) };
  let orders = 0;
  let packages = 0;
  let items = 0;

  for (const answer of answers) {
    if (!answer) continue;
    // РАСКЛАДЫВАЕМ ПО ПОСЫЛКАМ. Раньше здесь бралась ОДНА коробка заказа и
    // её содержимое приписывалось заказу целиком: на ПВЗ, где заказ
    // приезжает тремя коробками в три разные ячейки, оператор искал бы в
    // одной ячейке то, что лежит в другой.
    for (const shipment of answer.shipments) {
    if (!shipment || !shipment.items.length) continue;
    const key = shipment.wmsOrderId || answer.id;

    const prev = store[key] || {};
    // ВЫУЧЕННОЕ СКАНАМИ НЕ ВЫБРАСЫВАЕМ. WMS знает, что положил продавец;
    // оператор мог найти в пакете и то, чего в списке нет. Список из WMS
    // перекрывает совпавшие строки и остаётся главным, чужие — остаются
    // рядом со своей пометкой.
    const kept = {};
    for (const [barcode, info] of Object.entries((prev && prev.items) || {})) {
      if (info && info.source !== 'wms') kept[barcode] = info;
    }

    const next = {};
    for (const item of shipment.items) {
      const row = bySku.get(item.skuId);
      const barcode = (row && row.barcode) ? String(row.barcode) : `sku:${item.skuId}`;
      const before = next[barcode];
      next[barcode] = {
        count: (before ? before.count : 0) + (item.amount || 1),
        name: (row && (row.description || row.title)) || (before && before.name) || null,
        skuId: item.skuId,
        source: 'wms'
      };
      delete kept[barcode];
      items++;
    }

    store[key] = {
      orderId: answer.id,
      orderBarcode: shipment.barcode || (prev && prev.orderBarcode) || null,
      wmsOrderId: shipment.wmsOrderId || null,
      cell: (prev && prev.cell) || null,
      clientName: (prev && prev.clientName) || null,
      items: { ...kept, ...next },
      source: 'wms',
      updatedAt: Date.now()
    };
    packages++;
    }
    orders++;
  }

  // ОТКАЗЫ ЗАПОМИНАЕМ. Партнёрские отвечают пятисоткой всегда, и без этого
  // каждый сбор снова стучался бы в ту же дверь.
  const nextMisses = {};
  const alive = new Set(wanted);
  for (const [id, at] of Object.entries(misses)) {
    if (alive.has(id) && now - (Number(at) || 0) < PACKAGE_MISS_TTL_MS) nextMisses[id] = at;
  }
  for (const id of noContents) nextMisses[id] = now;

  // Составы заказов, которых в базе больше нет вовсе (история дочищена,
  // клиент забрал давно), держать незачем.
  const keep = new Set();
  for (const r of priemkaRecords || []) {
    if (!r) continue;
    if (r.orderId) keep.add(String(r.orderId));      // старые записи по заказу
    const k = parser().packageKey(r);
    if (k) keep.add(k);
  }
  let forgotten = 0;
  for (const id of Object.keys(store)) {
    if (!keep.has(id)) { delete store[id]; forgotten++; }
  }

  await chrome.storage.local.set({ priemkaFbsContents: store, priemkaPackageMisses: nextMisses });
  counters.packages = packages;
  counters.packageOrders = orders;
  counters.packageItems = items;
  counters.packagesUnknown = noContents.length;
  counters.packagesForgotten = forgotten;

  await setStatus({
    step: noContents.length
      ? `Составы посылок: ${packages} новых, состав не отдали по ${noContents.length}`
      : `Составы посылок: ${packages} новых`,
    packages
  });
  return { orders, packages, items };
}

// Справочник ячеек — самое НЕПОДВИЖНОЕ, что есть у ПВЗ: 358 ячеек, которые
// меняются, когда в зале переставляют стеллажи, то есть примерно никогда.
// Тянуть его на каждое нажатие кнопки — две страницы ожидания за просто так.
const CELLS_TTL_MS = 6 * 60 * 60 * 1000;    // обычная свежесть
const CELLS_RETRY_MS = 20 * 60 * 1000;      // если встретилась незнакомая ячейка

async function syncCells(url, counters) {
  const { priemkaCells, priemkaCellsAt, priemkaRecords } = await chrome.storage.local.get(
    ['priemkaCells', 'priemkaCellsAt', 'priemkaRecords']
  );
  const known = priemkaCells || [];
  const age = Date.now() - (Number(priemkaCellsAt) || 0);

  // САМОЛЕЧЕНИЕ. Если в записях появилась ячейка, которой в справочнике нет,
  // справочник мог просто устареть — перечитываем, не дожидаясь срока. Но не
  // чаще, чем раз в двадцать минут: мусорная строка в поле «ячейка» не должна
  // превращаться в лишний запрос при каждом нажатии.
  let stranger = false;
  if (known.length) {
    const set = new Set(known.map(String));
    for (const record of priemkaRecords || []) {
      if (record && record.cell && !set.has(String(record.cell))) { stranger = true; break; }
    }
  }

  const fresh = !forceFull && known.length
    && age < (stranger ? CELLS_RETRY_MS : CELLS_TTL_MS);

  if (fresh) {
    counters.cells = known.length;
    counters.cellsCached = true;
    await setStatus({ step: `Справочник ячеек: ${known.length} (не изменился)`, cells: known.length });
    // ВЗЯТОЕ ИЗ КЭША — НЕ ВЫПОЛНЕННЫЙ ШАГ. Иначе сбор, в котором не
    // сработало вообще ничего (закрыта вкладка WMS, кончилась сессия),
    // отрапортовал бы «готово» только потому, что справочник не пришлось
    // спрашивать. Молчаливый успех тут опаснее честной ошибки.
    return { skipped: true, cells: known.length };
  }

  const pages = await fetchAllPages(url, {});
  let total = 0;
  for (const page of pages) {
    const cells = parser().extractCellDirectory({ url: url, response: page });
    if (cells) total = await saveCells(cells);
  }
  counters.cells = total;
  await setStatus({ step: `Справочник ячеек: ${total}`, cells: total });
  return { cells: total };
}

/**
 * Ячейки FBO. В списке «К выдаче» их нет — они приезжают только запросом
 * товаров, тем самым, который WMS делает по кнопке «Перейти к выдаче».
 * Здесь мы повторяем этот GET пачками для всех заказов без ячейки, ничего
 * не нажимая: сама кнопка статус заказа не меняет (он меняется только после
 * ввода количества, «Выдать» и подтверждения), а мы и до неё не доходим.
 */
async function syncOrderItems(counters) {
  const { priemkaRecords } = await chrome.storage.local.get(['priemkaRecords']);

  // Спрашиваем только те заказы, у которых ячейки ещё нет.
  //
  // Позиции из грузомест исключены намеренно: они в статусе IN_DELIVERY —
  // короб ещё не принят, ячейки у них быть не может, а запрос по такому
  // заказу ничего не даёт и только тратит время.
  const ids = [...new Set(
    (priemkaRecords || [])
      .filter(r => !r.cell && r.orderId && r.source !== 'cargo')
      .map(r => String(r.orderId))
      .filter(id => /^\d+$/.test(id))
  )];

  if (!ids.length) {
    await setStatus({ step: 'Все заказы уже с ячейками — товары запрашивать не нужно' });
    return { added: 0, enriched: 0, skipped: true };
  }

  const broken = [];    // заказы, по которым WMS сам отвечает ошибкой
  let offline = 0;      // ошибки СВЯЗИ (не ответы сервера)
  let authError = null;

  const answers = await mapPool(ids, async (id, _i, stop) => {
    try {
      const data = await fetchOrderItems(id);
      offline = 0;
      return { id, data };
    } catch (first) {
      // 429 — «слишком часто». Появляется только когда мы спрашиваем
      // несколькими потоками сразу, и лечится паузой, а не отказом.
      // Пятисотку по конкретному заказу WMS отдаёт стабильно, её повторять
      // бессмысленно: проверено, пауза не помогает.
      let err = first;
      if (first && first.status === 429) {
        await sleep(700);
        try {
          const data = await fetchOrderItems(id);
          offline = 0;
          return { id, data };
        } catch (second) { err = second; }
      }
      // РАЗЛИЧАЕМ ДВА СОВЕРШЕННО РАЗНЫХ СЛУЧАЯ.
      //
      // 500 на конкретном заказе — поломка WMS именно по нему. На живом ПВЗ
      // так отвечали 69 заказов из 259, стабильно. Прерывать из-за этого
      // весь сбор нельзя: остальные три четверти ячеек прекрасно собираются.
      //
      // 401/403 — это сессия, и дальше идти незачем: останавливаем пул.
      const status = err && err.status;
      broken.push(id);
      if (status === 401 || status === 403) { authError = err; stop(); return null; }
      if (!status) {
        offline++;
        // Связь пропала — нет смысла добивать оставшиеся две сотни запросов.
        if (offline >= 5) { stop(); return null; }
      }
      return { id, err };
    }
  }, {
    onProgress: async (done, total) => {
      await setStatus({
        step: broken.length
          ? `Ячейки FBO: ${done} из ${total} заказов (WMS не отдал ${broken.length})`
          : `Ячейки FBO: ${done} из ${total} заказов`,
        pages: counters.pages + done
      });
    }
  });

  if (authError) {
    await setStatus({ step: `Ячейки FBO: остановлено — WMS отклонил авторизацию (${authError.status})` },
                    { now: true });
    throw authError;
  }
  if (offline >= 5) {
    await setStatus({ step: `Ячейки FBO: связь потеряна после ${offline} ошибок подряд` }, { now: true });
  }

  // Разбираем ответы ОДНИМ куском и пишем в хранилище один раз.
  // Раньше слияние шло каждые пять заказов: сорок с лишним чтений и
  // записей всей таблицы за шаг, и всё это на глазах у ждущего оператора.
  const records = [];
  const answered = new Set();     // заказы, по которым WMS ответил ПОЛНЫМ содержимым
  let done = 0;
  for (const answer of answers) {
    if (!answer || answer.__error || answer.err) continue;
    done++;
    // ПУСТОЙ ответ содержимым НЕ считается. WMS иногда отдаёт по заказу
    // пустоту вместо позиций — 200 и ничего внутри. Если принять это за
    // «в заказе больше нет товаров», чистка ниже сотрёт с полки реальные
    // вещи. Молчание — не ответ: заказ пропускаем, его строки остаются.
    if (answer.data && answer.data.length) {
      answered.add(String(answer.id));
      records.push(...recordsFromPage(KNOWN_ENDPOINTS.orderItems(answer.id), answer.data));
    }
  }

  counters.pages += done;
  counters.brokenOrders = broken.length;
  // Ответ по заказу — ПОЛНЫЙ список его позиций, а не добавка к прошлому.
  counters.stale = await dropStaleItems(records, answered);
  const merged = tally(counters, await mergeRecords(records));

  await chrome.storage.local.set({ priemkaBrokenOrders: broken });
  await setStatus({
    step: broken.length
      ? `Ячейки FBO: готово, WMS не отдал товары по ${broken.length} заказам из ${ids.length}`
      : `Ячейки FBO: готово, ${ids.length} заказов`,
    brokenOrders: broken.length
  });
  return merged;
}

/**
 * Грузоместа и их содержимое — приёмка без сканера.
 *
 * Оператор раньше открывал ГМ, сканируя штрихкод короба. Здесь то же самое
 * делается списком: сначала перечень ГМ, потом содержимое каждого по его
 * cargoPlaceId. Ячеек в содержимом нет, и это не ошибка: пока короб не
 * принят, товар физически никуда не положен. Зато сразу видно, что внутри —
 * заказ, PID, штрихкод заказа, клиент и штрихкод товара.
 */
/**
 * СТАТУСЫ ГРУЗОМЕСТ — из словаря самого WMS (assets/*.js, ECargoPlacementStatus):
 *
 *   CREATED        «Готов к размещению»   — короб на ПВЗ, товар не принят
 *   IN_ACCEPTANCE  «В процессе приемки»   — короб разбирают прямо сейчас
 *   COMPLETED      «Размещен»             — всё разложено, работы нет
 *   FORMED         «Сформирован»
 *   DELIVERING     «Доставляется»
 *
 * Работа оператора — только первые два. Остальные в приёмку не берём:
 * иначе в списке оказываются коробы, которых на ПВЗ уже нет.
 */
const GM_PENDING_STATUSES = ['CREATED', 'IN_ACCEPTANCE'];

/**
 * Позиции грузомест — СНИМОК, а не история.
 *
 * Это была главная ошибка: записи коробов копились от сбора к сбору и
 * никогда не убирались (сверка «что исчезло» их намеренно пропускает —
 * у них нет ячейки и они не лежат на полке). За несколько дней набегало
 * под шесть сотен позиций в коробах, которых на ПВЗ давно нет, и список
 * «без ячейки» показывал 600 там, где принять надо 256.
 *
 * Короб живёт часы, а не недели. Поэтому при каждом сборе весь набор
 * cargo-записей заменяется целиком на то, что WMS показывает сейчас.
 */
async function replaceCargoRecords(fresh) {
  const { priemkaRecords } = await chrome.storage.local.get(['priemkaRecords']);
  const kept = (priemkaRecords || []).filter(r => r.source !== 'cargo');
  const dropped = (priemkaRecords || []).length - kept.length;
  const merged = parser().mergeRecords(kept, fresh, MAX_RECORDS);
  await chrome.storage.local.set({
    priemkaRecords: merged.records,
    priemkaUpdatedAt: Date.now()
  });
  return { dropped, added: merged.added, total: merged.records.length };
}

async function syncCargoPlaces(url, counters) {
  const pages = await fetchAllPages(url, {});
  const all = [];
  for (const page of pages) {
    const list = Array.isArray(page) ? page : (page && page.content) || [];
    for (const gm of list) {
      if (gm && gm.cargoPlaceId) all.push(gm);
    }
  }

  const places = all.filter(gm => GM_PENDING_STATUSES.includes(String(gm.status)));

  // СКОЛЬКО ПРИНЯТЬ — ПО СЧЁТЧИКАМ САМИХ КОРОБОВ.
  //
  // Проверено на живом ПВЗ 03.09.2026: 36 коробов, по счётчикам 349
  // позиций, размещено 93 — принять надо 256. Поимённый список
  // /cargo-places/{id}/orders при постраничном чтении отдал 257 строк:
  // ровно оставшиеся плюс одна уже принятая, но ещё не разложенная.
  // То есть список полный, и оба числа должны сходиться — если не сошлись,
  // об этом надо сказать, а не молча показать своё.
  let itemsTotal = 0;
  let itemsAccepted = 0;
  for (const gm of places) {
    itemsTotal += Number(gm.totalItemAmount) || 0;
    itemsAccepted += Number(gm.acceptedItemAmount) || 0;
  }
  counters.gmPlaces = places.length;
  counters.gmPlacesAll = all.length;
  counters.dpName = (all[0] && all[0].dpShortName) || null;
  counters.gmItemsTotal = itemsTotal;
  counters.gmItemsAccepted = itemsAccepted;
  counters.gmToAccept = Math.max(0, itemsTotal - itemsAccepted);

  if (!places.length) {
    await replaceCargoRecords([]);
    await setStatus({ step: 'Грузоместа: коробов в работе нет', gmPlaces: 0, gmToAccept: 0 });
    return { added: 0, enriched: 0, skipped: true };
  }

  let broken = 0;

  // КОРОБ, КОТОРЫЙ НЕ ТРОНУЛИ, ПЕРЕЧИТЫВАТЬ НЕЧЕГО.
  //
  // Список коробов мы тянем ВСЕГДА — в нём и лежит признак изменения:
  // `status` и счётчики `totalItemAmount` / `acceptedItemAmount`. Любая
  // принятая позиция двигает счётчик, а начатая приёмка меняет статус
  // CREATED → IN_ACCEPTANCE. Значит совпали все три — внутри короба ровно
  // то же, что мы уже прочитали, и тридцать шесть запросов за нажатие
  // возвращают тридцать шесть одинаковых ответов.
  //
  // Строки берём из своей же базы: они там и лежат, отдельного хранилища
  // не нужно. Если строк почему-то нет — читаем короб честно.
  const { priemkaCargoSeen, priemkaRecords } = await chrome.storage.local.get(
    ['priemkaCargoSeen', 'priemkaRecords']
  );
  const seen = priemkaCargoSeen || {};
  const rowsByGm = new Map();
  for (const record of priemkaRecords || []) {
    if (!record || record.source !== 'cargo' || !record.gm) continue;
    const key = String(record.gm);
    if (!rowsByGm.has(key)) rowsByGm.set(key, []);
    rowsByGm.get(key).push(record);
  }

  const print = (gm) => [gm.status, gm.totalItemAmount, gm.acceptedItemAmount].join('|');

  const reused = [];
  const toFetch = [];
  for (const gm of places) {
    const kept = rowsByGm.get(String(gm.cargoPlaceBarcode)) || [];
    if (!forceFull && kept.length && seen[gm.cargoPlaceId] === print(gm)) reused.push(...kept);
    else toFetch.push(gm);
  }
  counters.gmCached = places.length - toFetch.length;

  const nextSeen = {};
  const answers = await mapPool(toFetch, async (gm) => {
    const url = KNOWN_ENDPOINTS.cargoPlaceOrders(gm.cargoPlaceId);
    try {
      const inner = await fetchAllPages(url, {});
      const out = [];
      for (const page of inner) {
        for (const rec of recordsFromPage(url, page)) {
          // Номер короба виден оператору, внутренний id — нет. Статус короба
          // тоже сохраняем: по нему видно, разбирают его сейчас или нет.
          out.push({ ...rec, gm: gm.cargoPlaceBarcode || rec.gm || null, gmStatus: gm.status || null });
        }
      }
      // Отпечаток ставим ТОЛЬКО после удачного чтения: иначе оборванный
      // короб считался бы прочитанным и больше никогда не перечитался.
      nextSeen[gm.cargoPlaceId] = print(gm);
      return out;
    } catch (err) {
      broken++;
      return null;
    }
  }, {
    onProgress: async (done, total) => {
      await setStatus({ step: `Грузоместа: ${done} из ${total} коробов` });
    }
  });

  const records = [...reused];
  for (const part of answers) {
    if (Array.isArray(part)) records.push(...part);
  }

  // Помним только те коробы, что сейчас в работе: закрытые уходят сами.
  const keepSeen = {};
  for (const gm of places) {
    const value = nextSeen[gm.cargoPlaceId] || seen[gm.cargoPlaceId];
    if (value) keepSeen[gm.cargoPlaceId] = value;
  }
  await chrome.storage.local.set({ priemkaCargoSeen: keepSeen });

  const swap = await replaceCargoRecords(records);
  counters.cargoPlaces = places.length;
  counters.gmRows = records.length;
  counters.gmBroken = broken;

  // СКОЛЬКО ОСТАЛОСЬ РАЗМЕСТИТЬ — НЕ ЧИСЛО СТРОК В КОРОБЕ.
  //
  // Список /cargo-places/{id}/orders отдаёт ВЕСЬ короб, включая позиции,
  // которые оператор уже разложил: у разложенной появляется `dpCellBarcode`,
  // и ровно на неё двигается `acceptedItemAmount` в счётчиках короба.
  // Замер 03.09.2026: 257 строк при 256 к размещению — одна уже принята.
  //
  // Мы же показывали 257. К середине смены расхождение растёт: WMS считает
  // остаток, мы — содержимое. Оператор сверяет два числа и видит разные.
  // Теперь считаем то же, что WMS: строки БЕЗ ячейки.
  const toPlace = records.filter(r => !r.cell).length;
  counters.gmToPlace = toPlace;
  counters.gmPlaced = records.length - toPlace;
  // Разница в обе стороны: недобрали — наш недосбор, набрали больше —
  // разошлись с WMS. Молчать нельзя ни о том, ни о другом.
  counters.gmShortfall = Math.max(0, counters.gmToAccept - toPlace);
  counters.gmOverflow = Math.max(0, toPlace - counters.gmToAccept);

  await setStatus({
    gmPlaces: places.length,
    gmItemsTotal: itemsTotal,
    gmItemsAccepted: itemsAccepted,
    gmToAccept: counters.gmToAccept,
    gmRows: records.length,
    gmToPlace: counters.gmToPlace,
    gmPlaced: counters.gmPlaced,
    gmShortfall: counters.gmShortfall,
    gmOverflow: counters.gmOverflow,
    step: counters.gmCached
      ? `Грузоместа: ${places.length} коробов (без изменений ${counters.gmCached}), принять ${counters.gmToAccept} из ${itemsTotal}`
      : `Грузоместа: ${places.length} коробов, принять ${counters.gmToAccept} из ${itemsTotal}`
  });
  return { added: swap.added, enriched: 0 };
}


/** Тот же адрес, но другая страница. */
function withPage(url, page) {
  const u = new URL(url);
  u.searchParams.set('page', String(page));
  return u.toString();
}

/**
 * ПОСТАВКИ («Приёмка → Заказы») — вторая половина работы приёмщика.
 *
 * Оператор считает не только коробы. Часть товара ещё едет: маршрутные
 * листы в статусе «Готов к приемке» показывают, сколько позиций приедет,
 * но в грузоместа они пока не разложены. Замер 03.09.2026: 36 коробов
 * дают 256 позиций к размещению, три поставки — ещё 40. В сумме 296 —
 * именно это число оператор и насчитывает глазами по двум экранам.
 *
 * Считаем ТОЛЬКО свои листы: адрес отдаёт маршруты всех ПВЗ подряд.
 */
async function syncSupplies(counters, dpName) {
  // ЛИСТЫ ИДУТ ОТ СВЕЖИХ К СТАРЫМ, а «Готов к приемке» — это всегда свежие.
  // Читать ради них всю тысячу листов всех ПВЗ подряд незачем: как только
  // страница целиком состоит из завершённых, дальше смотреть нечего.
  // Проверено 03.09.2026: три наших ожидающих листа лежат в самом начале.
  const MAX_PAGES = 10;
  const sheets = [];
  let scanned = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await apiGet(withPage(KNOWN_ENDPOINTS.routeSheets(), page));
    const list = Array.isArray(data) ? data : (data && data.content) || [];
    if (!list.length) break;
    scanned += list.length;
    for (const row of list) if (row) sheets.push(row);

    const anyPending = list.some(x => String(x.status) === 'DELIVERING');
    if (!anyPending && page > 0) break;      // дальше только история
    if (data && data.last === true) break;
    if (list.length < 100) break;
  }
  counters.supplyScanned = scanned;
  if (!sheets.length) return { skipped: true };

  const mine = dpName
    ? sheets.filter(x => String(x.dpShortName || '') === String(dpName))
    : sheets;
  const pending = mine.filter(x => String(x.status) === 'DELIVERING');

  let orders = 0;
  let ready = 0;
  for (const x of pending) {
    orders += Number(x.ordersCount) || 0;
    ready += Number(x.readyOrdersCount) || 0;
  }

  counters.supplySheets = pending.length;
  counters.supplyItems = Math.max(0, orders - ready);
  await setStatus({
    supplySheets: pending.length,
    supplyItems: counters.supplyItems,
    step: `Поставки: ${pending.length} листов, ещё едет ${counters.supplyItems}`
  });
  return { added: 0, enriched: 0 };
}

/**
 * Отметить заказы, которых WMS больше не показывает.
 *
 * Клиент забрал заказ — WMS убрал его из списка «К выдаче». В таблице он
 * при этом оставался и на инвентаризации искался как пропажа. Теперь
 * каждый сбор помечает такие записи, а вернувшиеся — размечает обратно.
 */
async function reconcileGone(seenOrders, counters) {
  const { priemkaRecords } = await chrome.storage.local.get(['priemkaRecords']);
  const records = priemkaRecords || [];
  if (!records.length) return { skipped: true };

  const result = parser().reconcile(records, seenOrders);
  if (!result.marked && !result.restored) return { skipped: true };

  await chrome.storage.local.set({ priemkaRecords: result.records, priemkaUpdatedAt: Date.now() });
  counters.gone = result.marked;
  counters.restored = (counters.restored || 0) + result.restored;
  await setStatus({
    gone: result.marked,
    restored: counters.restored,
    step: `Сверка: выдано или убыло ${result.marked}, вернулось ${result.restored}`
  });
  return result;
}

/**
 * Сверка полноты: сколько заказов ДОЛЖНО быть и сколько собрано.
 *
 * WMS сам отдаёт счётчики по статусам — те же числа, что видит оператор на
 * вкладках. Сравнить с ними дешевле, чем гадать. Если расширение собрало
 * меньше, оператор узнает об этом сразу, а не через неделю на инвентаризации.
 */
const WANTED_STATUSES = ['DELIVERED', 'WAITING_RETURN', 'CHECKING_BY_CUSTOMER'];

/** Сколько заказов «лежит на ПВЗ» по счётчикам WMS. null — если не ответил. */
async function readOrderCount(dpKey) {
  try {
    const data = await apiGet(KNOWN_ENDPOINTS.ordersCount(dpKey));
    const list = Array.isArray(data) ? data : (data && data.content) || [];
    if (!list.length) return null;
    let total = 0;
    for (const row of list) {
      if (row && WANTED_STATUSES.includes(String(row.status))) total += Number(row.count) || 0;
    }
    return total || null;
  } catch (err) {
    return null;
  }
}

async function checkCompleteness(dpKey, counters, countBefore, listComplete) {
  const data = await apiGet(KNOWN_ENDPOINTS.ordersCount(dpKey));
  const list = Array.isArray(data) ? data : (data && data.content) || [];
  if (!list.length) return { skipped: true };

  const byStatus = {};
  for (const row of list) {
    if (row && row.status) byStatus[String(row.status)] = Number(row.count) || 0;
  }

  // СЧЁТЧИК СЧИТАЕТ НЕ ТО, ЧТО ЭКРАН «ЗАКАЗЫ».
  //
  // Проверено на живом ПВЗ 30.08.2026:
  //   Заказы → К выдаче        370   (всё, включая партнёров)
  //   Товары → К выдаче        335   (только FBO+FBS, без партнёров)
  //   партнёры                  35   (uzum-bank 25 + JOOM 10)
  //   b2c-orders-count DELIVERED 335 ← совпадает с ТОВАРАМИ, не с ЗАКАЗАМИ
  //
  // То есть 370 = 335 + 35. Сравнивать всё собранное со счётчиком нельзя:
  // он не знает про партнёрские заказы, и проверка вечно показывала бы
  // недостачу ровно на их число. Сверяем подобное с подобным.
  let expectedB2C = 0;
  for (const status of WANTED_STATUSES) expectedB2C += byStatus[status] || 0;
  if (!expectedB2C) return { skipped: true };

  // ДОПУСК НА ЖИВУЮ РАБОТУ. Пока идёт сбор, оператор выдаёт заказы, и
  // счётчик уменьшается прямо под руками. Поэтому ждём не точное число,
  // а ДИАПАЗОН между замерами до и после. Недостачей считаем только то,
  // что ниже нижней границы: это уже не дрейф, а потеря.
  const low = Math.min(expectedB2C, Number.isFinite(countBefore) ? countBefore : expectedB2C);
  const high = Math.max(expectedB2C, Number.isFinite(countBefore) ? countBefore : expectedB2C);
  const drift = high - low;

  const { priemkaRecords } = await chrome.storage.local.get(['priemkaRecords']);
  const shelf = (priemkaRecords || []).filter(
    r => r.source !== 'cargo' && !r.gone && (r.orderId || r.orderBarcode)
  );
  const idOf = (r) => String(r.orderId || r.orderBarcode);

  const b2cOrders = new Set(shelf.filter(r => !r.partner).map(idOf));
  const partnerOrders = new Set(shelf.filter(r => r.partner).map(idOf));
  const allOrders = new Set(shelf.map(idOf));

  // СТРОКА СПИСКА ≠ ЗАКАЗ, И ИМЕННО НА ЭТОМ СБОР ВРАЛ.
  //
  // У потоварной выдачи один заказ приходит НЕСКОЛЬКИМИ строками — по
  // строке на товар, с общим b2cOrderId. В хранилище они схлопываются в
  // один заказ, и «уникальных заказов» получается заметно меньше, чем
  // строк. Счётчик WMS живёт на экране «Товары» и считает свои единицы.
  //
  // Пока сравнивали «уникальные заказы в базе» со счётчиком, разница
  // выглядела как пропажа: 235 против 305 — «НЕ ХВАТАЕТ 70». На деле не
  // пропало ничего, просто вычитали строки из заказов.
  //
  // Поэтому недостачу объявляем, только если НИ ОДНА из двух мер списка
  // не дотягивает до счётчика. Если по строкам сошлось — значит WMS отдал
  // всё, что обещал, и говорить о пропаже не о чем.
  const listRows = Number.isFinite(counters.listB2CRows) ? counters.listB2CRows : null;
  const listOrders = Number.isFinite(counters.listB2COrders) ? counters.listB2COrders : null;
  const bestListMeasure = Math.max(listRows || 0, listOrders || 0, b2cOrders.size);

  counters.expectedOrders = expectedB2C + partnerOrders.size;   // столько на экране «Заказы»
  counters.collectedOrders = allOrders.size;
  counters.expectedB2C = expectedB2C;                           // столько на экране «Товары»
  counters.collectedB2C = b2cOrders.size;
  counters.collectedPartners = partnerOrders.size;
  counters.countDrift = drift;

  // ПОТЕРЯ ВНУТРИ РАСШИРЕНИЯ — отдельный, куда более важный случай.
  // Список отдал строки, а в базе их меньше, чем заказов в списке: значит
  // потеряли МЫ, а не WMS недодал. Такое надо показывать отдельно и громко,
  // не смешивая с расхождением по счётчику.
  counters.lostInMerge = (listOrders !== null && listComplete)
    ? Math.max(0, listOrders - b2cOrders.size)
    : 0;

  // Недостача — только то, что ниже нижней границы диапазона. И только
  // если список вообще дочитан: на оборванном сборе «недостача» — это
  // не потеря товара, а недочитанные страницы, и путать их нельзя.
  counters.shortfall = listComplete ? Math.max(0, low - bestListMeasure) : 0;
  counters.listIncomplete = !listComplete;

  await setStatus({
    expectedOrders: counters.expectedOrders,
    collectedOrders: counters.collectedOrders,
    expectedB2C,
    expectedB2CLow: low,
    collectedB2C: b2cOrders.size,
    collectedPartners: partnerOrders.size,
    countDrift: drift,
    shortfall: counters.shortfall,
    lostInMerge: counters.lostInMerge,
    droppedLive: counters.droppedLive || 0,
    purged: counters.purged || 0,
    listIncomplete: !listComplete,
    listGot: counters.listGot || null,
    listB2CRows: listRows,
    listB2COrders: listOrders,
    listPartnerRows: counters.listPartnerRows || null,
    step: drift
      ? `Сверка: строк ${listRows} при ${low}–${high} (за время сбора выдали ${drift})`
      : `Сверка: строк ${listRows} из ${expectedB2C}, заказов ${b2cOrders.size}, партнёров ${partnerOrders.size}`
  });
  return { expectedB2C, collected: allOrders.size, shortfall: counters.shortfall };
}

/**
 * Названия и габариты товаров. Единственный POST расширения — поиск по
 * списку id, ничего не меняющий. Адрес проверяется по имени и здесь, и на
 * стороне страницы, тело — только массив чисел.
 */
async function syncSkuCatalog(counters) {
  const { priemkaRecords, priemkaSku } = await chrome.storage.local.get(
    ['priemkaRecords', 'priemkaSku']
  );
  const known = priemkaSku || {};
  const ids = [...new Set(
    (priemkaRecords || [])
      .filter(r => r.skuId && (!r.barcode || !known[r.barcode]))
      .map(r => Number(r.skuId))
      .filter(v => Number.isFinite(v) && v > 0)
  )];
  if (!ids.length) return { skipped: true };

  await setStatus({ step: `Справочник товаров: ${ids.length} позиций` });
  // Ошибку наружу не глотаем: её поймает общий обработчик шагов и запишет
  // в «не удалось». Молчаливое проглатывание раньше означало, что сбор
  // рапортовал «готово» даже когда не работало вообще ничего.
  const rows = await fetchSkuCatalog(KNOWN_ENDPOINTS.skuCatalog(), ids);

  const next = { ...known };
  for (const row of rows) {
    if (!row || !row.barcode) continue;
    // ЧТО ЗДЕСЬ ЧЕЛОВЕЧЕСКОЕ НАЗВАНИЕ. Проверено на живом справочнике
    // 30.08.2026: `title` — внутренний код поставщика («OILATAN-OILA43»,
    // «FOODST-P00BFD2»), `fullName` — его же хвост («OILA43»). Читаемое
    // название лежит в `description`: «Дезодорант-спрей Garnier Mineral…».
    // Раньше сохранялся title, и оператор видел в колонке «Товар» шифр
    // вместо товара — или пустоту, если title не пришёл.
    const readable = [row.description, row.fullName, row.title]
      .map(v => (typeof v === 'string' ? v.trim() : ''))
      .find(v => v.length > 0) || null;

    next[String(row.barcode)] = {
      name: readable,
      title: row.title || null,          // код поставщика — пригодится в поиске
      unit: row.unitPackage || null,
      image: typeof row.imageUrl === 'string' ? row.imageUrl : null,
      skuId: row.id ?? null,
      group: row.productGroup || null,
      needsIdentifier: row.identifierRequired === true,
      // Габариты в МИЛЛИМЕТРАХ. Единицы подтверждены на живых данных:
      // дезодорант-спрей 168×46×29 — это ровно баллончик 16.8 см.
      length: row.length ?? null,
      width: row.width ?? null,
      height: row.height ?? null
    };
  }
  await chrome.storage.local.set({ priemkaSku: next });
  counters.sku = Object.keys(next).length;
  await setStatus({ step: `Справочник товаров: ${Object.keys(next).length} наименований` });
  return rows.length;
}

// ------------------------------------------------------------------
// Объяснение неудачи
// ------------------------------------------------------------------
// Одна строка «сессия истекла» — это ровно то, на что жаловался заказчик:
// непонятно, что случилось и что делать. Поэтому показываем сразу три
// вещи: что именно спросили, кто спрашивал (вкладка или расширение) и что
// ответил сервер.

async function diagnostics(err) {
  const tabs = await findWmsTabs();
  const { priemkaAuth, priemkaDpKey, priemkaApiBase } =
    await chrome.storage.local.get(['priemkaAuth', 'priemkaDpKey', 'priemkaApiBase']);
  let path = null;
  try { path = err && err.url ? new URL(err.url).pathname : null; } catch (e) { /* пусто */ }
  return {
    status: err && err.status ? err.status : null,
    path,
    transport: (err && err.transport) || getLastTransport() || null,
    bridgeError: getLastBridgeError(),
    body: err && err.body ? String(err.body).slice(0, 300) : null,
    tabs: tabs.length,
    hasAuth: hasAuthHeaders(),
    authAt: priemkaAuth?.at || null,

    dpKey: priemkaDpKey || null,
    apiBase: priemkaApiBase || null
  };
}

async function explainFailure(err) {
  const d = await diagnostics(err);
  const where = d.path ? ` (${d.path})` : '';

  if (d.status === 401 || d.status === 403) {
    if (d.transport === 'page') {
      return `WMS отказал самой вкладке dp.uzum.uz${where}: ${d.status}. `
        + 'Значит дело не в расширении — сессия в браузере действительно закончилась. '
        + 'Войдите в WMS заново в этой вкладке, сбор продолжится сам.';
    }
    if (d.tabs === 0) {
      return `WMS отказал (${d.status})${where}, потому что не было ни одной открытой вкладки dp.uzum.uz. `
        + 'Откройте WMS в соседней вкладке и оставьте её открытой — расширение спрашивает данные её руками.';
    }
    // Вкладка есть, но спросить через неё не вышло. Причину знает мост —
    // без неё сообщение снова превращается в «обновите страницу» наугад.
    if (/не сделала ни одного запроса/.test(d.bridgeError || '')) {
      return `WMS отказал (${d.status})${where}. Вкладка WMS открыта, но расширение ещё не видело `
        + 'ни одного её запроса к серверу, поэтому спросить её руками не смогло. '
        + 'Обновите вкладку (F5) и выберите ПВЗ — дальше всё пойдёт само.';
    }
    if (d.bridgeError) {
      return `WMS отказал (${d.status})${where}. Через вкладку спросить не удалось: ${d.bridgeError}. `
        + 'Обновите вкладку dp.uzum.uz (F5) один раз.';
    }
    return `WMS отказал (${d.status})${where}. Вкладка WMS открыта, но не ответила расширению — `
      + 'обновите её (F5) один раз, чтобы в неё загрузилась свежая часть расширения.';
  }

  if (d.status) {
    return `WMS ответил ${d.status}${where}`
      + (d.body ? `: ${d.body.slice(0, 160)}` : '.');
  }

  if (/нет открытой вкладки/.test(err?.message || '')) {
    return 'Нет открытой вкладки dp.uzum.uz. Откройте WMS и оставьте вкладку открытой.';
  }

  return `Ошибка: ${err && err.message ? err.message : err}`;
}

let running = false;

/**
 * ПЕРЕЧИТАТЬ ВСЁ ЗАНОВО.
 *
 * Обычный сбор пропускает то, что не меняется: справочник ячеек, составы
 * запечатанных пакетов, содержимое коробов, которых никто не трогал.
 * Этим и быстр повторный сбор. Но кэш без способа его сбросить — ловушка,
 * поэтому у оператора есть «полный сбор заново», и он поднимает этот флаг
 * ровно на один прогон. Выученное сканами при этом НЕ теряется: оно живёт
 * в тех же составах, и стирать его из-за перечитывания нельзя.
 */
let forceFull = false;

async function runSync({ full = false } = {}) {
  if (running) return { ok: false, reason: 'already_running' };
  running = true;
  forceFull = !!full;

  const counters = { pages: 0, added: 0, enriched: 0, cells: 0 };
  await setStatus({
    running: true, startedAt: Date.now(), finishedAt: null,
    error: null, step: 'Читаю каталог запросов', ...counters
  });

  try {
    // Авторизацию берём из того, что страница WMS отправляет сама.
    // Пароль для этого не нужен: пока оператор работает в WMS, заголовок
    // с токеном обновляется вместе с сессией и подхватывается автоматически.
    const { priemkaAuth, priemkaApiBase } = await chrome.storage.local.get(
      ['priemkaAuth', 'priemkaApiBase']
    );
    setAuthHeaders(priemkaAuth?.headers);
    setApiBase(priemkaApiBase);
    setFetcher(pageFetch);

    const dpKey = await resolveDpKey();
    if (!dpKey) {
      await setStatus({
        running: false, finishedAt: Date.now(),
        error: 'Не выбран ПВЗ. Откройте вкладку dp.uzum.uz и выберите свой пункт '
          + 'выдачи в правом верхнем углу (например ТАШ-120), затем нажмите сбор '
          + 'ещё раз. Пока ПВЗ не выбран, WMS не запрашивает его данные, и номер '
          + 'ПВЗ расширению неоткуда узнать.'
      });
      return { ok: false, reason: 'no_dp' };
    }

    // Каждый шаг независим. У ПВЗ два экрана заказов, грузоместа и
    // справочники — если один адрес у WMS изменится или окажется закрыт,
    // это не повод терять всё остальное. Раньше первая же неудача обрывала
    // сбор целиком, и оператор не получал НИЧЕГО, даже того, что уже
    // прекрасно читалось.
    const warnings = [];
    let lastStepStatus = null;
    let lastStepUrl = null;
    let lastStepTransport = null;
    // Считаем только шаги с данными. Справочник товаров — необязательный:
    // он может честно не найти новых позиций и ничего не запросить, и
    // засчитывать это как «шаг выполнился» нельзя — иначе сбор, где не
    // работает вообще ничего, отрапортует «готово».
    let dataSteps = 0;
    let dataFailures = 0;
    const step = async (name, fn, optional = false) => {
      if (!optional) dataSteps++;
      try {
        const result = await fn();
        // Шаг, которому нечего было делать (нет заказов без ячейки, нет
        // новых товаров), не считается выполненным: иначе он маскировал бы
        // сбор, в котором не сработало вообще ничего.
        if (!optional && result && result.skipped) dataSteps--;
      } catch (err) {
        // Подробности запоминаем только от шагов с данными: неудача
        // необязательного справочника не должна становиться «главной»
        // ошибкой и заслонять настоящую причину.
        if (!optional) {
          dataFailures++;
          if (err && err.status) lastStepStatus = err.status;
          if (err && err.url) lastStepUrl = err.url;
          if (err && err.transport) lastStepTransport = err.transport;
        }
        const status = err && err.status ? ` (${err.status})` : '';
        warnings.push(`${name}${status}`);
        console.warn(`${LOG} шаг «${name}» не удался:`, err);
      }
    };

    // ОДИН список заказов, а не два. Экран «Товары» отдаёт подмножество
    // экрана «Заказы» и без ячеек — собирая оба, расширение клало каждый
    // заказ в таблицу дважды (проверено: 240 из 240 совпадают).
    //
    // Статусы те же, что предлагает окно «Выгрузка .csv» в WMS, поэтому
    // отдельная выгрузка файла не нужна: сбор берёт ровно то же самое.
    await step('справочник ячеек', () => syncCells(KNOWN_ENDPOINTS.cells(dpKey), counters));
    // Счётчик читаем ДО и ПОСЛЕ сбора. Оператор в это время выдаёт заказы,
    // и число на вкладке живёт своей жизнью: сравнивать с одним снимком —
    // значит ловить ложные расхождения на ровном месте.
    const countBefore = await readOrderCount(dpKey);

    // progress.complete станет true только если список дочитан до конца.
    const progress = { seenOrders: new Set(), complete: false };
    await step('заказы', () => syncList(KNOWN_ENDPOINTS.orders(dpKey), 'Заказы', counters, progress));
    // Флаг ставим здесь, а не внутри сверки полноты: та может честно
    // отказаться работать (счётчик не ответил), и тогда оператор не узнал
    // бы, что список недочитан, — самое важное, что он должен узнать.
    counters.listIncomplete = !progress.complete;
    // Шаг не упал — он недочитал. Сказать об этом всё равно надо: без
    // предупреждения оборванный список выглядит как обычный сбор.
    if (counters.listIncomplete) warnings.push('заказы: список дочитан не до конца');
    await step('ячейки товаров', () => syncOrderItems(counters));
    await step('составы посылок', () => syncPackageContents(counters), true);
    await step('грузоместа', () => syncCargoPlaces(KNOWN_ENDPOINTS.cargoPlaces(dpKey), counters));
    await step('поставки', () => syncSupplies(counters, counters.dpName), true);
    // СВЕРКА «ЧТО ИСЧЕЗЛО» — ТОЛЬКО ПО ПОЛНОМУ СПИСКУ.
    //
    // Это самое опасное место во всём сборе. Если список дочитан наполовину,
    // а сверка всё равно отработает, она пометит выданными сотни заказов,
    // которые просто не успели прочитаться, — и инвентаризация их не увидит.
    // Раньше условием было «список не пустой», чего недостаточно: оборванный
    // на третьей странице сбор этому условию удовлетворяет.
    if (progress.complete && progress.seenOrders.size) {
      await step('сверка с WMS', () => reconcileGone(progress.seenOrders, counters), true);
    } else if (progress.seenOrders.size) {
      await setStatus({ step: 'Список заказов прочитан не полностью — сверка пропущена' });
      counters.reconcileSkipped = true;
    }
    await step('чистка истории', () => purgeHistory(counters), true);
    await step('сверка полноты',
      () => checkCompleteness(dpKey, counters, countBefore, progress.complete), true);
    await step('справочник товаров', () => syncSkuCatalog(counters), true);

    // Всё до одного шага провалилось — вот это уже настоящая ошибка,
    // и её надо показать как ошибку, а не как «готово». Частичная неудача
    // ошибкой не считается: лучше отдать что собралось и честно сказать,
    // чего не хватает.
    if (dataSteps && dataFailures >= dataSteps) {
      // Переносим подробности первой настоящей неудачи: без адреса и кода
      // сообщение снова превратится в «что-то пошло не так».
      const err = new Error(`ни один шаг не выполнился: ${warnings.join(', ')}`);
      err.status = lastStepStatus;
      err.url = lastStepUrl;
      err.transport = lastStepTransport;
      throw err;
    }

    const { priemkaRecords } = await chrome.storage.local.get(['priemkaRecords']);
    await setStatus({
      running: false,
      finishedAt: Date.now(),
      step: 'Готово',
      total: (priemkaRecords || []).length,
      ...counters,
      warnings: warnings.length ? warnings : null
    });
    // НОВЫЕ НАЗВАНИЯ — СРАЗУ В ОЧЕРЕДЬ НА ПЕРЕВОД. Не ждём кнопки: после
    // поставки в справочнике появилось десять незнакомых товаров, и к тому
    // моменту, как оператор дойдёт до стеллажа, они уже должны быть
    // по-русски. Десять названий — это один запрос. Ошибку наружу не
    // отдаём: сбор данных удался, а перевод сам расскажет о себе в панели.
    startNameRun().catch(err => console.warn(`${LOG} перевод названий не начался:`, err));
    return { ok: true, ...counters, warnings };
  } catch (err) {
    console.error(`${LOG} ошибка выгрузки:`, err);
    const { priemkaRecords } = await chrome.storage.local.get(['priemkaRecords']);
    await setStatus({
      running: false, finishedAt: Date.now(),
      total: (priemkaRecords || []).length,
      ...counters,
      error: await explainFailure(err),
      diag: await diagnostics(err)
    });
    return { ok: false, reason: 'error', message: err.message };
  } finally {
    running = false;
    forceFull = false;
  }
}

// ------------------------------------------------------------------
// Запуск
// ------------------------------------------------------------------
// Сбор идёт ТОЛЬКО по нажатию кнопки. Никаких будильников, никаких
// «само запустилось, когда открылась вкладка».
//
// Автозапуск здесь был, и от него отказались осознанно: оператор не мог
// понять, откуда в таблице взялись строки и почему они разные в разное
// время суток. Данные попадают в расширение ровно двумя путями — кнопка
// сбора и импорт CSV, — и оба нажимает человек.

chrome.runtime.onInstalled.addListener(() => {
  resetStaleRecords();
});

// ------------------------------------------------------------------
// Рекомендация ячейки для экрана размещения
// ------------------------------------------------------------------
// Считается ИЗ УЖЕ СОБРАННЫХ ДАННЫХ, без единого запроса в сеть: оператор
// стоит с коробкой в руках, и лишние 300 мс здесь — это лишние 300 мс на
// каждом товаре смены.
//
// Главное отличие от расчёта раскладки в попапе: движок стартует не с
// пустого зала, а с ТЕМ, ЧТО В ЯЧЕЙКАХ ЛЕЖИТ СЕЙЧАС. Иначе он будет
// раз за разом советовать одну и ту же «самую удобную» ячейку, пока она не
// переполнится, — а оператор об этом узнает, только когда туда не влезет.

let placementConfig = null;

async function loadPlacementConfig() {
  if (placementConfig) return placementConfig;
  try {
    const res = await fetch(chrome.runtime.getURL('pvz-config.json'));
    placementConfig = await res.json();
  } catch (e) {
    placementConfig = {};
  }
  return placementConfig;
}

const REASON_TEXT = {
  [PLACEMENT_REASONS.RESERVATION]: 'у клиента уже есть ячейка',
  [PLACEMENT_REASONS.DEDICATED]: 'крупный заказ — отдельная ячейка',
  [PLACEMENT_REASONS.SHARED_PACKED]: 'подсаживаем к начатой ячейке',
  [PLACEMENT_REASONS.SHARED_NEW]: 'свободная ячейка по размеру и этажу',
  [PLACEMENT_REASONS.SPECIAL_UNTOUCHED]: 'особый тип — пустая ячейка',
  [PLACEMENT_REASONS.SPECIAL_DOUBLED]: 'особый тип — подсадка',
  [PLACEMENT_REASONS.NO_CAPACITY]: 'свободного места не нашлось'
};

/**
 * Занятость ячеек на сейчас: собранные записи плюс то, что оператор
 * разложил уже после последнего сбора. Без второй половины движок будет
 * считать ячейку пустой ровно до следующего нажатия «Собрать всё из WMS».
 */
function occupancyState(records, placements, config) {
  const state = { version: 1, cells: {}, reservations: {} };
  const put = (cellId, item) => {
    const id = String(cellId);
    if (!state.cells[id]) state.cells[id] = { items: [], dedicatedTo: null };
    state.cells[id].items.push(item);
  };

  for (const r of records || []) {
    if (!r || !r.cell || r.gone || r.source === 'cargo') continue;
    const clientId = String(r.clientId || r.clientName || r.phone || r.orderId || r.gm || r.barcode || '?');
    put(r.cell, {
      clientId,
      simplifiedName: r.itemName || null,
      sizeScore: sizeScore({ size_tier: r.sizeTier || undefined }, config),
      specialType: null,
      itemId: r.barcode || r.orderId || null
    });
    state.reservations[clientId] = String(r.cell);
  }

  for (const p of placements || []) {
    if (!p || !p.cell) continue;
    put(p.cell, {
      clientId: `placed:${p.barcode}`,
      simplifiedName: null,
      sizeScore: sizeScore({}, config),
      specialType: null,
      itemId: p.barcode || null
    });
  }
  return state;
}

async function recommendCell(message) {
  const barcode = String(message.barcode || '');
  if (!barcode) return { ok: false, barcode, reason: 'нет штрихкода' };

  const store = await chrome.storage.local.get(
    ['priemkaRecords', 'priemkaCells', 'priemkaSku', 'priemkaMissingCells']);
  const cells = (store.priemkaCells || []).map(String);
  if (cells.length < 5) {
    return { ok: false, barcode, reason: 'нет справочника ячеек — нажмите «Собрать всё из WMS»' };
  }

  const config = await loadPlacementConfig();
  const engineConfig = {
    ...config,
    // Ячейки, которых физически нет, оператор помечает сам. Советовать
    // такую — значит послать человека к пустой стене.
    nonexistentCells: [...new Set([
      ...(config.nonexistentCells || []).map(String),
      ...(store.priemkaMissingCells || []).map(String)
    ])]
  };

  const records = store.priemkaRecords || [];
  const sku = (store.priemkaSku || {})[barcode] || null;

  // Тот же товар мог приехать в собранных данных — тогда известен клиент,
  // а значит и правило «к своему заказу».
  const known = records.find(r => r && String(r.barcode) === barcode) || null;
  const clientId = known
    ? String(known.clientId || known.clientName || known.phone || known.orderId || `sku:${barcode}`)
    : `sku:${barcode}`;

  const item = {
    item_id: barcode,
    client_id: clientId,
    simplified_name: (known && known.itemName) || (sku && (sku.name || sku.title)) || message.name || null,
    size_tier: sizeTierFromDimensions(sku || {}) || undefined
  };

  const engine = new AllocationEngine(
    engineConfig, cells,
    occupancyState(records, message.placements, engineConfig));
  const [result] = engine.allocateBatch([item]);

  const why = [];
  if (result && result.reason) why.push(REASON_TEXT[result.reason] || result.reason);
  if (item.size_tier) why.push(`размер: ${item.size_tier}`);
  else why.push('габариты неизвестны');

  return {
    ok: true,
    barcode,
    cellId: result ? result.cellId : null,
    reason: result ? result.reason : null,
    why: why.join(' · ')
  };
}

// ==========================================
// ПЕРЕВОД НАЗВАНИЙ
// ==========================================
// Здесь только очередь и хранилище: как устроен запрос, почему пачками и
// чем опасна пачка — в name-llm.js.

let nameRunAbort = null;

/** Товары, у которых нет свежего перевода. Свежий — значит про это же имя. */
async function pendingNames({ all = false } = {}) {
  const lib = globalThis.UCoreSkuName;
  const data = await chrome.storage.local.get(['priemkaSku', nameLlm.CACHE_KEY]);
  const sku = data.priemkaSku || {};
  const cache = data[nameLlm.CACHE_KEY] || {};
  const items = [];
  // Наружу уходит ТОЛЬКО название из справочника товаров. Записи о полке —
  // клиент, телефон, заказ, ячейка — в этот список не попадают вовсе, и это
  // видно прямо здесь: другого источника у items нет.
  for (const [barcode, row] of Object.entries(sku)) {
    const name = row && (row.name || row.title);
    if (!name || String(name).trim().length < 3) continue;
    const hit = cache[barcode];
    if (!all && hit && hit.src === lib.srcKey(name)) continue;
    items.push({ barcode, name: String(name) });
  }
  return { items, cache };
}

async function setNameRun(patch) {
  const data = await chrome.storage.local.get([nameLlm.RUN_KEY]);
  const next = { ...(data[nameLlm.RUN_KEY] || {}), ...patch, at: Date.now() };
  await chrome.storage.local.set({ [nameLlm.RUN_KEY]: next });
  return next;
}

async function startNameRun({ all = false } = {}) {
  if (nameRunAbort) return { ok: false, reason: 'перевод уже идёт' };
  const lib = globalThis.UCoreSkuName;
  const settings = await nameLlm.readSettings();
  if (!settings.enabled) return { ok: false, reason: 'перевод моделью выключен' };
  if (!(await nameLlm.hasAccess(settings.base))) {
    return { ok: false, reason: 'нет разрешения на адрес модели', needPermission: true };
  }
  const key = await nameLlm.readKey();
  if (!key && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(settings.base)) {
    return { ok: false, reason: 'не введён ключ' };
  }

  const { items, cache } = await pendingNames({ all });
  if (!items.length) {
    await setNameRun({ running: false, done: 0, total: 0, ok: 0, failed: 0, finished: true });
    return { ok: true, total: 0 };
  }

  nameRunAbort = new AbortController();
  const signal = nameRunAbort.signal;
  await setNameRun({ running: true, finished: false, total: items.length,
                     done: 0, ok: 0, failed: 0, requests: 0, error: null, rejected: [] });

  // Не ждём завершения: перевод справочника идёт минутами, а ответ панели
  // нужен сейчас. Ход работы панель читает из хранилища.
  (async () => {
    let saved = 0;
    try {
      const result = await nameLlm.translateAll({
        items, settings, key, cache, signal,
        checkTranslation: lib.checkTranslation,
        srcKey: lib.srcKey,
        onProgress: async (progress) => {
          // Сохраняем раз в пачку, а не после каждого названия: пачка и есть
          // единица работы, которую не хочется терять.
          if (progress.cache && progress.done > saved) {
            saved = progress.done;
            await chrome.storage.local.set({ [nameLlm.CACHE_KEY]: progress.cache });
          }
          await setNameRun({
            running: true, total: progress.total, done: progress.done,
            ok: progress.ok, failed: progress.failed, requests: progress.requests,
            note: progress.note || null
          });
        }
      });
      await chrome.storage.local.set({ [nameLlm.CACHE_KEY]: result.cache });
      await setNameRun({
        running: false, finished: true, note: null,
        total: result.report.total, done: result.report.done,
        ok: result.report.ok, failed: result.report.failed,
        requests: result.report.requests,
        error: result.report.error || null,
        // Отклонённое видно в панели. По строкам «придумано число» и «ответ
        // не про этот товар» понятно, что не так с моделью, — по счётчику
        // «не вышло 80» не понятно ничего.
        rejected: result.report.rejected
      });
    } catch (err) {
      await setNameRun({ running: false, finished: true, error: String(err && err.message || err) });
    } finally {
      nameRunAbort = null;
    }
  })();

  return { ok: true, total: items.length };
}

function stopNameRun() {
  if (nameRunAbort) nameRunAbort.abort();
  nameRunAbort = null;
  return setNameRun({ running: false, stopped: true }).then(() => ({ ok: true }));
}

/**
 * Что показать панели. Ключ здесь НЕ отдаётся — только признак, что он
 * введён: наружу из service worker он уходит единственным путём, на адрес
 * модели.
 */
async function nameStatus() {
  const settings = await nameLlm.readSettings();
  const data = await chrome.storage.local.get([nameLlm.RUN_KEY, nameLlm.CACHE_KEY]);
  const { items } = await pendingNames();
  return {
    settings,
    providers: nameLlm.PROVIDERS,
    hasKey: !!(await nameLlm.readKey()),
    granted: await nameLlm.hasAccess(settings.base),
    run: data[nameLlm.RUN_KEY] || null,
    cached: Object.keys(data[nameLlm.CACHE_KEY] || {}).length,
    pending: items.length
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'ucore:sync-all') {
    runSync({ full: !!message.full }).then(sendResponse);
    return true;
  }
  if (message.type === 'ucore:sync-status') {
    getStatus().then(sendResponse);
    return true;
  }
  // ЖИВОЙ ПОИСК ПО ШТРИХКОДУ.
  //
  // Инвентаризация раньше умела только сверяться с тем, что собрано.
  // Товар, приехавший после сбора, она называла «в собранных данных
  // такого нет» — то есть ровно тогда, когда помощь нужнее всего,
  // отвечала «не знаю». Теперь неизвестный код уходит в WMS: оттуда
  // приходит и заказ, и ЯЧЕЙКА, и статус.
  if (message.type === 'ucore:recommend-cell') {
    recommendCell(message)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, barcode: message.barcode,
                                   reason: String((err && err.message) || err) }));
    return true;
  }

  if (message.type === 'ucore:lookup-barcode') {
    (async () => {
      try {
        const { priemkaAuth, priemkaApiBase } = await chrome.storage.local.get(
          ['priemkaAuth', 'priemkaApiBase']
        );
        setAuthHeaders(priemkaAuth?.headers);
        setApiBase(priemkaApiBase);
        setFetcher(pageFetch);

        const found = await searchShipment(message.barcode);
        if (!found.found) {
          // retryable — сервер моргнул или ответил про чужой товар.
          // Оператору надо сказать «повторите», а не «такого нет»:
          // это разные действия и разная цена ошибки.
          sendResponse({ ok: false, reason: found.reason,
                         retryable: !!found.retryable, stale: !!found.stale });
          return;
        }
        const record = parser().fromShipmentSearch(found.data, found.kind);
        // Кладём находку в общую базу — но ТОЛЬКО если вещь на полке.
        // Выданный заказ ячейку не теряет, и влитый в базу он становится
        // ожидаемой позицией: инвентаризация начинает искать на полке то,
        // чего там законно нет, и записывает это в недостачу.
        if (record && parser().isOnShelf({ ...record, phase: found.kind })) {
          await mergeRecords([record]);
        }
        sendResponse({ ok: true, kind: found.kind, record });
      } catch (err) {
        const status = err && err.status;
        sendResponse({
          ok: false,
          reason: status === 401
            ? 'WMS отклонил запрос — обновите вкладку dp.uzum.uz'
            : `Ошибка: ${err && err.message}`,
          retryable: !status || status >= 500 || status === 429
        });
      }
    })();
    return true;
  }

  if (message.type === 'ucore:names-status') {
    nameStatus().then(sendResponse);
    return true;
  }
  if (message.type === 'ucore:names-settings') {
    (async () => {
      // Ключ приходит отдельным полем и в настройки не попадает.
      let keyProblem = null;
      if (typeof message.key === 'string') {
        const saved = await nameLlm.writeKey(message.key);
        if (!saved.ok) keyProblem = saved.problem;
      }
      await nameLlm.writeSettings(message.patch || {});
      sendResponse({ ...(await nameStatus()), keyProblem });
    })();
    return true;
  }
  if (message.type === 'ucore:names-probe') {
    (async () => {
      const settings = { ...(await nameLlm.readSettings()), ...(message.patch || {}) };
      sendResponse(await nameLlm.probe(settings, await nameLlm.readKey()));
    })().catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (message.type === 'ucore:names-run') {
    startNameRun({ all: !!message.all })
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, reason: String(err && err.message || err) }));
    return true;
  }
  if (message.type === 'ucore:names-stop') {
    stopNameRun().then(sendResponse);
    return true;
  }

  if (message.type === 'ucore:merge-records') {
    // Импорт CSV из попапа проходит через тот же путь слияния, что и всё
    // остальное, чтобы не было второй реализации дедупликации.
    mergeRecords(message.records || []).then(sendResponse);
    return true;
  }
});

console.log(`${LOG} service worker готов`);
