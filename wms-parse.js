// Разбор ответов WMS.
//
// Классический скрипт (не модуль): подключается и в content.js, и в
// background.js, и в страницах расширения — везде через globalThis.UCoreWmsParse.
//
// ПОЧЕМУ ЗДЕСЬ БОЛЬШЕ НЕТ УГАДЫВАНИЯ.
//
// Раньше этот файл пытался распознать поля по названию («cellName», «ячейка»,
// «place»…) и по виду значения («85-0008335216 похоже на грузоместо»). Это
// имело смысл ровно до тех пор, пока адреса и формы ответов WMS были
// неизвестны. Сейчас они сняты с живой системы и перепроверены: их семь,
// и у каждого известен точный набор полей (см. WMS-API-NOTES.md).
//
// Угадывание стоило дорого. Оно затаскивало в таблицу мусор (обрывки чужих
// таблиц, справочник товаров как «заказы», ссылку на PDF в графу «Клиент»),
// и каждая такая ошибка выглядела для оператора как новая поломка. Разбор
// по известной форме или даёт запись, или честно не даёт ничего.
//
// Правило: новый эндпоинт — новый явный маппер здесь. Никаких эвристик.

(function (root) {
  'use strict';

  // ---------- вспомогательное ----------

  const text = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length ? trimmed : null;
    }
    return null;
  };

  const digits = (value) => {
    const t = text(value);
    if (!t) return null;
    const only = t.replace(/\D+/g, '');
    return only.length ? only : null;
  };

  /** Имя клиента: WMS отдаёт его частями, и склеивать надо именно их. */
  function clientName(customer) {
    if (!customer || typeof customer !== 'object') return null;
    const parts = [customer.lastName, customer.firstName, customer.middleName]
      .map(text)
      .filter(Boolean);
    return parts.length ? parts.join(' ') : null;
  }

  /**
   * Позиция считается настоящей, только если её можно найти и отсканировать.
   * Номер короба (ГМ) сам по себе позицией НЕ является: он говорит «что-то
   * приехало в этой коробке», но не говорит, что именно.
   */
  function isMeaningful(record) {
    return !!(record.orderId || record.orderBarcode || record.pid || record.barcode);
  }

  function clean(record) {
    const out = {};
    for (const [key, value] of Object.entries(record)) {
      if (value !== null && value !== undefined && value !== '') out[key] = value;
    }
    return out;
  }

  // ---------- маппер 1: экран «Заказы» ----------
  // GET /de/v3/delivery-point/orders
  // Ячейка приходит ПРЯМО В СПИСКЕ, полем cellInfo.

  function fromOrdersV3(list) {
    const records = [];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      // ДВА РАЗНЫХ НОМЕРА ЗАКАЗА. Проверено на живом ПВЗ 30.08.2026:
      // у 251 заказа из 276 они НЕ совпадают.
      //   orderId     5127054430  — внутренний номер WMS, оператор его не видит
      //   b2cOrderId   122575788  — тот, что в колонке «Номер заказа»
      //                             И ТОЛЬКО ЕГО принимает запрос товаров
      // Раньше в orderId писался внутренний номер, и добор ячеек уходил
      // с несуществующим идентификатором: ни ячеек, ни ШК, ни названий.
      // У партнёрских заказов оба номера совпадают, так что правило одно.
      const record = clean({
        cell: text(row.cellInfo),
        orderId: text(row.b2cOrderId) || text(row.orderId),
        wmsOrderId: text(row.orderId),
        pid: text(row.b2cPublicOrderId),
        orderBarcode: text(row.orderBarcode) || text(row.b2cOrderBarcode),
        clientName: clientName(row.customer),
        phone: digits(row.customer && row.customer.phone),
        status: text(row.status),
        // ТИП и ПАРТНЁР — две РАЗНЫЕ характеристики, а не одна.
        //   orderType   FBO | FBS            — модель фулфилмента
        //   partnerCode uzum-bank | JOOM | … — канал продажи
        // Партнёрский заказ приходит как orderType FBO с partnerCode.
        // Схлопывать их в одну графу нельзя: в одну смену это и uzum-bank,
        // и JOOM, и обычный FBO — оператор обязан их различать.
        source: String(row.orderType || '').toLowerCase() === 'fbs' ? 'fbs' : 'fbo',
        partner: text(row.partnerCode),
        // РЕЖИМ ОТПРАВКИ — самый честный признак того, ЧТО лежит на полке.
        // Замер на живом ПВЗ 07.09.2026, 296 заказов:
        //   ITEM               186  потоварка: у каждой вещи своя ячейка
        //   ORDER               91  FBS: продавец собрал пакет, вещь одна
        //   THIRD_PARTY_ORDER   19  партнёрский (uzum-bank 17, JOOM 2)
        // orderType этого не различает: партнёрские приходят как FBO.
        shipmentMode: text(row.shipmentMode),
        acceptedAt: text(row.acceptedDate),
        expiresAt: text(row.expiredDate)
      });
      if (isMeaningful(record)) records.push(record);
    }
    return records;
  }

  // ---------- маппер 2: экран «Товары» ----------
  // GET /de/delivery-point/b2c-orders
  //
  // ЭТОТ СПИСОК БОЛЬШЕ НЕ СОБИРАЕТСЯ. Проверено на живом ПВЗ 30.08.2026:
  // все 240 его заказов уже есть в /de/v3/delivery-point/orders (265),
  // но здесь у них нет поля ячейки. Собирая оба списка, расширение клало
  // каждый заказ в таблицу дважды. Маппер оставлен на случай точечного
  // запроса, в сборе он не участвует.

  function fromB2cOrders(list) {
    const records = [];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const record = clean({
        orderId: text(row.b2cOrderId),
        pid: text(row.b2cPublicOrderId),
        orderBarcode: text(row.b2cOrderBarcode),
        clientName: clientName(row.customer),
        phone: digits(row.customer && row.customer.phone),
        status: text(row.status),
        source: 'fbo',
        acceptedAt: text(row.acceptedDate),
        expiresAt: text(row.expiredDate)
      });
      if (isMeaningful(record)) records.push(record);
    }
    return records;
  }

  // ---------- маппер 3: товары одного заказа ----------
  // GET /de/v2/delivery-point/b2c-orders/items?b2cOrderId=…
  // Здесь лежит ЯЧЕЙКА КАЖДОГО ТОВАРА (items[].cellBarcode).
  // Одна позиция = одна строка: у заказа с двумя товарами ячейки разные.

  function fromOrderItems(list) {
    const records = [];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const head = {
        // Тот же номер, что в списке заказов: b2cOrderId, а не внутренний.
        orderId: text(row.b2cOrderId),
        pid: text(row.b2cOrderPublicId),
        orderBarcode: text(row.b2cOrderBarcode),
        clientName: clientName(row.customer),
        phone: digits(row.customer && row.customer.phone),
        source: 'fbo'
      };
      const items = Array.isArray(row.items) ? row.items : [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const record = clean({
          ...head,
          cell: text(item.cellBarcode),
          barcode: text(item.skuBarcode),
          skuId: text(item.skuItemId),
          amount: Number.isFinite(Number(item.amount)) ? Number(item.amount) : null,
          status: text(item.status)
        });
        if (isMeaningful(record)) records.push(record);
      }
      // Заказ без позиций строкой не становится: у партнёрских заказов
      // items приходит пустым, а сам заказ уже есть из маппера 1.
    }
    return records;
  }

  // ---------- маппер 4: содержимое грузоместа ----------
  // GET /de/delivery-point/cargo-places/{id}/orders
  // Ячейка (dpCellBarcode) здесь пустая, и это правда: короб ещё не принят.

  function fromCargoPlaceOrders(list) {
    const records = [];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      const record = clean({
        cell: text(row.dpCellBarcode),
        // В содержимом грузоместа orderId и wmsOrderId — это одно и то же
        // внутреннее число; b2c-номера здесь нет вовсе.
        orderId: text(row.orderId) || text(row.wmsOrderId),
        pid: text(row.b2cPublicOrderId),
        orderBarcode: text(row.orderBarcode),
        barcode: text(row.skuItemBarcode),
        skuId: text(row.skuItemId),
        clientName: clientName(row.customer),
        phone: digits(row.customer && row.customer.phone),
        status: text(row.status),
        // Сколько физических единиц в строке. У грузомест почти всегда одна
        // (`skuItemId` — номер конкретной вещи), но поле приходит, и считать
        // по нему честнее, чем по числу строк.
        amount: Number(row.amount) > 1 ? Math.floor(Number(row.amount)) : undefined,
        source: 'cargo'
      });
      if (isMeaningful(record)) records.push(record);
    }
    return records;
  }

  // ---------- диспетчер по адресу ----------
  // Адрес известен всегда: запрос делает расширение, а не «что-то прилетело».

  const ROUTES = [
    [/\/v3\/delivery-point\/orders$/, fromOrdersV3],
    [/\/v2\/delivery-point\/b2c-orders\/items$/, fromOrderItems],
    [/\/delivery-point\/b2c-orders$/, fromB2cOrders],
    [/\/cargo-places\/[^/]+\/orders$/, fromCargoPlaceOrders]
  ];

  function mapperFor(url) {
    let path;
    try {
      path = new URL(url, 'https://x.invalid').pathname;
    } catch (e) {
      return null;
    }
    for (const [re, fn] of ROUTES) if (re.test(path)) return fn;
    return null;
  }

  /**
   * Разбирает ответ известного эндпоинта. Незнакомый адрес даёт ПУСТО —
   * это осознанно: лучше ничего, чем выдуманные строки.
   */
  function normalizeCapture(entry) {
    const url = entry && entry.url;
    const result = { records: [], meta: { endpoint: url || null, mapped: false } };
    if (!entry || entry.response === undefined || entry.response === null) return result;

    const mapper = mapperFor(url);
    if (!mapper) return result;

    const response = entry.response;
    const list = Array.isArray(response)
      ? response
      : (Array.isArray(response.content) ? response.content : null);
    if (!list) return result;

    result.records = mapper(list);
    result.meta.mapped = true;
    return result;
  }

  // ---------- справочник ячеек ----------
  // GET /de/delivery-point/cells -> { content: ["111","112",…], last: true }

  function extractCellDirectory(entry) {
    const response = entry && entry.response;
    const list = Array.isArray(response)
      ? response
      : (response && Array.isArray(response.content) ? response.content : null);
    if (!list || !list.length) return null;
    const cells = list
      .filter((v) => typeof v === 'string' || typeof v === 'number')
      .map(String)
      .filter((v) => /^\d{3,4}$/.test(v));
    return cells.length === list.length && cells.length ? cells : null;
  }

  // ---------- код ячейки ----------
  // СЕКЦИЯ + ЭТАЖ + ПОЗИЦИЯ, читается С КОНЦА: последняя цифра — позиция,
  // предпоследняя — этаж, всё остальное — секция. «1244» это секция 12,
  // этаж 4, позиция 4 — чтение слева направо дало бы секцию 1.

  function parseCellCode(code) {
    const t = String(code || '');
    if (!/^\d{3,4}$/.test(t)) return null;
    return {
      section: t.slice(0, -2),
      floor: t.slice(-2, -1),
      position: t.slice(-1)
    };
  }

  // ---------- слияние ----------

  /**
   * Ключ ФИЗИЧЕСКОЙ СТРОКИ, а не заказа.
   *
   * У потоварной выдачи один заказ приходит несколькими строками — по
   * строке на товар, с ОБЩИМ b2cOrderId. Если два таких товара лежат в
   * ОДНОЙ ячейке, все поля ключа у них совпадали, и вторая строка молча
   * затирала первую: две единицы на полке превращались в одну.
   *
   * Внутренний номер отправления (`wmsOrderId`) у этих строк разный —
   * он и разводит их. Ключ считается из полей записи каждый раз заново,
   * поэтому уже накопленные записи получают новый ключ сами, без
   * дублирования и без переезда хранилища.
   *
   * То же самое и в коробах, только идентификатор другой — `skuId`
   * (skuItemId). Замер на живом ПВЗ 03.09.2026: WMS отдал 257 позиций,
   * а по ключу без skuId их оставалось 233 — двадцать четыре одинаковые
   * единицы затирали друг друга. У одного заказа в одном коробе бывает
   * по четыре одинаковых товара, и каждый надо принять отдельно.
   * skuItemId у всех 257 разный — он и есть номер физической единицы.
   */
  function recordKey(record) {
    return [
      record.gm || '',
      record.orderId || record.orderBarcode || '',
      record.wmsOrderId || '',
      record.skuId || '',
      record.barcode || '',
      record.cell || '',
      record.itemName || ''
    ].join('|');
  }

  /**
   * Сливает новые записи в накопленные.
   *
   * Поля ДОПОЛНЯЮТСЯ, а не перетираются пустыми: одна позиция приходит с
   * разных экранов кусками — на одном есть клиент, на другом ячейка и ШК.
   *
   * Заготовка заказа (есть номер, но нет ни ячейки, ни ШК) поглощается,
   * как только приходит подробная строка того же заказа: иначе в таблице
   * рядом со строкой товара висела бы пустая строка-двойник.
   */
  function mergeRecords(existing, incoming, limit) {
    const byKey = new Map();
    for (const record of existing || []) byKey.set(recordKey(record), record);

    let added = 0;
    let enriched = 0;
    let restored = 0;

    for (const record of incoming || []) {
      const key = recordKey(record);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { ...record });
        added++;
        continue;
      }
      // WMS ПОКАЗАЛ ЗАКАЗ СНОВА — значит он на полке, а не «выдан или убыл».
      // Пометку снимаем прямо здесь, не дожидаясь сверки: сверка может не
      // отработать (оборванный список), и тогда заказ навсегда оставался бы
      // помеченным — а значит невидимым и для подсчёта, и для инвентаризации.
      if (prev.gone) {
        delete prev.gone;
        delete prev.goneAt;
        delete prev.goneStatus;
        restored++;
      }
      let changed = false;
      for (const [field, value] of Object.entries(record)) {
        if (value === null || value === undefined || value === '') continue;
        if (prev[field] === value) continue;
        if (prev[field] === undefined || prev[field] === null || prev[field] === '') {
          prev[field] = value;
          changed = true;
        }
      }
      if (changed) enriched++;
    }

    // ПОГЛОЩЕНИЕ ЗАГОТОВОК.
    //
    // Один заказ приходит дважды: строкой из списка (клиент, статус, срок
    // хранения — но без ячейки) и строкой из товаров (ячейка и ШК — но без
    // срока хранения). Держать обе нельзя: в таблице у товара оказывался
    // пустой двойник.
    //
    // Поэтому заготовка не просто удаляется — сначала её поля ПЕРЕЛИВАЮТСЯ
    // в подробные строки того же заказа. Иначе вместе с ней терялось всё,
    // чего нет в ответе про товары: срок хранения, тип оплаты, статус
    // заказа. Раньше именно так и терялось.
    const detailedByOrder = new Map();
    for (const record of byKey.values()) {
      if (!(record.cell || record.barcode)) continue;
      // Поглотителем может быть только ЖИВАЯ запись того же рода.
      // Позиция грузоместа (source: 'cargo') в подсчёте не участвует, а
      // помеченная «выдан или убыл» — тем более: влить в них строку из
      // свежего списка значит стереть заказ, который лежит на полке.
      if (record.gone || record.source === 'cargo') continue;
      const id = String(record.orderId || record.orderBarcode || '');
      if (!id) continue;
      if (!detailedByOrder.has(id)) detailedByOrder.set(id, []);
      detailedByOrder.get(id).push(record);
    }

    // ПОЛЯ КЛЮЧА ПЕРЕЛИВАТЬ НЕЛЬЗЯ — они и есть личность записи.
    //
    // На этом расширение и надорвалось. Строка заказа несёт внутренний
    // номер отправления (wmsOrderId), строки товаров — нет. Переливание
    // дописывало этот номер в строку товара, и её ключ МЕНЯЛСЯ. На
    // следующем сборе те же товары приходили без номера, ключ снова не
    // совпадал — и каждая вещь ложилась в таблицу второй раз. На полке
    // одна вещь, в ячейке «1 из 2», ячейка не закрывается никогда.
    //
    // Переливаем только описание: клиент, телефон, срок хранения, тип
    // оплаты, статус. Ничего из этого в ключ не входит.
    const KEY_FIELDS = new Set(['gm', 'orderId', 'orderBarcode', 'wmsOrderId',
                                'skuId', 'barcode', 'cell', 'itemName']);

    const pourInto = (record, targets) => {
      for (const target of targets) {
        for (const [field, value] of Object.entries(record)) {
          if (value === null || value === undefined || value === '') continue;
          if (KEY_FIELDS.has(field)) continue;
          if (target[field] === undefined || target[field] === null || target[field] === '') {
            target[field] = value;
          }
        }
      }
    };

    for (const [key, record] of [...byKey.entries()]) {
      if (record.gm || record.barcode) continue;
      const id = String(record.orderId || record.orderBarcode || '');
      if (!id) continue;
      const all = detailedByOrder.get(id);
      if (!all || !all.length) continue;

      // Строка БЕЗ ячейки — обычная заготовка: её поглощает любая подробная
      // строка того же заказа.
      if (!record.cell) {
        pourInto(record, all);
        byKey.delete(key);
        continue;
      }

      // СТРОКА ЗАКАЗА С ЯЧЕЙКОЙ, НО БЕЗ ШТРИХКОДА — тоже двойник, и он
      // завышал ожидаемое количество на инвентаризации.
      //
      // Список заказов отдаёт ячейку прямо в строке заказа (cellInfo).
      // Если по тому же заказу уже пришли строки товаров И ЛЕЖАТ В ТОЙ ЖЕ
      // ЯЧЕЙКЕ, то это одна и та же вещь, описанная дважды: в ячейке
      // оказывалось две позиции там, где лежит одна.
      //
      // Поглощаем ТОЛЬКО при совпадении ячейки. У обычного заказа из одной
      // вещи строк товаров нет вовсе (мы их не запрашиваем — ячейка уже
      // известна), и он остаётся единственной строкой, как и должен.
      const sameCell = all.filter(t => t.barcode && t.cell === record.cell);
      if (!sameCell.length) continue;
      pourInto(record, sameCell);
      byKey.delete(key);
    }

    let records = [...byKey.values()];
    let dropped = 0;
    let droppedLive = 0;

    // ПЕРЕПОЛНЕНИЕ ХРАНИЛИЩА НЕ ДОЛЖНО СТОИТЬ ЖИВЫХ ЗАКАЗОВ.
    //
    // Раньше здесь стояло `records.slice(-limit)`: при достижении предела
    // обрезался хвост по порядку добавления — и вместе со старой историей
    // улетали заказы, которые прямо сейчас лежат на полке. Оператор видел
    // недобор на несколько десятков и не мог понять, куда они делись:
    // список WMS их отдавал, а в базе их не было.
    //
    // Теперь порядок обратный: сначала выбрасываем историю (самое старое
    // «выдано или убыло»), и только если живых записей больше предела —
    // обрезаем их, но об этом сообщаем наверх отдельным числом.
    if (limit && records.length > limit) {
      const live = records.filter(r => !r.gone);
      const history = records.filter(r => r.gone)
        .sort((a, b) => (Number(a.goneAt) || 0) - (Number(b.goneAt) || 0));
      const room = Math.max(0, limit - live.length);
      const keptHistory = room >= history.length ? history : history.slice(history.length - room);
      dropped = history.length - keptHistory.length;
      records = keptHistory.concat(live);
      if (records.length > limit) {
        droppedLive = records.length - limit;
        dropped += droppedLive;
        records = records.slice(records.length - limit);
      }
    }
    return { records, added, enriched, restored, dropped, droppedLive };
  }

  /**
   * Ответ поиска отправления -> запись нашего формата.
   * Здесь же лежит ЯЧЕЙКА (cellId) — ради неё поиск и нужен.
   */
  function fromShipmentSearch(data, kind) {
    if (!data || typeof data !== 'object') return null;
    return clean({
      cell: text(data.cellId),
      orderId: text(data.b2cOrderId) || text(data.orderId),
      wmsOrderId: text(data.orderId),
      pid: text(data.b2cPublicOrderId),
      orderBarcode: text(data.barcode),
      clientName: clientName(data.customer),
      phone: digits(data.customer && data.customer.phone),
      status: text(data.status),
      // ДАТА ВЫДАЧИ — единственный однозначный признак того, что вещи на
      // полке уже нет. Статусы у WMS разные от экрана к экрану, а
      // `issuedDate` либо пустой, либо стоит, и стоит он ровно тогда,
      // когда заказ отдали клиенту.
      issuedDate: text(data.issuedDate),
      source: String(data.orderType || '').toLowerCase() === 'fbs' ? 'fbs' : 'fbo',
      phase: kind || null            // delivered | acceptance | return
    });
  }

  /**
   * ЛЕЖИТ ЛИ ЭТА ВЕЩЬ НА ПОЛКЕ ПРЯМО СЕЙЧАС.
   *
   * У заказа может быть ячейка и при этом не быть самого заказа на полке:
   * выданный заказ ячейку не теряет, WMS помнит, где он лежал. Инвентаризация
   * же считает ВЕЩИ, а не записи, и засчитать выданный заказ найденным —
   * значит закрыть ячейку с недостачей: там лежит на одну вещь меньше, чем
   * получилось по счёту, и всплывёт это в тот день, когда за соседним
   * заказом придёт клиент.
   *
   * Список статусов — БЕЛЫЙ, а не чёрный. Статусов у WMS больше, чем мы
   * видели, и незнакомый должен означать «не считать», а не «считать»:
   * ошибиться в сторону лишней проверки дешевле, чем в сторону молчания.
   */
  const SHELF_STATUS = new Set([
    'DELIVERED',            // привезён на ПВЗ, лежит и ждёт клиента
    'TEMP_DELIVERED',       // то же, временное хранение
    'CHECKING_BY_CUSTOMER', // клиент у стойки, вещь ещё здесь
    'ACCEPTED'              // принят и размещён (строка товара)
  ]);

  function shelfState(record) {
    if (!record) return { onShelf: false, why: 'записи нет' };
    if (text(record.issuedDate)) return { onShelf: false, why: 'заказ уже выдан' };
    if (record.gone) return { onShelf: false, why: record.goneStatus || 'заказа больше нет в WMS' };
    const phase = String(record.phase || '').toLowerCase();
    if (phase && phase !== 'delivered') {
      return { onShelf: false, why: phase === 'return' ? 'заказ в возвратах' : 'заказ на приёмке' };
    }
    const status = String(text(record.status) || '').toUpperCase();
    if (!status) return { onShelf: true };          // WMS промолчал — не выдумываем
    if (SHELF_STATUS.has(status)) return { onShelf: true };
    return { onShelf: false, why: `статус ${status}` };
  }

  function isOnShelf(record) {
    return shelfState(record).onShelf;
  }

  /**
   * СВЕРКА С ТЕМ, ЧТО СЕЙЧАС В WMS.
   *
   * За смену список меняется в обе стороны: приезжают новые заказы, а
   * выданные исчезают. Простое слияние умеет только добавлять — выданный
   * вчера заказ оставался в таблице навсегда и на инвентаризации искался
   * как недостача, которой нет.
   *
   * Поэтому после каждого сбора отмечаем: чего WMS больше не показывает.
   * Записи НЕ удаляем — оператор должен видеть, что заказ был и куда
   * делся, — а помечаем `gone` и ставим статус. Если заказ вернётся
   * (WMS отдал его снова), метка снимается.
   *
   * Позиции из грузомест в сверке не участвуют: они живут в своём списке.
   */
  function reconcile(records, seenOrderIds, { status = 'ВЫДАН ИЛИ УБЫЛ', at = Date.now() } = {}) {
    const seen = new Set([...(seenOrderIds || [])].map(String));
    let marked = 0;
    let restored = 0;

    const out = (records || []).map((record) => {
      if (record.source === 'cargo') return record;
      const id = String(record.orderId || record.orderBarcode || '');
      if (!id) return record;

      if (seen.has(id)) {
        if (record.gone) {
          const { gone, goneAt, goneStatus, ...rest } = record;
          restored++;
          return rest;
        }
        return record;
      }

      if (record.gone) return record;
      marked++;
      return { ...record, gone: true, goneAt: at, goneStatus: status };
    });

    return { records: out, marked, restored };
  }

  /**
   * ЧТО ЭТО ЗА ПОСЫЛКА — словами, которые оператор видит на коробке.
   *
   * У заказов без потоварной росписи названия товара нет и быть не может:
   * FBS собирает продавец, партнёрские приходят чужой посылкой. Раньше в
   * таблице у них стояло «Без названия» — строка, которая не отличает
   * пакет Aliexpress от карты банка и ничего не подсказывает на полке.
   *
   * Замер 07.09.2026: partnerCode приходит в РАЗНОМ регистре и написании
   * (`uzum-bank` строчными через дефис, `JOOM` прописными), поэтому код
   * приводится к общему виду, а незнакомый партнёр показывается как есть,
   * а не прячется за «Без названия».
   */
  const PARTNER_LABEL = {
    'uzumbank': 'UZUM-BANK',
    'uzumnasiya': 'Uzum Nasiya',
    'uzumglobal': 'Uzum Global',
    'aliexpress': 'Aliexpress',
    'joom': 'JOOM'
  };

  /**
   * ШТРИХКОД ГОВОРИТ ТОЧНЕЕ, ЧЕМ КОД ПАРТНЁРА.
   *
   * Замер 07.09.2026: заказ `RX612087819UZ` приходит с `partnerCode: JOOM`,
   * а сам WMS помечает его в списке как «UG» — Uzum Global. Оператор видит
   * на коробке буквы, а не внутренний код, и подписывать надо тем же
   * словом, каким подписывает WMS. Поэтому префикс штрихкода — первый.
   */
  const BARCODE_LABEL = [
    [/^UZUM-BANK-/i, 'UZUM-BANK'],
    [/^RX/i, 'Uzum Global'],
    [/^SX/i, 'Aliexpress']
  ];

  function typeLabel(record) {
    if (!record) return '';
    const code = text(record.orderBarcode);
    if (code) {
      for (const [re, label] of BARCODE_LABEL) if (re.test(code)) return label;
    }
    const partner = text(record.partner);
    if (partner) {
      const key = partner.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (PARTNER_LABEL[key]) return PARTNER_LABEL[key];
      // Незнакомый партнёр: `some-partner_code` -> `Some Partner Code`.
      return partner.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
    // ТИП БЕРЁМ ИЗ `orderType`, А НЕ ИЗ РЕЖИМА ОТПРАВКИ.
    //
    // На ТАШ-120 режим ORDER встречался только у FBS, и подпись «FBS» была
    // верной по совпадению. Замер на FrТАШ-223 08.09.2026 это совпадение
    // разрушил: там ORDER у ВСЕХ — 282 заказа FBO и 61 FBS. Подписать
    // фирменный заказ Uzum как «FBS» значит соврать оператору о том, кто
    // его собирал. `orderType` — это ровно то, что сам WMS пишет в карточке
    // строкой «Тип заказа».
    if (isWholeOrder(record)) {
      return String(record.source || '').toLowerCase() === 'fbs' ? 'FBS' : 'FBO';
    }
    return '';
  }

  /**
   * КЛЮЧ ПОСЫЛКИ, А НЕ ЗАКАЗА.
   *
   * Один заказ приезжает НЕСКОЛЬКИМИ коробками, и лежат они в разных
   * ячейках. Замер FrТАШ-223 08.09.2026: из 272 заказов 48 приехали больше
   * чем одной посылкой, у одного их восемь; заказ 124517750 разложен по
   * ячейкам 251, 132 и 312, и внутри каждой коробки СВОИ товары.
   *
   * Поэтому состав привязывается к посылке — к внутреннему номеру
   * отправления `wmsOrderId`, тому самому, что стоит и в строке списка
   * заказов, и в ответе про состав. Ключом заказа три коробки получили бы
   * одно и то же содержимое, и оператор искал бы в ячейке 251 то, что
   * лежит в 312.
   *
   * У старых записей (и у потоварных строк) номера отправления нет —
   * там ключом остаётся заказ, как и было.
   */
  function packageKey(record) {
    if (!record) return '';
    return text(record.wmsOrderId) || text(record.orderId) || text(record.orderBarcode) || '';
  }

  /**
   * Посылка целиком, а не вещь из потоварной росписи.
   *
   * `shipmentMode: 'ORDER'` — это и есть FBS: один заказ, один штрихкод,
   * одна ячейка, содержимое ПВЗ неизвестно. Старые записи режима не знают,
   * поэтому запасной признак — источник.
   */
  function isWholeOrder(record) {
    if (!record) return false;
    const mode = String(record.shipmentMode || '').toUpperCase();
    if (mode === 'ORDER') return true;
    if (mode === 'ITEM' || mode === 'THIRD_PARTY_ORDER') return false;
    return String(record.source || '').toLowerCase() === 'fbs';
  }

  /**
   * СКОЛЬКО ФИЗИЧЕСКИХ ЕДИНИЦ В СТРОКЕ.
   *
   * Экран «Перейти к выдаче» показывает у каждой строки «0 / N шт.», и это
   * N — число одинаковых копий товара в этом заказе и в этой ячейке.
   * Приходит оно полем `amount` из запроса товаров: строка ОДНА, копий в
   * ней бывает несколько.
   *
   * Считать строки вместо копий — значит недосчитаться товара. Оператор
   * закроет ячейку, отсканировав одну вещь из двух, и недостача всплывёт
   * в тот день, когда за второй придёт клиент.
   *
   * Позиции грузомест сюда не попадают: там `amount` не приходит вовсе,
   * а строка и есть единица (у каждой свой `skuItemId`).
   */
  function unitsOf(record) {
    const n = Number(record && record.amount);
    return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
  }

  /** Сколько ВЕЩЕЙ в наборе строк. Не то же самое, что число строк. */
  function countUnits(records) {
    let total = 0;
    for (const record of records || []) total += unitsOf(record);
    return total;
  }

  root.UCoreWmsParse = {
    fromShipmentSearch,
    reconcile,
    normalizeCapture,
    extractCellDirectory,
    parseCellCode,
    mergeRecords,
    recordKey,
    unitsOf,
    typeLabel,
    packageKey,
    isWholeOrder,
    countUnits,
    shelfState,
    isOnShelf,
    // маппера доступны поимённо — тестам и на случай точечного вызова
    fromOrdersV3,
    fromB2cOrders,
    fromOrderItems,
    fromCargoPlaceOrders
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
