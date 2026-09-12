// Перевод названий моделью: адрес, ключ, разбор ответа, раскладка пачки,
// очередь.
//
// Транспорт проверяется против НАСТОЯЩЕГО http-сервера на 127.0.0.1, а не
// против заглушки: заглушка доказала бы только то, что она вызывается.
// Именно на живом сервере нашлось, что ключ с русской буквой заставляет
// браузер отказаться собрать запрос, а наружу это выходит как «не удалось
// соединиться».

import http from 'node:http';
import { loadClassic, suite, test, eq, ok, no, deep, report } from './harness.mjs';

loadClassic('sku-name.js');
const S = globalThis.UCoreSkuName;
const L = await import('../name-llm.js');

// ------------------------------------------------------------------
suite('адрес модели -> шаблон прав');

test('ПОРТА В ШАБЛОНЕ НЕТ (2.16.1)', () => {
  // Было `new URL(base).origin`, и у местной модели выходило
  // `http://localhost:11434/*`. В манифесте стоит `http://localhost/*`,
  // такого шаблона Chrome не находил — право не давалось никогда.
  eq(L.originOf('http://localhost:11434/v1'), 'http://localhost/*');
  eq(L.originOf('http://127.0.0.1:1234/v1'), 'http://127.0.0.1/*');
});

test('у обычных сервисов порта и не было', () => {
  eq(L.originOf('https://api.openai.com/v1'), 'https://api.openai.com/*');
  eq(L.originOf('https://api.deepseek.com/v1'), 'https://api.deepseek.com/*');
  eq(L.originOf('https://openrouter.ai/api/v1'), 'https://openrouter.ai/*');
  eq(L.originOf('https://generativelanguage.googleapis.com/v1beta/openai'),
     'https://generativelanguage.googleapis.com/*');
});

test('каждый шаблон покрыт манифестом', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('./harness.mjs');
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const declared = new Set(manifest.optional_host_permissions || []);
  for (const [name, provider] of Object.entries(L.PROVIDERS)) {
    ok(declared.has(L.originOf(provider.base)),
       `${name}: ${L.originOf(provider.base)} не объявлен в optional_host_permissions`);
  }
});

test('мусор вместо адреса не превращается в шаблон', () => {
  for (const junk of ['', null, 'не адрес', 'localhost:11434']) {
    eq(L.originOf(junk), null, `«${junk}» разобралось как адрес`);
  }
});

// ------------------------------------------------------------------
suite('ключ');

test('обычный ключ годится', () => {
  eq(L.keyProblem('sk-abc123DEF_-.456'), null);
  eq(L.keyProblem(''), null, 'пустой ключ — это не ошибка, а «ключа ещё нет»');
});

test('русская буква внутри ключа названа прямо', () => {
  ok(L.keyProblem('sk-abс123'), 'ключ с кириллической «с» прошёл как годный');
});

test('перевод строки и пробелы по краям названы прямо', () => {
  ok(/пробел|лишн/.test(L.keyProblem('sk-abc123\n') || ''));
  ok(/пробел|лишн/.test(L.keyProblem(' sk-abc123') || ''));
  ok(/пробел/.test(L.keyProblem('sk-abc 123') || ''));
});

// ------------------------------------------------------------------
suite('разбор ответа');

test('чистый JSON', () => {
  const items = L.parseItems('{"items":[{"i":1,"o":"Bolalar atir","t":"Мыло детское"}]}');
  eq(items.length, 1);
  eq(items[0].t, 'Мыло детское');
});

test('ответ в ```json — не повод выбрасывать оплаченную работу', () => {
  const items = L.parseItems('```json\n{"items":[{"i":1,"o":"a b","t":"в"}]}\n```');
  ok(items && items.length === 1, 'обёртка выбросила ответ целиком');
});

test('болтовня перед JSON', () => {
  const items = L.parseItems('Конечно! Вот результат: {"items":[{"i":1,"o":"a b","t":"в"}]}');
  ok(items && items.length === 1);
});

test('голый массив тоже читается', () => {
  const items = L.parseItems('[{"i":1,"o":"a b","t":"в"}]');
  ok(items && items.length === 1);
});

test('не JSON — честный null, а не пустой список', () => {
  for (const junk of ['', 'извините, не могу', '{сломано', null]) {
    eq(L.parseItems(junk), null, `«${junk}» разобралось`);
  }
});

// ------------------------------------------------------------------
suite('раскладка пачки: тому ли товару достался ответ');

const NAMES = [
  'Bolalar atir sovuni Oila Tanlovi, 140 g (Rang: Moviy)',
  'Idish yuvish uchun gel Fairy limon 900 ml',
  'Maktab ryukzagi qizlar uchun (Rang: Pushti)'
];
const align = (items) => L.alignBatch(items, NAMES, { checkTranslation: S.checkTranslation });

test('честный ответ раскладывается по своим местам', () => {
  const { texts, problems } = align([
    { i: 1, o: L.echoOf(NAMES[0]), t: 'Мыло детское, 140 г' },
    { i: 2, o: L.echoOf(NAMES[1]), t: 'Гель для мытья посуды Fairy, 900 мл' },
    { i: 3, o: L.echoOf(NAMES[2]), t: 'Рюкзак школьный' }
  ]);
  eq(problems.length, 0, JSON.stringify(problems));
  for (const text of texts) ok(text, 'ответ потерялся');
});

test('СДВИГ НА ЕДИНИЦУ ЛОВИТСЯ — иначе перевод встаёт к чужому товару', () => {
  // Самая опасная ошибка пачки: название читается нормально, просто не про
  // этот товар. Глазами такое не видно.
  const { texts, problems } = align([
    { i: 1, o: L.echoOf(NAMES[1]), t: 'Гель для мытья посуды Fairy, 900 мл' },
    { i: 2, o: L.echoOf(NAMES[2]), t: 'Рюкзак школьный' }
  ]);
  eq(texts[0], null, 'чужой перевод встал к первому товару');
  eq(texts[1], null, 'чужой перевод встал ко второму товару');
  ok(problems.some(p => p.why === 'ответ не про этот товар'), JSON.stringify(problems));
});

test('ответ без поля o не принимается', () => {
  const { texts } = align([{ i: 1, t: 'Мыло детское, 140 г' }]);
  eq(texts[0], null, 'номеру от модели поверили без подтверждения');
});

test('номер вне пачки не роняет остальное', () => {
  const { texts, problems } = align([
    { i: 99, o: 'что-то', t: 'Ерунда' },
    { i: 1, o: L.echoOf(NAMES[0]), t: 'Мыло детское, 140 г' }
  ]);
  ok(texts[0], 'здоровый ответ потерялся из-за соседнего мусора');
  ok(problems.some(p => p.why === 'номер вне пачки'));
});

test('модель вернула меньше ответов — недостающие остаются в очереди', () => {
  const { texts } = align([{ i: 1, o: L.echoOf(NAMES[0]), t: 'Мыло детское, 140 г' }]);
  ok(texts[0]);
  eq(texts[1], null);
  eq(texts[2], null);
});

test('выдумка в переводе отсеивается и названа своим именем', () => {
  const { texts, problems } = align([
    { i: 1, o: L.echoOf(NAMES[0]), t: 'Мыло детское, 500 г' }
  ]);
  eq(texts[0], null);
  ok(/придумано число/.test(problems[0].why), problems[0].why);
});

test('пустой список ответов не роняет раскладку', () => {
  const { texts, problems } = align([]);
  eq(texts.length, NAMES.length);
  eq(problems.length, 0);
  for (const text of texts) eq(text, null);
});

// ------------------------------------------------------------------
suite('транспорт против настоящего сервера');

let server;
let port;
const calls = [];
let reply = () => ({ status: 200, body: { choices: [{ message: { content: '{"items":[]}' } }] } });

await new Promise((resolve) => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ url: req.url, headers: req.headers, body });
      const answer = reply(req, body);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
    });
  }).listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
});

const BASE = () => `http://127.0.0.1:${port}/v1`;
const settings = () => ({ ...L.DEFAULTS, base: BASE(), model: 'test', batch: 2, gapMs: 0, timeoutMs: 4000 });
const items = (n) => Array.from({ length: n }, (_, i) => ({
  barcode: `BC${i}`, name: NAMES[i % NAMES.length]
}));
const run = (opts) => L.translateAll({
  items: opts.items, settings: settings(), key: 'sk-test', cache: {},
  checkTranslation: S.checkTranslation, srcKey: S.srcKey,
  onProgress: opts.onProgress, signal: opts.signal
});

const answerFor = (names, from = 0) => ({
  status: 200,
  body: { choices: [{ message: { content: JSON.stringify({
    items: names.map((n, i) => ({ i: i + 1, o: L.echoOf(n), t: `Товар ${from + i}` }))
  }) } }] }
});

test('ключ уходит заголовком Authorization и только им', async () => {
  calls.length = 0;
  reply = () => answerFor([NAMES[0]]);
  await run({ items: items(1) });
  eq(calls.length, 1);
  eq(calls[0].headers.authorization, 'Bearer sk-test');
  no(calls[0].body.includes('sk-test'), 'ключ уехал в теле запроса — он осядет в журналах сервиса');
});

test('наружу уходят ТОЛЬКО названия', async () => {
  calls.length = 0;
  reply = () => answerFor([NAMES[0]]);
  await L.translateAll({
    items: [{ barcode: 'BC1', name: NAMES[0], cell: '225', orderId: '122575788',
              clientName: 'Иванов', phone: '998901112233' }],
    settings: settings(), key: 'sk-test', cache: {},
    checkTranslation: S.checkTranslation, srcKey: S.srcKey
  });
  const sent = calls[0].body;
  ok(sent.includes('Bolalar'), 'название не отправилось вовсе');
  for (const secret of ['225', '122575788', 'Иванов', '998901112233']) {
    no(sent.includes(secret), `наружу уехало «${secret}»`);
  }
});

test('пачка — это один запрос на несколько названий', async () => {
  calls.length = 0;
  reply = (req, body) => {
    const asked = (JSON.parse(body).messages.at(-1).content.match(/^\d+\. /gm) || []).length;
    return answerFor(NAMES.slice(0, asked));
  };
  const { report: r } = await run({ items: items(4) });
  eq(r.requests, 2, 'четыре названия при пачке в два — должно быть два запроса');
});

test('перевод запоминается по штрихкоду с отпечатком названия', async () => {
  reply = () => answerFor([NAMES[0]]);
  const { cache } = await run({ items: [{ barcode: 'BC7', name: NAMES[0] }] });
  ok(cache.BC7, 'перевод не сохранился');
  eq(cache.BC7.by, 'модель');
  eq(cache.BC7.src, S.srcKey(NAMES[0]), 'без отпечатка переименованный товар сохранит чужой перевод');
});

test('неверный ключ останавливает очередь с ПЕРВОГО раза', async () => {
  calls.length = 0;
  reply = () => ({ status: 401, body: { error: 'bad key' } });
  const { report: r } = await run({ items: items(20) });
  eq(r.requests, 1, 'долбили сервис ещё двадцатью запросами при отозванном ключе');
  ok(/ключ/.test(r.error || ''), r.error);
});

test('три отказа подряд — и очередь встаёт', async () => {
  calls.length = 0;
  reply = () => ({ status: 500, body: { error: 'упал' } });
  const { report: r } = await run({ items: items(20) });
  eq(r.requests, 3, 'пятьсот строк «сервис ответил 500» вместо одной внятной причины');
  ok(r.error, 'очередь встала молча');
});

test('429 не выдаёт себя за поломку ключа', async () => {
  reply = () => ({ status: 429, body: { error: 'slow down' } });
  const { report: r } = await run({ items: items(2) });
  ok(/часто|подожд/.test(r.error || ''), r.error);
});

test('неразобранная пачка делится пополам до одного товара', async () => {
  calls.length = 0;
  let seen = 0;
  reply = (req, body) => {
    const asked = (JSON.parse(body).messages.at(-1).content.match(/^\d+\. /gm) || []).length;
    seen++;
    // Первая пачка из двух не разбирается, половинки по одному — отвечают.
    if (asked > 1) return { status: 200, body: { choices: [{ message: { content: 'извините' } }] } };
    return answerFor([NAMES[0]]);
  };
  const { report: r } = await run({ items: items(2) });
  ok(r.requests >= 3, `делений не было: ${r.requests} запроса`);
  eq(r.ok, 2, 'из-за одной неразобранной пачки потеряли готовые переводы');
});

test('остановка по кнопке прекращает очередь', async () => {
  calls.length = 0;
  const ac = new AbortController();
  reply = () => { ac.abort(); return answerFor([NAMES[0]]); };
  await run({ items: items(20), signal: ac.signal });
  ok(calls.length <= 2, `после остановки ушло ${calls.length} запросов`);
});

test('onProgress зовётся после каждой пачки — иначе работа пропадёт с вкладкой', async () => {
  reply = (req, body) => {
    const asked = (JSON.parse(body).messages.at(-1).content.match(/^\d+\. /gm) || []).length;
    return answerFor(NAMES.slice(0, asked));
  };
  const seen = [];
  await run({ items: items(4), onProgress: (r) => { seen.push(r.done); } });
  ok(seen.length >= 2, `onProgress позвали ${seen.length} раз`);
});

test('ключ с русской буквой не выдаёт себя за обрыв связи', async () => {
  reply = () => answerFor([NAMES[0]]);
  const { report: r } = await L.translateAll({
    items: items(1), settings: settings(), key: 'sk-abс123', cache: {},
    checkTranslation: S.checkTranslation, srcKey: S.srcKey
  });
  ok(r.error, 'запрос с негодным ключом прошёл');
  no(/соединиться/.test(r.error), `сказали про сеть вместо ключа: ${r.error}`);
});

test('сервиса нет на этом адресе — говорим про адрес, а не про формат', async () => {
  const dead = { ...settings(), base: 'http://127.0.0.1:1/v1' };
  const { report: r } = await L.translateAll({
    items: items(1), settings: dead, key: 'sk-test', cache: {},
    checkTranslation: S.checkTranslation, srcKey: S.srcKey
  });
  ok(/соединиться|адрес/.test(r.error || ''), r.error);
});

server.close();
process.exit(report('Перевод моделью'));
