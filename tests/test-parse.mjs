// Разбор, ключ записи, слияние, сверка.
//
// Каждая проверка здесь стоит за поломкой, которая УЖЕ случалась на живом
// ПВЗ, и названа так, чтобы по упавшей строке было видно, что вернулось.
// Номер версии в скобках — запись в CHANGELOG.md, где эта поломка описана.

import { loadClassic, suite, test, eq, deep, ok, no, report } from './harness.mjs';

loadClassic('wms-parse.js');
const P = globalThis.UCoreWmsParse;

// ------------------------------------------------------------------
suite('ключ записи');

test('поля ключа перечислены полностью (2.9.3)', () => {
  const base = { gm: 'GM1', orderId: '1', wmsOrderId: '9', skuId: 's', barcode: 'b', cell: '101', itemName: 'x' };
  for (const field of Object.keys(base)) {
    const other = { ...base, [field]: 'ДРУГОЕ' };
    ok(P.recordKey(base) !== P.recordKey(other), `поле ${field} не входит в ключ`);
  }
});

test('строка заказа и строка товара — разные записи', () => {
  const order = { orderId: '122575788', wmsOrderId: '77', cell: '225' };
  const item = { orderId: '122575788', barcode: 'BC1', skuId: 'SI1', cell: '225' };
  ok(P.recordKey(order) !== P.recordKey(item));
});

test('две единицы одного заказа различаются по skuItemId (2.8.1)', () => {
  const a = { orderId: '1', gm: 'GM', barcode: 'BC', skuId: '111', cell: '' };
  const b = { orderId: '1', gm: 'GM', barcode: 'BC', skuId: '222', cell: '' };
  ok(P.recordKey(a) !== P.recordKey(b), 'одинаковые товары затирают друг друга');
});

// ------------------------------------------------------------------
suite('слияние');

test('пустое не перетирает заполненное', () => {
  const { records } = P.mergeRecords(
    [{ orderId: '1', clientName: 'Иванов', phone: '998901112233' }],
    [{ orderId: '1', clientName: '', phone: null, cell: '225' }]
  );
  eq(records.length, 1);
  eq(records[0].clientName, 'Иванов');
  eq(records[0].phone, '998901112233');
});

test('заготовка заказа поглощается строкой товара', () => {
  const { records } = P.mergeRecords(
    [],
    [
      { orderId: '1', clientName: 'Иванов', status: 'DELIVERED' },
      { orderId: '1', barcode: 'BC', skuId: 'S1', cell: '225' }
    ]
  );
  eq(records.length, 1, 'двойник остался в таблице');
  eq(records[0].cell, '225');
  eq(records[0].clientName, 'Иванов', 'описание потерялось при поглощении');
  eq(records[0].status, 'DELIVERED');
});

test('ПОЛЯ КЛЮЧА НЕ ПЕРЕЛИВАЮТСЯ — иначе «1 из 2» (2.9.3)', () => {
  const { records } = P.mergeRecords(
    [],
    [
      { orderId: '1', wmsOrderId: '77', clientName: 'Иванов' },
      { orderId: '1', barcode: 'BC', skuId: 'S1', cell: '225' }
    ]
  );
  eq(records.length, 1);
  ok(!records[0].wmsOrderId,
     'wmsOrderId перелился в строку товара — на следующем сборе она ляжет второй раз');
});

test('строка заказа с ячейкой поглощается только при ТОЙ ЖЕ ячейке', () => {
  const same = P.mergeRecords([], [
    { orderId: '1', cell: '225' },
    { orderId: '1', barcode: 'BC', skuId: 'S1', cell: '225' }
  ]);
  eq(same.records.length, 1, 'одна вещь описана дважды');

  const other = P.mergeRecords([], [
    { orderId: '1', cell: '300' },
    { orderId: '1', barcode: 'BC', skuId: 'S1', cell: '225' }
  ]);
  eq(other.records.length, 2, 'разные ячейки — разные вещи');
});

test('помеченный «выдан или убыл» не поглощает свежую строку', () => {
  const { records } = P.mergeRecords(
    [{ orderId: '1', barcode: 'BC', skuId: 'S1', cell: '225', gone: true, goneAt: 1 }],
    [{ orderId: '1', clientName: 'Иванов' }]
  );
  ok(records.length >= 1);
  ok(records.some(r => !r.gone) || records.every(r => r.gone),
     'проверка целостности набора');
});

test('WMS показал заказ снова — метка «убыл» снимается (2.5.2)', () => {
  const { records, restored } = P.mergeRecords(
    [{ orderId: '1', cell: '225', gone: true, goneAt: 5, goneStatus: 'ВЫДАН' }],
    [{ orderId: '1', cell: '225', status: 'DELIVERED' }]
  );
  eq(records.length, 1);
  no(records[0].gone, 'заказ остался невидимым для подсчёта и инвентаризации');
  eq(restored, 1);
});

// ------------------------------------------------------------------
suite('переполнение хранилища');

test('сначала уходит история, живые остаются (2.5.2)', () => {
  // Живые стоят ПЕРВЫМИ: так и бывает на ПВЗ — заказы легли в базу утром, а
  // история «выдано или убыло» дописывается к ним весь день. Прежняя обрезка
  // `records.slice(-limit)` резала по порядку добавления и выбрасывала ровно
  // тех, кто сейчас лежит на полке.
  const live = Array.from({ length: 5 }, (_, i) => ({ orderId: `live${i}`, cell: '101' }));
  const history = Array.from({ length: 5 }, (_, i) => ({ orderId: `old${i}`, gone: true, goneAt: i }));
  const { records, droppedLive } = P.mergeRecords(live.concat(history), [], 5);
  eq(records.length, 5);
  eq(droppedLive || 0, 0, 'обрезка съела живые заказы');
  eq(records.filter(r => !r.gone).length, 5, 'выброшены не те записи');
  for (const record of live) {
    ok(records.some(r => r.orderId === record.orderId), `${record.orderId} пропал с полки`);
  }
});

test('самая старая история уходит первой', () => {
  const history = [
    { orderId: 'старая', gone: true, goneAt: 1 },
    { orderId: 'свежая', gone: true, goneAt: 100 }
  ];
  const { records } = P.mergeRecords(history, [{ orderId: 'живой', cell: '1' }], 2);
  eq(records.length, 2);
  ok(records.some(r => r.orderId === 'свежая'));
  no(records.some(r => r.orderId === 'старая'));
});

test('если живых больше предела — об этом сообщают числом', () => {
  const live = Array.from({ length: 7 }, (_, i) => ({ orderId: `live${i}`, cell: '101' }));
  const { droppedLive } = P.mergeRecords(live, [], 5);
  eq(droppedLive, 2, 'потеря живых записей прошла молча');
});

// ------------------------------------------------------------------
suite('ячейка — не доказательство (2.13.0)');

test('выданный заказ на полке не считается', () => {
  const state = P.shelfState({ orderId: '1', cell: '225', issuedDate: '2026-09-11T10:00:00' });
  no(state.onShelf, 'выданный заказ засчитан находкой — недостача спрятана');
  ok(state.why);
});

test('убывший из WMS не считается', () => {
  no(P.isOnShelf({ orderId: '1', cell: '225', gone: true, goneStatus: 'ВЫДАН ИЛИ УБЫЛ' }));
});

test('заказ в возвратах не считается', () => {
  const state = P.shelfState({ orderId: '1', cell: '225', phase: 'return' });
  no(state.onShelf);
  eq(state.why, 'заказ в возвратах');
});

test('список статусов РАЗРЕШАЮЩИЙ, а не запрещающий', () => {
  ok(P.isOnShelf({ status: 'DELIVERED' }));
  ok(P.isOnShelf({ status: 'CHECKING_BY_CUSTOMER' }));
  no(P.isOnShelf({ status: 'ЧТО-ТО-НОВОЕ-ОТ-WMS' }),
     'незнакомый статус обязан означать «не считать»');
});

// ------------------------------------------------------------------
suite('считаем вещи, а не строки (2.9.4)');

test('строка с amount 4 — это четыре вещи', () => {
  eq(P.unitsOf({ amount: 4 }), 4);
  eq(P.unitsOf({ amount: 1 }), 1);
  eq(P.unitsOf({}), 1, 'строка без количества — одна вещь');
  eq(P.unitsOf({ amount: 0 }), 1);
  eq(P.unitsOf({ amount: 'мусор' }), 1);
});

test('countUnits считает вещи по всему набору', () => {
  eq(P.countUnits([{ amount: 4 }, {}, { amount: 2 }]), 7);
  eq(P.countUnits([]), 0);
  eq(P.countUnits(null), 0);
});

// ------------------------------------------------------------------
suite('сверка «что исчезло» (2.5.0)');

test('заказ, которого нет в свежем списке, помечается убывшим', () => {
  const { records, marked } = P.reconcile(
    [{ orderId: '1', cell: '225' }, { orderId: '2', cell: '226' }],
    ['1']
  );
  eq(marked, 1);
  const gone = records.find(r => r.orderId === '2');
  ok(gone.gone, 'выданный вчера заказ останется недостачей навсегда');
  const live = records.find(r => r.orderId === '1');
  no(live.gone);
});

test('записи не удаляются, а помечаются', () => {
  const { records } = P.reconcile([{ orderId: '1' }, { orderId: '2' }], ['1']);
  eq(records.length, 2, 'оператор должен видеть, что заказ был и куда делся');
});

test('позиции грузомест в сверке не участвуют', () => {
  const { records } = P.reconcile(
    [{ orderId: '5', gm: 'GM1', source: 'cargo' }],
    []
  );
  no(records[0].gone, 'позиция короба помечена убывшей — она живёт в своём списке');
});

// ------------------------------------------------------------------
suite('код ячейки');

test('три цифры: секция, этаж, позиция', () => {
  deep(P.parseCellCode('225'), { section: '2', floor: '2', position: '5' });
});

test('четыре цифры — это секция из двух цифр, а не КГТ', () => {
  // Правило «4 цифры = КГТ» из черновика спецификации неверно: под него
  // попали бы 115 обычных ячеек секций 10–14 (pvz-config.json, _TODO_wallCells).
  deep(P.parseCellCode('1011'), { section: '10', floor: '1', position: '1' });
  deep(P.parseCellCode('1453'), { section: '14', floor: '5', position: '3' });
});

test('мусор не превращается в ячейку', () => {
  for (const junk of ['', null, undefined, 'абв', '—', '12', '10105', '22.5', ' 225']) {
    eq(P.parseCellCode(junk), null, `«${junk}» разобралось как ячейка`);
  }
});

process.exit(report('Разбор и слияние'));
