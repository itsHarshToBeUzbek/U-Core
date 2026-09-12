// ==========================================
// wms-api.js — массовое чтение данных из WMS
// ==========================================
// Работает ТОЛЬКО в контексте расширения (service worker / попап), где
// host_permissions снимают ограничение CORS. Из страницы это невозможно:
// api-wms.uzum.uz не отдаёт CORS-заголовки для dp.uzum.uz, проверено.
//
// ЗАЧЕМ ЭТО ВООБЩЕ ЕСТЬ. Пассивного перехвата мало: он видит только то, что
// оператор открыл своими руками, и только первую страницу списка. Задача —
// собрать ВСЁ и без участия человека, поэтому расширение должно уметь
// запрашивать данные само.
//
// ЧТО ЗАПРЕЩЕНО И ПОЧЕМУ. Только GET и только те адреса, которые уже были
// подсмотрены в собственном трафике страницы. Никаких POST, никаких
// придуманных адресов, ничего из списка изменяющих эндпоинтов. Пояснение
// для тех, кто будет это править: GET-запрос к списку — это ровно то, что
// делает браузер оператора, когда он листает страницы глазами; он не меняет
// ни одного статуса. Всё, что меняет состояние (acceptance/*, issue,
// подтверждение выдачи), лежит за POST и сюда не попадает по построению.
//
// КАК РЕШЕНА ПРОБЛЕМА НЕИЗВЕСТНЫХ ПАРАМЕТРОВ. Имена query-параметров у WMS
// местами разные (dpKey и deliveryPointKey встречаются оба) и могут
// поменяться. Поэтому адреса не зашиты: content.js складывает КАТАЛОГ
// ШАБЛОНОВ — какие запросы страница делала, с какими параметрами и когда.
// Массовая выгрузка берёт готовый шаблон и меняет в нём только номер
// страницы. Достаточно, чтобы оператор один раз открыл нужный экран —
// дальше расширение ходит туда само.

// ИЗВЕСТНЫЕ АДРЕСА WMS. Сняты с живого ТАШ-120 (3.90.5, 29.08.2026).
//
// Раньше их тут не было: расширение ЖДАЛО, пока оператор сам откроет нужный
// экран, и только тогда узнавало адрес. Для запроса товаров это означало,
// что ячейки FBO не собирались НИКОГДА — экран выдачи открывают не каждый
// день, а без него шаблона нет. Теперь адреса известны, и ждать нечего.
//
// Подсмотренный шаблон по-прежнему в приоритете там, где он есть: в нём
// живые фильтры оператора (статус, размер страницы). Эти адреса — гарантия,
// что сбор пойдёт даже когда шаблона нет.
// Хост API тоже не зашит намертво: content.js подсматривает его в трафике
// страницы. Зашитая строка уже трижды в этом проекте оказывалась тем, что
// тихо ломает работу и делает код непроверяемым.
export const DEFAULT_API = 'https://api-wms.uzum.uz';

/**
 * Статусы «лежит на ПВЗ и ждёт клиента» — ровно те, что предлагает окно
 * «Выгрузка .csv». Перечислены здесь один раз, чтобы не разъезжались.
 */
export const ISSUE_STATUSES = 'DELIVERED,WAITING_RETURN,CHECKING_BY_CUSTOMER';

let apiBase = DEFAULT_API;

/**
 * Хост API берётся из трафика страницы (см. content.js), а не из кода.
 * DEFAULT_API — только запасной вариант на первый запуск.
 */
export function setApiBase(base) {
  apiBase = (base && /^https?:\/\//.test(base)) ? base.replace(/\/$/, '') : DEFAULT_API;
}

// Адреса СНЯТЫ С ЖИВОГО WMS 3.90.5 (ТАШ-120, 29.08.2026), а не выведены из
// старого бандла. Проверено прямо в браузере оператора: 200, 297 заказов на
// трёх страницах, у 99 из них ячейка приходит сразу в списке.
//
// Почему это важно: экран «Заказы клиентов» отдаёт ячейку (`cellInfo`) в том
// же ответе, что и сам список. То есть для большинства заказов НИЧЕГО
// открывать и никуда «переходить к выдаче» не нужно — раньше расширение
// ходило за ячейками по одному заказу там, где хватало одного запроса.
// ВСЕ адреса сняты с живого WMS 3.90.5 (ТАШ-120, 29.08.2026) и проверены
// запросами прямо из браузера оператора. Ключевое открытие: у ПВЗ ДВА
// разных экрана заказов, и раньше расширение знало только про один.
//
//   «Выдача → Заказы»  -> /de/v3/delivery-point/orders   297 шт, ЯЧЕЙКА ЕСТЬ
//                          (партнёрские и банковские, UZUM-BANK-*)
//   «Выдача → Товары»  -> /de/delivery-point/b2c-orders  272 шт, ЯЧЕЙКИ НЕТ
//                          (те самые FBO, там же кнопка «Перейти к выдаче»)
//
// Именно поэтому в таблице были заказы без ячеек: собирался второй список,
// а ячейки к нему никогда не добирались.
export const KNOWN_ENDPOINTS = Object.freeze({
  cells: (dpKey) => `${apiBase}/de/delivery-point/cells?deliveryPointKey=${encodeURIComponent(dpKey)}`,

  // ЕДИНСТВЕННЫЙ список заказов. Проверено 30.08.2026 на живом ПВЗ:
  //   /de/v3/delivery-point/orders  -> 265 заказов (= счётчик в интерфейсе)
  //   /de/delivery-point/b2c-orders -> 240 заказов, и ВСЕ 240 уже есть
  //                                    в первом списке (пересечение 240/240)
  // То есть второй список — подмножество первого, но БЕЗ поля ячейки.
  // Раньше собирались оба, и каждый заказ попадал в таблицу дважды: одной
  // строкой с ячейкой и другой без. Отсюда и «много мусора».
  //
  // Статусы — те же, что предлагает окно «Выгрузка .csv» в WMS:
  //   DELIVERED            — «К выдаче»            (265)
  //   WAITING_RETURN       — «Истек срок хранения» (13)
  //   CHECKING_BY_CUSTOMER — «Проверяется клиентом»
  // Поэтому отдельная выгрузка CSV больше не нужна: сбор берёт то же самое.
  orders: (dpKey, status = ISSUE_STATUSES) =>
    `${apiBase}/de/v3/delivery-point/orders?page=0&size=100`
    + `&deliveryPointKey=${encodeURIComponent(dpKey)}`
    + `&status=${encodeURIComponent(status)}`
    + `&sortField=accepted_date&direction=ASC`,

  // Сколько заказов ДОЛЖНО быть в каждом статусе — для сверки полноты.
  ordersCount: (dpKey) =>
    `${apiBase}/de/v2/delivery-point/b2c-orders-count?dpKey=${encodeURIComponent(dpKey)}`,

  // То, что делает «Перейти к выдаче», только без нажатия. Ячейка лежит в
  // items[].cellBarcode. Проверено: 18 позиций из 18 вернули ячейку.
  // ОДИН заказ за вызов: ?b2cOrderIds=1,2,3 отвечает 400.
  orderItems: (orderId) =>
    `${apiBase}/de/v2/delivery-point/b2c-orders/items?b2cOrderId=${encodeURIComponent(orderId)}`,

  // ЧТО ВНУТРИ ПОСЫЛКИ. Единственный адрес, где ПВЗ видит состав заказа
  // целиком — включая FBS, у которого `b2c-orders/items` отдаёт пустоту.
  // Живёт он в ДРУГОЙ службе: путь начинается с /or/, а не /de/.
  //
  // Замер 07.09.2026:
  //   FBS 124609526  -> 1 отправление, 2 позиции   (совпало с экраном WMS)
  //   FBS 123871611  -> 1 отправление, 1 позиция
  //   FBO 124372122  -> 1 отправление, 2 позиции
  //   uzum-bank, RX (Uzum Global) -> HTTP 500
  // Партнёрские заказы этот адрес не знает, и это не поломка: их состав
  // не знает и сам WMS — на экране у них вкладки «Товары» нет вовсе.
  //
  // Ответ: wmsOrders[] — по одному на ФИЗИЧЕСКУЮ посылку, со своим
  // штрихкодом (`10-0124609526-1`); внутри wmsOrderItems[] с externalSkuId
  // и amount. Название и ШК товара берутся из справочника по skuId.
  orderContents: (b2cOrderId) =>
    `${apiBase}/or/orders/v2?b2cOrderId=${encodeURIComponent(b2cOrderId)}`,

  // Грузоместа и их содержимое — приёмка без сканера.
  cargoPlaces: (dpKey) =>
    `${apiBase}/de/delivery-point/cargo-places?deliveryPointKey=${encodeURIComponent(dpKey)}&page=0&size=100`,
  // Содержимое одного ГМ. Ячейки здесь пустые и это правда: пока короб не
  // принят, товар физически никуда не положен. Зато есть заказ, PID, ШК
  // заказа, клиент и ШК товара — всё без единого скана.
  // ПОСТАВКИ («Приёмка → Заказы»). Маршрутные листы: то, что ещё едет и
  // на ПВЗ пока не разобрано по коробам. Статусы из словаря WMS:
  //   DELIVERING «Готов к приемке», DELIVERED «Приемка завершена».
  // Внимание: dpKey этот адрес НЕ фильтрует — в ответе приходят листы
  // всех ПВЗ, и отбирать свои надо по dpShortName. Проверено 03.09.2026:
  // без фильтра в выдаче 1000 листов, наших из них 52.
  routeSheets: () => `${apiBase}/de/route-sheet/all?page=0&size=100`,

  cargoPlaceOrders: (cargoPlaceId) =>
    `${apiBase}/de/delivery-point/cargo-places/${encodeURIComponent(cargoPlaceId)}/orders?page=0&size=100`,

  // Справочник товаров: названия и габариты. Единственный POST, который
  // расширению разрешён, и он ничего не меняет — это поиск по списку id.
  skuCatalog: () => `${apiBase}/de/sku/basic/all/id`,

  // ПОИСК ОТПРАВЛЕНИЯ ПО ШТРИХКОДУ — то же, что делает экран
  // «Поиск отправлений». Снято с живого WMS 30.08.2026.
  //
  //   GET /de/order/search/delivered?barcode=10-0122346662-1
  //   -> { dpKey, shipmentMode, orderId, b2cOrderId, b2cPublicOrderId,
  //        status, orderType, cellId, customer{…}, barcode }
  //
  // Ключевое: в ответе есть cellId — ЯЧЕЙКА. Это единственный способ
  // узнать место товара, которого нет в собранной базе (приехал после
  // сбора), и основа «потоварной» инвентаризации: один скан этикетки
  // даёт и заказ, и ячейку, и статус.
  //
  // Три раздела ищут в разных фазах жизни заказа; интерфейс WMS дёргает
  // все три и показывает тот, который ответил.
  //   delivered  — лежит на ПВЗ, ждёт клиента
  //   acceptance — на приёмке
  //   return     — в возврате
  //
  // Не найдено — это 200 и ПУСТОЙ МАССИВ, а не 404.
  // Штрихкод заказа целиком у потоварных заказов даёт 428: WMS требует
  // скан конкретного товара (у него код с суффиксом, «…-1»).
  orderSearch: (kind, barcode) =>
    `${apiBase}/de/order/search/${encodeURIComponent(kind)}?barcode=${encodeURIComponent(barcode)}`
});

const REQUEST_DELAY_MS = 180;     // пауза между запросами, чтобы не долбить WMS
const MAX_PAGES = 200;            // предохранитель от бесконечного листания
const PAGE_SIZE = 100;

// Адреса, к которым не ходим никогда. Список продублирован на стороне
// страницы (wms-harvester.js) — это последний рубеж перед сетевым вызовом.
const FORBIDDEN = /(acceptance|item-acceptance|encashment|withdraw|assign-identifier|place-return|complete|confirm|cancel|issue\/request|adjustment)/i;

/** Можно ли вообще трогать этот адрес: только GET и только на чтение. */
export function isSafeToReplay(url, method) {
  if (String(method || 'GET').toUpperCase() !== 'GET') return false;
  try {
    return !FORBIDDEN.test(new URL(url).pathname);
  } catch (e) {
    return false;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Заголовки авторизации, снятые с запросов самой страницы WMS.
// Без них сервер отвечает 401 даже при живой сессии оператора: токен
// приложение шлёт заголовком, а не только кукой, и запрос с одними
// куками для него неотличим от неавторизованного. Именно это выглядело
// как «расширение не видит, что я вошёл».
let authHeaders = {};

export function setAuthHeaders(headers) {
  authHeaders = headers && typeof headers === 'object' ? { ...headers } : {};
}

export function hasAuthHeaders() {
  return Object.keys(authHeaders).length > 0;
}

/**
 * Запрос руками самой страницы WMS.
 *
 * Расширение годами пыталось повторить авторизацию приложения — снять
 * заголовки, приложить куки — и каждый раз это был вывод по косвенным
 * признакам: заголовки могли устареть, куку SameSite мог не отдать.
 * Запросы самой вкладки при этом работают всегда: те же куки, тот же
 * origin, тот же токен, который приложение только что обновило.
 * Поэтому основной путь — попросить открытую вкладку сходить за данными,
 * а собственный fetch остаётся запасным (вкладка закрыта, alarm ночью).
 *
 * Функцию ставит background.js: она принимает url и возвращает
 * { ok, status, body } либо { ok:false, error }.
 */
let pageFetcher = null;

export function setFetcher(fn) {
  pageFetcher = typeof fn === 'function' ? fn : null;
}

export function hasFetcher() {
  return typeof pageFetcher === 'function';
}

// Чем закончился последний запрос — для понятного отчёта об ошибке.
let lastTransport = null;
let lastBridgeError = null;

export function getLastTransport() {
  return lastTransport;
}

/** Почему не получилось спросить через вкладку. Нужно для внятной ошибки. */
export function getLastBridgeError() {
  return lastBridgeError;
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return { __raw: text };            // CSV и прочее не-JSON
  }
}

function httpError(status, url, transport, body) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  error.url = url;
  error.transport = transport;
  if (body) error.body = String(body).slice(0, 400);
  return error;
}

/**
 * Один GET от имени оператора.
 * Сначала — руками вкладки, потом — своими силами (куки + подсмотренные
 * заголовки). Если вкладка ответила 401/403, повторять своими силами
 * бессмысленно: у расширения заведомо не больше прав, чем у страницы.
 */
async function get(url, { signal, method = 'GET', body = null } = {}) {
  if (pageFetcher) {
    let relayed = null;
    try {
      relayed = await pageFetcher(url, { signal, method, body });
    } catch (err) {
      relayed = { ok: false, error: String(err && err.message || err) };
    }
    if (relayed && relayed.ok) {
      lastTransport = 'page';
      lastBridgeError = null;
      return parseBody(relayed.body == null ? '' : relayed.body);
    }
    lastBridgeError = (relayed && relayed.error) || null;
    // Страница дошла до сервера, но сервер отказал — свой fetch не поможет.
    if (relayed && typeof relayed.status === 'number' && relayed.status > 0) {
      lastTransport = 'page';
      throw httpError(relayed.status, url, 'page', relayed.body);
    }
    // Вкладки нет / не ответила — падаем на собственный запрос.
  }

  const response = await fetch(url, {
    method, signal, body,
    headers: method === 'POST'
      ? { ...authHeaders, 'content-type': 'application/json' }
      : { ...authHeaders }
  });
  lastTransport = 'direct';
  if (!response.ok) {
    let snippet = '';
    try { snippet = (await response.text()).slice(0, 400); } catch (e) { /* всё равно бросаем */ }
    throw httpError(response.status, url, 'direct', snippet);
  }
  return parseBody(await response.text());
}

/**
 * Единственный POST, который делает расширение: справочник товаров.
 * Он ничего не меняет — это поиск названий и габаритов по списку id.
 * И в расширении, и на стороне страницы адрес проверяется по имени.
 */
export async function fetchSkuCatalog(url, skuIds, { signal } = {}) {
  const ids = [...new Set((skuIds || [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v) && v > 0))];
  if (!ids.length) return [];
  const out = [];
  for (const part of chunk(ids, 200)) {
    const data = await get(url, { signal, method: 'POST', body: JSON.stringify(part) });
    if (Array.isArray(data)) out.push(...data);
    await sleep(REQUEST_DELAY_MS);
  }
  return out;
}

/**
 * Состав посылки: что лежит внутри заказа.
 *
 * Возвращает по записи на ФИЗИЧЕСКУЮ посылку — у одного заказа их бывает
 * несколько, и у каждой свой штрихкод. Оператор сканирует именно его,
 * поэтому состав привязывается к посылке, а не к заказу целиком.
 *
 * Партнёрские заказы (uzum-bank, Uzum Global, Aliexpress) этот адрес
 * отдаёт пятисоткой — их состав неизвестен и самому WMS. Ошибку наверх
 * не глотаем: пусть решает вызывающий, для него это не отказ, а «нечего
 * показать».
 */
export async function fetchOrderContents(b2cOrderId, { signal } = {}) {
  const data = await get(KNOWN_ENDPOINTS.orderContents(b2cOrderId), { signal });
  const order = Array.isArray(data) ? data[0] : data;
  const shipments = (order && order.wmsOrders) || [];
  return shipments.map((w) => ({
    wmsOrderId: w && w.wmsOrderId != null ? String(w.wmsOrderId) : null,
    barcode: (w && w.barcode) || null,
    status: (w && w.status) || null,
    items: ((w && w.wmsOrderItems) || [])
      .map((i) => ({
        skuId: i && i.externalSkuId != null ? Number(i.externalSkuId) : null,
        amount: Number.isFinite(Number(i && i.amount)) ? Number(i.amount) : 1,
        orderItemId: i && i.orderItemId != null ? String(i.orderItemId) : null
      }))
      .filter((i) => i.skuId)
  }));
}

export const SEARCH_KINDS = Object.freeze(['delivered', 'acceptance', 'return']);

/**
 * Найти отправление по штрихкоду там, где оно сейчас есть.
 *
 * Возвращает { found, kind, data } — kind говорит, в какой фазе нашёлся
 * товар: лежит на выдаче, на приёмке или в возврате. Это и есть ответ на
 * вопрос «а что это вообще за товар и где он должен лежать».
 */
/**
 * ОТВЕТ ДОЛЖЕН БЫТЬ ПРО ТОТ ЖЕ КОД, КОТОРЫЙ СПРАШИВАЛИ.
 *
 * «Поиск отправлений» у WMS регулярно отдаёт прошлый результат: страница
 * подтормозила, запрос разошёлся с ответом — и на экране висит предыдущий
 * товар. На инвентаризации это самое опасное, что может случиться: зелёный
 * свет по чужому товару означает, что недостачу найдут не сегодня, а когда
 * за ней придёт клиент.
 *
 * Поэтому ответ принимается, только если отсканированный код в нём реально
 * встречается — как штрихкод отправления, товара, заказа или его номер.
 */
function echoesScan(data, code) {
  if (!data || typeof data !== 'object') return false;
  const wanted = String(code).trim().toUpperCase();
  const wantedDigits = wanted.replace(/\D+/g, '');
  const fields = [
    data.barcode, data.orderBarcode, data.b2cOrderBarcode, data.skuItemBarcode,
    data.skuBarcode, data.b2cOrderId, data.orderId, data.b2cPublicOrderId
  ];
  for (const value of fields) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim().toUpperCase();
    if (!text) continue;
    if (text === wanted) return true;
    const digits = text.replace(/\D+/g, '');
    if (!digits || digits.length < 6) continue;
    // Штрихкод заказа выглядит как 10-0122575788-1: номер заказа внутри него.
    if (wantedDigits && wantedDigits.length >= 6) {
      if (digits.includes(wantedDigits) || wantedDigits.includes(digits)) return true;
    }
  }
  return false;
}

export async function searchShipment(barcode, { signal, kinds = SEARCH_KINDS } = {}) {
  const code = String(barcode || '').trim();
  if (!code) return { found: false, reason: 'пустой код' };

  let refused = null;
  let stale = false;
  let broke = null;

  for (const kind of kinds) {
    let data;
    try {
      data = await get(KNOWN_ENDPOINTS.orderSearch(kind, code), { signal });
    } catch (err) {
      // 428 у потоварного заказа означает «сканируй товар, а не заказ».
      // Это не сбой поиска, а осмысленный ответ — так и передаём.
      if (err && err.status === 428) { refused = 'потоварный заказ: нужен штрихкод товара, а не заказа'; continue; }
      if (err && (err.status === 401 || err.status === 403)) throw err;
      // Сервер сломался или связь моргнула — это НЕ «товара нет».
      // Разница принципиальная: «нет» отправляет оператора разбираться,
      // «повторите» — просто пикнуть ещё раз.
      if (!err || !err.status || err.status >= 500 || err.status === 429) {
        broke = (err && err.status) ? `WMS ответил ошибкой ${err.status}` : 'WMS не ответил';
      }
      continue;
    }
    const first = Array.isArray(data) ? data[0] : data;
    if (first && typeof first === 'object' && (first.b2cOrderId || first.orderId)) {
      if (!echoesScan(first, code)) { stale = true; continue; }
      return { found: true, kind, data: first };
    }
  }

  if (stale) {
    return { found: false, retryable: true, stale: true,
             reason: 'WMS ответил про другой товар — повторите скан' };
  }
  if (broke) return { found: false, retryable: true, reason: broke };
  return { found: false, reason: refused || 'не найдено ни в выдаче, ни в приёмке, ни в возвратах' };
}

/** Подставляет/заменяет query-параметры в готовом шаблоне. */
export function withParams(templateUrl, overrides) {
  const url = new URL(templateUrl);
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined || value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Как в этом шаблоне называется параметр страницы/размера (если он есть). */
function pageParamNames(templateUrl) {
  const url = new URL(templateUrl);
  const names = [...url.searchParams.keys()];
  return {
    page: names.find(n => /^page$/i.test(n)) || (names.includes('page') ? 'page' : null),
    size: names.find(n => /^(size|limit|perPage)$/i.test(n)) || null
  };
}

/**
 * ОДНА СТРАНИЦА СПИСКА, С ПОВТОРАМИ.
 *
 * WMS у ПВЗ регулярно отвечает пятисоткой на ровном месте: на живом ПВЗ так
 * ломались 69 запросов товаров из 259. Одна такая пятисотка на последней
 * странице списка обрывала весь сбор, и оператору оставалось только жать
 * кнопку заново. Три попытки с нарастающей паузой закрывают почти все такие
 * обрывы, не превращая сбор в долбёжку чужого сервера.
 *
 * Повторяем ТОЛЬКО то, что имеет смысл повторять: 5xx, 429 и обрыв связи.
 * 401/403 — это сессия, 404 — не тот адрес; повтор их не вылечит, а время
 * съест, поэтому такие ошибки бросаем сразу.
 */
const PAGE_RETRIES = 3;
const RETRY_PAUSES = [700, 2000, 4500];

function worthRetrying(err) {
  const status = err && err.status;
  if (!status) return true;                 // обрыв связи — повторить стоит
  return status >= 500 || status === 429;
}

async function getPageWithRetry(url, { signal, page, onRetry } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < PAGE_RETRIES; attempt++) {
    try {
      return await get(url, { signal });
    } catch (err) {
      lastError = err;
      if (!worthRetrying(err) || attempt === PAGE_RETRIES - 1) throw err;
      if (onRetry) {
        try { await onRetry({ page, attempt: attempt + 1, of: PAGE_RETRIES, error: err }); }
        catch (e) { /* сообщать о повторе — не повод падать */ }
      }
      await sleep(RETRY_PAUSES[attempt] || 4500);
    }
  }
  throw lastError;
}

/**
 * Листает постраничный список до конца.
 *
 * Признак последней страницы у WMS — поле `last: true` (Spring Data), но
 * полагаться только на него нельзя: у части ответов его нет. Поэтому
 * останавливаемся ещё и по пустой странице, и по жёсткому пределу
 * MAX_PAGES — чтобы ошибка в разборе ответа не превратилась в
 * бесконечный цикл запросов к чужому серверу.
 */
export async function fetchAllPages(templateUrl, { onPage, signal, maxPages = MAX_PAGES, onRetry } = {}) {
  const { page: pageParam, size: sizeParam } = pageParamNames(templateUrl);
  const pages = [];

  if (!pageParam) {                    // не постраничный ответ — один запрос
    const data = await get(templateUrl, { signal });
    pages.push(data);
    if (onPage) await onPage(data, 0, 1);
    return pages;
  }

  for (let page = 0; page < maxPages; page++) {
    const overrides = { [pageParam]: page };
    if (sizeParam) overrides[sizeParam] = PAGE_SIZE;

    const data = await getPageWithRetry(withParams(templateUrl, overrides), { signal, page, onRetry });
    pages.push(data);

    // Не JSON (страница-заглушка, HTML-редирект, CSV) — листать нечего.
    // Без этой проверки цикл честно доходил до MAX_PAGES, делая двести
    // бессмысленных запросов к чужому серверу и пряча настоящую причину.
    if (data && data.__raw !== undefined) break;

    const content = Array.isArray(data) ? data : (Array.isArray(data?.content) ? data.content : null);
    if (onPage) await onPage(data, page, content ? content.length : 0);

    // Ответ есть, но это не список — дальше листать бессмысленно.
    if (!content) break;

    if (data?.last === true) break;
    if (content && content.length === 0) break;
    if (content && content.length < PAGE_SIZE && data?.last === undefined) break;

    await sleep(REQUEST_DELAY_MS);
  }

  return pages;
}

/**
 * Товары ОДНОГО заказа — там, где у FBO лежит ячейка.
 *
 * Проверено на живом WMS (29.08.2026):
 *   GET /de/v2/delivery-point/b2c-orders/items?b2cOrderId=122575788
 *   -> [ { b2cOrderId, b2cOrderBarcode, customer, totalPrice,
 *          items: [ { skuBarcode, skuItemId, cellBarcode, amount, status } ] } ]
 *
 * Параметр ОДИН и в ЕДИНСТВЕННОМ числе: b2cOrderId, не b2cOrderIds. Пачками
 * этот эндпоинт не спрашивают — раньше здесь склеивались id через запятую,
 * и это была главная причина, почему сбор ячеек FBO не работал вообще.
 *
 * Это тот же GET, который WMS делает по «Перейти к выдаче». Статус заказа он
 * не меняет: статус меняется после ввода количества, «Выдать» и подтверждения.
 */

/**
 * Товары одного заказа — там лежит ЯЧЕЙКА КАЖДОГО ТОВАРА.
 *
 * Параметр ОДИН и в ЕДИНСТВЕННОМ числе: b2cOrderId. Пачкой (?b2cOrderIds=1,2,3)
 * сервер отвечает 400 — на этом расширение когда-то молча не собирало ячейки
 * вообще. Перебирать варианты имени параметра больше не нужно: он проверен.
 */
export async function fetchOrderItems(orderId, { signal } = {}) {
  const data = await get(KNOWN_ENDPOINTS.orderItems(orderId), { signal });
  return Array.isArray(data) ? data : (data && data.content) || [];
}

/** Размер пачки id в одном запросе товаров: длинный URL WMS может отвергнуть. */

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export { get as apiGet, sleep };
