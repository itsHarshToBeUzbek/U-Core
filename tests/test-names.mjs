// Словарь названий, разбор количества и цвета, проверка чужого перевода.
//
// Примеры взяты из живого среза ТАШ-120 — те же, что в CHANGELOG 2.15.0.
// Выдумывать названия для тестов нельзя: словарь по выдуманным и пройдёт.

import { loadClassic, suite, test, eq, ok, no, report } from './harness.mjs';

loadClassic('sku-name.js');
const S = globalThis.UCoreSkuName;

// ------------------------------------------------------------------
suite('главное слово стоит в конце');

test('«Idish yuvish uchun gel» — это гель, а не идиш', () => {
  const short = S.shortName('Idish yuvish uchun gel Fairy limon 900 ml').text.toLowerCase();
  ok(short.includes('гель'), `вышло «${short}»`);
  no(short.includes('идиш'), `вышло «${short}»`);
});

test('выигрывает самое длинное совпадение, иначе «sumka» перебьёт «ryukzagi»', () => {
  const short = S.shortName('Maktab ryukzagi qizlar uchun (Rang: Pushti)').text.toLowerCase();
  ok(short.includes('рюкзак'), `вышло «${short}»`);
});

// ------------------------------------------------------------------
suite('апострофы узбекской латиницы');

test('пять разных знаков читаются как один', () => {
  // U+2018, U+02BB, U+2019, U+00B4 и обычный — один товар приезжает то с
  // одним, то с другим, и в словаре не находился он же.
  const results = ["cho'milish", 'cho‘milish', 'choʻmilish',
                   'cho’milish', 'cho´milish']
    .map(v => S.norm(`Bolalar ${v} uchun gel 500 ml`));
  const first = results[0];
  for (const value of results) eq(value, first, 'апостроф развёл одно и то же название');
});

// ------------------------------------------------------------------
suite('количество');

test('граммы, килограммы, литры, штуки', () => {
  ok(S.quantity('Sovun 140 g'), 'граммы не разобрались');
  ok(S.quantity('Guruch 5 kg'), 'килограммы не разобрались');
  ok(S.quantity('Suv 1.5 L'), 'литры не разобрались');
});

test('количества нет — и не выдумывается', () => {
  eq(S.quantity('Simsiz quloqchin JBL Tune 510BT'), null);
});

// ------------------------------------------------------------------
suite('цвет согласуется с родом');

test('«Мыло, синий» сразу выдаёт машину', () => {
  const short = S.shortName('Bolalar atir sovuni Oila Tanlovi, 140 g (Rang: Moviy)').text;
  no(/\bсиний\b/i.test(short), `вышло «${short}» — род не согласован`);
});

test('после к, г, х, ш, ж, ч, щ окончание «ий», иначе «ый»', () => {
  const backpack = S.shortName('Maktab ryukzagi (Rang: Oq)').text;
  no(/школьний|белий/i.test(backpack), `вышло «${backpack}»`);
});

// ------------------------------------------------------------------
suite('незнакомое остаётся как было');

test('показать оригинал честнее, чем угадать', () => {
  const odd = 'Zzzqqq vvv xyzzy 12345';
  const short = S.shortName(odd);
  eq(short.text, odd, 'выдумали перевод для незнакомого названия');
  no(short.known, 'незнакомое название объявлено узнанным');
});

// ------------------------------------------------------------------
suite('проверка чужого перевода');

const orig = 'Bolalar atir sovuni Oila Tanlovi, 140 g (Rang: Moviy)';

test('хороший перевод проходит', () => {
  const v = S.checkTranslation(orig, 'мыло парфюмированное детское, 140 г, голубое');
  ok(v.ok, v.why);
  eq(v.text.charAt(0), 'М', 'первая буква не поднята');
});

test('придуманное число не проходит', () => {
  const v = S.checkTranslation(orig, 'Мыло детское, 500 г');
  no(v.ok);
  ok(/придумано число/.test(v.why), v.why);
});

test('придуманная марка не проходит', () => {
  const v = S.checkTranslation(orig, 'Мыло детское Nivea');
  no(v.ok);
  ok(/придумано слово/.test(v.why), v.why);
});

test('ответ не по-русски не проходит', () => {
  const v = S.checkTranslation(orig, 'Baby perfumed soap');
  no(v.ok);
  ok(/не по-русски/.test(v.why), v.why);
});

test('эхо вопроса не проходит', () => {
  const v = S.checkTranslation(orig, orig);
  no(v.ok, 'модель вернула вопрос, и это засчитали переводом');
});

test('рассуждение модели не проходит', () => {
  for (const answer of ['<think>сейчас переведу</think> Мыло детское',
                        'Перевод: Мыло детское']) {
    const v = S.checkTranslation(orig, answer);
    no(v.ok, `«${answer}» прошло как перевод`);
  }
});

test('пустой ответ не проходит', () => {
  for (const answer of ['', '   ', null, undefined]) {
    no(S.checkTranslation(orig, answer).ok, `«${answer}» прошло как перевод`);
  }
});

test('слишком длинный ответ не проходит', () => {
  const long = 'Мыло ' + 'очень '.repeat(40) + 'детское';
  const v = S.checkTranslation(orig, long);
  no(v.ok);
  ok(/длиннее/.test(v.why), v.why);
});

test('абзац сводится к первой строке', () => {
  const v = S.checkTranslation(orig, 'Мыло детское, 140 г\nЭто детское мыло для купания.');
  ok(v.ok, v.why);
  no(v.text.includes('купания'), `вышло «${v.text}»`);
});

test('кавычки и точка в конце — оформление, а не название', () => {
  const v = S.checkTranslation(orig, '«Мыло детское, 140 г».');
  ok(v.ok, v.why);
  no(/[«»"]/.test(v.text), `вышло «${v.text}»`);
});

// ------------------------------------------------------------------
suite('отпечаток исходного названия');

test('продавец переименовал товар — старый перевод забывается', () => {
  const a = S.srcKey('Bolalar atir sovuni, 140 g');
  const b = S.srcKey('Bolalar atir sovuni, 140 g');
  const c = S.srcKey('Bolalar atir sovuni, 250 g');
  eq(a, b, 'одно и то же название дало разные отпечатки');
  ok(a !== c, 'переименованный товар сохранил чужой перевод');
});

// ------------------------------------------------------------------
suite('вес');

test('вес берётся из названия, где продавец его написал', () => {
  const w = S.weightKg(null, 'Guruch Lazer 5 kg');
  ok(w && w.kg >= 4.5 && w.kg <= 5.5, `вышло ${JSON.stringify(w)}`);
  ok(w.exact, 'вес из названия помечен оценкой');
});

test('оценка помечается, чтобы её не приняли за факт', () => {
  eq(S.weightText({ kg: 1.2, exact: false }), '~1.2 кг');
  eq(S.weightText({ kg: 1.2, exact: true }), '1.2 кг', 'точный вес помечен как оценка');
  eq(S.weightText({ kg: null }), '', 'нечем считать — а что-то написали');
});

process.exit(report('Словарь названий'));
