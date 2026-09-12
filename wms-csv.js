// ==========================================
// wms-csv.js — импорт выгрузки «Скачать .csv» из WMS
// ==========================================
// Самый дешёвый способ получить разом всё, что лежит в ячейках: WMS сам
// умеет отдать список заказов одним файлом. Один клик оператора вместо
// сотни — и это тот случай, когда ручной шаг оправдан.
//
// Разбор идёт ПО ЗАГОЛОВКАМ КОЛОНОК, а не по их порядку: колонки в выгрузке
// можно переставлять и прятать прямо в интерфейсе WMS (там есть шестерёнка
// настройки таблицы), поэтому привязка к позиции сломалась бы на первом же
// операторе с другими настройками.
//
// Незнакомые колонки не выбрасываются молча: они возвращаются в поле
// `unmapped`, и попап показывает их списком — чтобы было видно, что именно
// приехало и не потерялось ли что-то важное.

// ТОЧНЫЕ имена колонок из настоящей выгрузки ТАШ-120 (29.08.2026).
// Заголовки оказались английскими camelCase, а не русскими, как в самой
// таблице WMS на экране: orderId, cellKey, customerPhone… Проверяются
// первыми и по полному совпадению — иначе `customerPhone` попадает под
// правило для `customer` и уезжает в имя клиента вместо телефона.
// Ровно так и было до того, как появился живой файл.
const EXACT_HEADER = {
  orderid: 'orderId',
  ordernumber: 'orderId',
  cellkey: 'cell',
  cellinfo: 'cell',
  cellname: 'cell',
  customerphone: 'phone',
  customer: 'clientName',
  customername: 'clientName',
  orderamount: 'totalPrice',
  amount: 'totalPrice',
  accepteddate: 'acceptedAt',
  createddate: 'createdAt',
  status: 'status',
  pid: 'pid',
  b2cpublicorderid: 'pid',
  orderbarcode: 'orderBarcode',
  b2corderbarcode: 'orderBarcode',
  barcode: 'barcode',
  sku: 'barcode',
  productname: 'itemName',
  ordertype: 'sourceType',
  partnercode: 'partner'
};

// Запасной, нечёткий разбор — для выгрузок с другими заголовками
// (в WMS состав колонок настраивается шестерёнкой) и для русских названий.
// Телефон стоит ВЫШЕ клиента намеренно: см. комментарий к EXACT_HEADER.
const FIELD_BY_HEADER = [
  [/^(ячейка|cell|ячейки)$/i, 'cell'],
  [/(телефон|phone|номер\s*тел)/i, 'phone'],
  [/(номер\s*заказа|^заказ$|order\s*number|^id$)/i, 'orderId'],
  [/^pid$/i, 'pid'],
  [/(штрих|штрих-?код|^шк$|шк\s*заказа)/i, 'orderBarcode'],
  [/(шк\s*товара|sku|product\s*barcode)/i, 'barcode'],
  [/(грузомест|^гм$|короб|cargo)/i, 'gm'],
  [/(покупател|клиент|получател|customer|фио)/i, 'clientName'],
  [/(наименован|товар|назван|product)/i, 'itemName'],
  [/(кол-?во|количест|quantity)/i, 'qty'],
  [/(^статус$|status|состоян)/i, 'status'],
  [/(тип\s*заказа|order\s*type)/i, 'sourceType'],
  [/(партн|partner|продавец|seller)/i, 'partner'],
  [/(дата\s*заказа|created)/i, 'createdAt'],
  [/(дата\s*приём|дата\s*приемк|accepted)/i, 'acceptedAt'],
  [/(срок\s*хранен|expire)/i, 'expiresAt'],
  [/(сумма|total|price|amount)/i, 'totalPrice'],
  [/(тип\s*оплаты|payment)/i, 'paymentType']
];

// Спецтипы узнаются по виду самого номера заказа — отдельной колонки для
// них в выгрузке нет. Формы взяты из живых данных ТАШ-120:
//   UZUM-BANK-1002328381  — банковская карта
//   RX612571528UZ         — посылка AliExpress
// Это те самые card/rx из §8 справочника рекомендаций: у них нет ни
// названия, ни габаритов, и раскладываются они по своим правилам.
const SPECIAL_BY_CODE = [
  [/^UZUM-BANK-/i, 'card'],
  [/^RX\d+UZ$/i, 'rx'],
  [/^SX\d+UZ$/i, 'sx']
];

function specialTypeOf(code) {
  const text = String(code || '').trim();
  for (const [re, type] of SPECIAL_BY_CODE) {
    if (re.test(text)) return type;
  }
  return null;
}

const CELL_RE = /^\d{3,}$/;
const GM_RE = /^\d{2}-\d{10}$/;

export function detectDelimiter(headerLine) {
  const candidates = [';', ',', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    // Считаем только разделители ВНЕ кавычек — иначе «Иванов, И.» в одной
    // ячейке перевесит настоящий разделитель.
    let count = 0, inQuotes = false;
    for (let i = 0; i < headerLine.length; i++) {
      const ch = headerLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

/** Полноценный разбор CSV: кавычки, экранированные кавычки, переводы строк внутри полей. */
export function parseCsv(text, delimiter) {
  const clean = String(text || '').replace(/^﻿/, '');   // BOM из Excel
  const d = delimiter || detectDelimiter(clean.split(/\r?\n/)[0] || '');

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];

    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === d) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return { rows: rows.filter(r => r.some(c => String(c).trim() !== '')), delimiter: d };
}

function headerField(header) {
  const text = String(header || '').trim();
  if (!text) return null;
  const exact = EXACT_HEADER[text.toLowerCase().replace(/[\s_\-.]/g, '')];
  if (exact) return exact;
  for (const [re, field] of FIELD_BY_HEADER) {
    if (re.test(text)) return field;
  }
  return null;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits || null;
}

/**
 * Превращает CSV-выгрузку в те же записи, что и сетевой перехват, —
 * чтобы дальше по коду не было разницы, откуда данные пришли.
 */
export { specialTypeOf };

export function recordsFromCsv(text, { endpoint = 'csv', source = 'unknown' } = {}) {
  const { rows, delimiter } = parseCsv(text);
  if (rows.length < 2) {
    return { records: [], columns: [], unmapped: [], delimiter, rowCount: 0 };
  }

  const header = rows[0];
  const mapping = header.map(headerField);
  const unmapped = header.filter((h, i) => !mapping[i] && String(h).trim());
  const columns = header.map((h, i) => ({ header: String(h).trim(), field: mapping[i] }));

  const records = [];
  for (const row of rows.slice(1)) {
    const record = { confidence: {}, origin: 'csv', endpoint, capturedAt: Date.now() };

    mapping.forEach((field, i) => {
      if (!field) return;
      const value = String(row[i] ?? '').trim();
      if (!value || value === '—' || value === '-') return;
      record[field] = value;
      record.confidence[field] = 'high';
    });

    // Значения, которые узнаются по виду, даже если колонка названа непривычно.
    for (const raw of row) {
      const value = String(raw ?? '').trim();
      if (!record.gm && GM_RE.test(value) && value !== record.orderBarcode) {
        record.gm = value; record.confidence.gm = 'medium';
      }
    }

    if (record.cell && !CELL_RE.test(record.cell)) {
      record.cellRaw = record.cell;
      delete record.cell;
      delete record.confidence.cell;
    }
    if (record.phone) record.phone = normalizePhone(record.phone) || record.phone;

    // Карты и RX опознаются по номеру заказа: отдельной колонки нет.
    const special = specialTypeOf(record.orderId) || specialTypeOf(record.orderBarcode);
    if (special) {
      record.specialType = special;
      record.confidence.specialType = 'medium';
    }

    const declared = String(record.sourceType || '').toLowerCase();
    record.source = ['fbo', 'fbs', 'partner', 'express'].includes(declared)
      ? declared
      : (special ? 'partner' : source);
    delete record.sourceType;

    record.clientId = record.clientId || record.phone || record.clientName || record.orderId || null;

    const meaningful = record.orderId || record.orderBarcode || record.pid || record.barcode || record.gm;
    if (meaningful) records.push(record);
  }

  return { records, columns, unmapped, delimiter, rowCount: rows.length - 1 };
}
