// ==========================================
// sku-name.js — человеческое имя товара и его вес
// ==========================================
// Классический скрипт (не модуль): подключается и в попапе, и на страницах
// расширения, и в content-скрипте размещения — везде через
// globalThis.UCoreSkuName.
//
// ЧТО ТУТ РЕШАЕТСЯ.
//
// WMS отдаёт название так, как его завёл продавец: по-узбекски, со всеми
// ключевыми словами для поиска на витрине и с атрибутами в скобках. Средняя
// длина на живом срезе ТАШ-120 — 75 знаков, длиннее сорока 50 названий из 55:
//
//   Bolalar atir sovuni Oila Tanlovi, 140 g (Rang: Moviy)
//
// Оператору у стеллажа нужно другое: что это за вещь, сколько её и какого
// она цвета — чтобы отличить две одинаковые позиции в одной ячейке:
//
//   Мыло детское, 140 г, синее
//
// ГЛАВНОЕ СЛОВО В УЗБЕКСКОМ СТОИТ В КОНЦЕ. «Idish yuvish uchun gel» — это
// гель (для мытья посуды), а не «идиш». Поэтому название не режется по
// первому слову: мы ищем в нём знакомое ГЛАВНОЕ СЛОВО, и самое длинное
// совпадение выигрывает — «kir yuvish vositasi» важнее, чем просто «vosita».
//
// ЧЕГО ЗДЕСЬ ХВАТИТ НЕ НАВСЕГДА. Словарь знает 62 главных слова. Продавцы
// заводят товары какие хотят, и список того, что может приехать на ПВЗ, не
// закрыт: сколько слов сюда ни добавь, завтра приедет 63-е. Считать этот
// словарь достаточным мешает ещё и то, как он мерился: 54 узнанных названия
// из 55 получены на тех же названиях, по которым он и составлялся. На новой
// поставке будет хуже, и насколько — пока неизвестно.
//
// Поэтому перевод вынесен из этого файла наружу, в name-llm.js, а словарь
// остался тем, что работает всегда: без сети, без ключа, без настройки.
// Здесь же лежит проверка чужого ответа — checkTranslation.

(function (root) {
  'use strict';

  // ---------- нормализация ----------
  // Апострофы в узбекской латинице пишут четырьмя разными знаками, и один и
  // тот же товар приезжает то с ʻ, то с ‘, то с '. Для поиска по словарю
  // приводим всё к одному виду.
  // Апострофов в узбекской латинице пять разных знаков, и один товар
  // приезжает то с U+2018, то с U+02BB, то с обычным '. Перечисляем коды
  // явно: набранные «как выглядит» они уже один раз разъехались, и
  // «cho\u2018milish» не нашёлся в словаре, где лежал «cho'milish».
  const APOS = /[\u0027\u2018\u2019\u02BB\u02BC\u0060\u00B4]/g;

  function norm(text) {
    return String(text || '')
      .replace(APOS, "'")
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  const CYRILLIC = /[а-яёА-ЯЁ]/;
  const LATIN = /[a-zA-Z]/;

  /** Название уже по-русски: переводить нечего, надо только подрезать. */
  function isRussian(text) {
    const letters = String(text || '').match(/[а-яёa-z]/gi) || [];
    if (!letters.length) return false;
    const cyr = letters.filter(ch => CYRILLIC.test(ch)).length;
    return cyr / letters.length > 0.6;
  }

  /**
   * Русское название: убираем бренд латиницей и всё после первой запятой —
   * это витрина, оператору на полке она не нужна.
   *
   * Бренды кириллицей («Южная корона») НЕ трогаем. Попытка вычислить их по
   * заглавной букве превращала «Спагетти Южная корона» в «Корона»: слово с
   * заглавной не в начале — это чаще бренд, но иногда и сам товар, а
   * различить их отсюда нечем. Длинная строка дешевле, чем не тот товар.
   *
   * Слова считаем латиницей по большинству букв: в живых данных попадается
   * «Cпагетти» с латинской C в начале, и посимвольная проверка выбрасывала
   * само название.
   */
  function isLatinWord(word) {
    const letters = String(word).match(/[a-zа-яё]/gi) || [];
    if (!letters.length) return false;
    return letters.filter(ch => LATIN.test(ch)).length / letters.length > 0.5;
  }

  function trimRussian(text) {
    const head = String(text || '').split(',')[0].replace(/\([^)]*\)/g, ' ').trim();
    const words = head.split(/\s+/).filter(Boolean);
    const kept = words.filter(w => !isLatinWord(w));
    const out = (kept.length ? kept : words).join(' ').replace(/\s+-\s+/g, '-').trim();
    return out.charAt(0).toUpperCase() + out.slice(1);
  }

  // ---------- цвета ----------
  // По роду: мужской, женский, средний, множественное. Без согласования
  // получается «мыло детское, синий» — сразу видно, что писала не рука.
  const COLORS = [
    ["qora", ['чёрный', 'чёрная', 'чёрное', 'чёрные']],
    ["oq", ['белый', 'белая', 'белое', 'белые']],
    ["ko'k", ['синий', 'синяя', 'синее', 'синие']],
    ["moviy", ['голубой', 'голубая', 'голубое', 'голубые']],
    ["qizil", ['красный', 'красная', 'красное', 'красные']],
    ["yashil xaki", ['хаки', 'хаки', 'хаки', 'хаки']],
    ["yashil", ['зелёный', 'зелёная', 'зелёное', 'зелёные']],
    ["sariq", ['жёлтый', 'жёлтая', 'жёлтое', 'жёлтые']],
    ["pushti", ['розовый', 'розовая', 'розовое', 'розовые']],
    ["kulrang melanj", ['серый меланж', 'серый меланж', 'серый меланж', 'серый меланж']],
    ["kulrang", ['серый', 'серая', 'серое', 'серые']],
    ["och-jigarrang", ['светло-коричневый', 'светло-коричневая', 'светло-коричневое', 'светло-коричневые']],
    ["jigarrang", ['коричневый', 'коричневая', 'коричневое', 'коричневые']],
    ["sarg'ish", ['бежевый', 'бежевая', 'бежевое', 'бежевые']],
    ["shaffof", ['прозрачный', 'прозрачная', 'прозрачное', 'прозрачные']],
    ["binafsha", ['фиолетовый', 'фиолетовая', 'фиолетовое', 'фиолетовые']],
    ["lavanda", ['лавандовый', 'лавандовая', 'лавандовое', 'лавандовые']],
    ["fuksiya", ['фуксия', 'фуксия', 'фуксия', 'фуксия']],
    ["indigo", ['индиго', 'индиго', 'индиго', 'индиго']],
    ["oltin", ['золотой', 'золотая', 'золотое', 'золотые']],
    ["kumush", ['серебряный', 'серебряная', 'серебряное', 'серебряные']],
    ["to'q ko'k", ['тёмно-синий', 'тёмно-синяя', 'тёмно-синее', 'тёмно-синие']]
  ];

  const GENDER = { m: 0, f: 1, n: 2, p: 3 };

  // ---------- главные слова ----------
  // [что искать, как называть по-русски, род, плотность для оценки веса].
  // Порядок не важен: выигрывает САМОЕ ДЛИННОЕ совпадение, иначе «sumka»
  // перебила бы «maktab ryukzagi».
  //
  // Плотность — кг/м³ упаковки целиком, а не вещества. Ткань лежит рыхло,
  // жидкость в бутылке почти вода, подгузники — воздух в пакете.
  const D = { liquid: 950, dense: 500, plastic: 250, textile: 180,
              fluffy: 90, electronics: 350, paper: 600, small: 400, mixed: 250 };

  const HEADS = [
    // бытовая химия
    ["kir yuvish vositasi", 'Средство для стирки', 'n', D.liquid],
    ["kiyimlarni yuvish uchun gel", 'Гель для стирки', 'm', D.liquid],
    ["idish yuvish uchun gel", 'Гель для посуды', 'm', D.liquid],
    ["idish yuvish vositasi", 'Средство для посуды', 'n', D.liquid],
    ["tozalash uchun vosita", 'Средство для уборки', 'n', D.liquid],
    ["xo'jalik sovuni", 'Мыло хозяйственное', 'n', D.dense],
    ["atir sovuni", 'Мыло парфюмированное', 'n', D.dense],
    ["hojatxona sovuni", 'Мыло туалетное', 'n', D.dense],
    ["sovun", 'Мыло', 'n', D.dense],
    ["nam salfetkalar", 'Салфетки влажные', 'p', D.dense],
    ["sochiq-lattalar", 'Салфетки-тряпки', 'p', D.textile],
    ["tagliklar", 'Подгузники', 'p', D.fluffy],
    // косметика и уход
    ["dush geli", 'Гель для душа', 'm', D.liquid],
    ["bolalar kremi", 'Крем детский', 'm', D.dense],
    ["krem", 'Крем', 'm', D.dense],
    ["makiyaj ost asos", 'База под макияж', 'f', D.dense],
    ["tishlarni oqartirish uchun tasmalar", 'Полоски для отбеливания зубов', 'p', D.small],
    ["dezodorant", 'Дезодорант', 'm', D.liquid],
    ["tosh va marvarid", 'Стразы', 'p', D.small],
    ["tosh va marvvarid", 'Стразы', 'p', D.small],
    // продукты
    ["oziq-ovqat rang beruvchi", 'Краситель пищевой', 'm', D.liquid],
    ["oziqaviy rang beruvchi", 'Краситель пищевой', 'm', D.liquid],
    // одежда и текстиль
    ["cho'milish kiyimi", 'Купальник', 'm', D.textile],
    ["kupalnik", 'Купальник', 'm', D.textile],
    ["kolgotkalar", 'Колготки', 'p', D.textile],
    ["paypoqlar", 'Носки', 'p', D.textile],
    ["futbolkasi", 'Футболка', 'f', D.textile],
    ["futbolka", 'Футболка', 'f', D.textile],
    ["jinsi shimlar", 'Джинсы', 'p', D.textile],
    ["maktab shimi", 'Брюки школьные', 'p', D.textile],
    ["shimlar", 'Брюки', 'p', D.textile],
    ["sport topi", 'Топ спортивный', 'm', D.textile],
    ["topik", 'Топ', 'm', D.textile],
    ["fartuk", 'Фартук', 'm', D.textile],
    ["mikrofibra", 'Микрофибра', 'f', D.textile],
    // сумки
    ["maktab ryukzagi", 'Рюкзак школьный', 'm', D.textile],
    ["ryukzak", 'Рюкзак', 'm', D.textile],
    ["yelka sumkasi", 'Сумка через плечо', 'f', D.textile],
    ["tout sumkasi", 'Сумка-шоппер', 'f', D.textile],
    ["ayollar sumkasi", 'Сумка женская', 'f', D.textile],
    ["barsetka", 'Барсетка', 'f', D.textile],
    ["sumka", 'Сумка', 'f', D.textile],
    // дом и хранение
    ["salat idishlari to'plami", 'Набор контейнеров', 'm', D.plastic],
    ["devorga organayzer", 'Органайзер настенный', 'm', D.plastic],
    ["organayzer", 'Органайзер', 'm', D.plastic],
    ["kiyim ilgich", 'Вешалка-стойка', 'f', D.fluffy],
    ["ilgak", 'Крючок', 'm', D.plastic],
    ["veshalka", 'Вешалка', 'f', D.plastic],
    ["plastik jild", 'Папка пластиковая', 'f', D.plastic],
    // электроника
    ["soch dazmoli", 'Выпрямитель для волос', 'm', D.electronics],
    ["audio kabeli", 'Аудиокабель', 'm', D.electronics],
    ["kabel", 'Кабель', 'm', D.electronics],
    // прочее
    ["sakrash arqoni", 'Скакалка', 'f', D.dense],
    ["quyosh ko'zoynaklari", 'Очки солнцезащитные', 'p', D.small],
    ["ko'zoynaklari", 'Очки', 'p', D.small],
    ["o'yinchoq", 'Игрушка-антистресс', 'f', D.fluffy],
    ["skvish", 'Игрушка-антистресс', 'f', D.fluffy],
    ["o'chirgich", 'Ластик', 'm', D.small],
    ["gelli ruchka", 'Ручка гелевая', 'f', D.small],
    ["ruchka", 'Ручка', 'f', D.small],
    ["qalamlar", 'Карандаши', 'p', D.small],
    ["psixologiya", 'Книга по психологии', 'f', D.paper]
  ];

  // Уточнения перед главным словом: их берём, только если они реально
  // стоят в названии. «Мыло» и «Мыло детское» — разные строки на полке.
  // Порядок = старшинство: берём ОДНО уточнение, самое говорящее. Два
  // подряд («рюкзак школьный детский для девочек») читаются хуже, чем одно.
  const MODS = [
    ["bolalar", 'детск'], ["ayollar", 'женск'], ["erkaklar", 'мужск'],
    ["maktab", 'школьн'], ["sport", 'спортивн'], ["oshxona", 'кухонн'],
    ["universal", 'универсальн']
  ];

  /**
   * Окончание прилагательного по основе. После к, г, х, ш, ж, ч, щ пишется
   * «ий», в остальных случаях «ый»: «детский», но «школьный». Без этого
   * правила получалось «школьний» — слово, которого нет.
   */
  function ending(stem, gender) {
    const last = stem.slice(-1);
    const soft = 'кгхшжчщ'.includes(last);
    const hush = 'шжчщ'.includes(last);
    if (gender === 'f') return 'ая';
    if (gender === 'n') return hush ? 'ее' : 'ое';
    if (gender === 'p') return soft ? 'ие' : 'ые';
    return soft ? 'ий' : 'ый';
  }

  // ---------- количество ----------
  const UNIT_RU = { kg: 'кг', g: 'г', l: 'л', ml: 'мл', dona: 'шт', ta: 'шт' };
  // Граница слова здесь НЕ \b: в JS кириллица не считается словом, и «30 мл»
  // в конце строки не находилось вовсе — русские названия теряли количество.
  const QTY_RE = /(\d+(?:[.,]\d+)?)\s*(kg|кг|gr|гр|g|г|l|л|ml|мл|dona|шт)(?![а-яёa-z])/i;

  /** Сколько товара: число и единица, приведённые к русскому написанию. */
  function quantity(name) {
    const m = QTY_RE.exec(String(name || ''));
    if (!m) return null;
    const value = Number(String(m[1]).replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) return null;
    const raw = m[2].toLowerCase();
    const unit = UNIT_RU[raw] || (raw === 'гр' ? 'г' : raw);
    return { value, unit, text: `${m[1].replace('.', ',')} ${unit}` };
  }

  /** Цвет из «(Rang: Moviy)» — в нужном роде. */
  function color(name, gender) {
    const inside = /\((?:[^)]*?)(?:rang|цвет)\s*:\s*([^,)]+)/i.exec(String(name || ''));
    const raw = inside ? norm(inside[1]) : null;
    if (!raw) return null;
    for (const [uz, forms] of COLORS) {
      if (raw === uz || raw.startsWith(uz + ' ') || raw.includes(uz)) {
        return forms[GENDER[gender] === undefined ? 0 : GENDER[gender]];
      }
    }
    return null;
  }

  /** Главное слово названия: самое длинное совпадение со словарём. */
  function head(name) {
    const text = norm(name);
    let best = null;
    for (const entry of HEADS) {
      if (!text.includes(entry[0])) continue;
      if (!best || entry[0].length > best[0].length) best = entry;
    }
    return best;
  }

  // Что уже сказано другим словом. «Школьный рюкзак детский» — правда, но
  // такая, которой никто не говорит: школьный и так про детей.
  const IMPLIES = { 'школьн': ['детск'] };

  /** Одно уточнение к главному слову — и только если оно там ещё не сказано. */
  function modifier(name, gender, headRu) {
    const text = norm(name);
    const already = norm(headRu);
    const covered = new Set();
    for (const [stem, list] of Object.entries(IMPLIES)) {
      if (already.includes(stem)) for (const x of list) covered.add(x);
    }
    for (const [uz, stem] of MODS) {
      if (!text.includes(uz)) continue;
      if (already.includes(stem) || covered.has(stem)) continue;
      return stem + ending(stem, gender);
    }
    return null;
  }

  /**
   * Короткое название: суть, количество, цвет.
   * Не узнали главное слово — возвращаем оригинал. Показать как есть
   * честнее, чем выдумать.
   */
  function shortName(name) {
    const source = String(name || '').trim();
    if (!source) return { text: '', known: false };

    // Уже по-русски — переводить нечего.
    if (isRussian(source)) {
      const q = quantity(source);
      const parts = [trimRussian(source)];
      if (q) parts.push(q.text);
      return { text: parts.join(', '), known: true, russian: true, quantity: q };
    }

    const found = head(source);
    if (!found) {
      const q = quantity(source);
      return { text: source, known: false, quantity: q };
    }

    const [, ru, gender, density] = found;
    const extra = modifier(source, gender, ru);
    const q = quantity(source);
    const c = color(source, gender);

    const parts = [extra ? `${ru} ${extra}` : ru];
    if (q && q.unit !== 'шт') parts.push(q.text);
    else if (q && q.unit === 'шт' && q.value > 1) parts.push(q.text);
    if (c) parts.push(c);

    return { text: parts.join(', '), known: true, quantity: q, color: c, density };
  }

  // ---------- вес ----------

  /**
   * СКОЛЬКО ЭТО ВЕСИТ. WMS веса не отдаёт вовсе — только габариты в
   * миллиметрах, и то не у всех.
   *
   * Сначала берём заявленное в названии: «5 kg», «700 g», «5 L» — это самый
   * честный источник, он написан продавцом. На живом срезе ТАШ-120 такой
   * вес есть у 23 позиций из 55.
   *
   * Остальное считаем по объёму и виду товара. Это ОЦЕНКА, и она помечена
   * как оценка: от неё нужна не точность до килограмма, а правильная полка —
   * лёгкое наверх, тяжёлое вниз.
   */
  function weightKg(sku, name) {
    const source = String(name || (sku && sku.name) || '');
    const q = quantity(source);
    if (q) {
      if (q.unit === 'кг') return { kg: q.value, exact: true, from: 'название' };
      if (q.unit === 'г') return { kg: q.value / 1000, exact: true, from: 'название' };
      // Литры считаем как килограммы: бытовая химия и вода отличаются
      // процентами, а полка от этого не меняется.
      if (q.unit === 'л') return { kg: q.value, exact: true, from: 'название' };
      if (q.unit === 'мл') return { kg: q.value / 1000, exact: true, from: 'название' };
    }

    const l = Number(sku && sku.length);
    const w = Number(sku && sku.width);
    const h = Number(sku && sku.height);
    if (![l, w, h].every(v => Number.isFinite(v) && v > 0)) {
      return { kg: null, exact: false, from: 'нечем считать' };
    }
    const found = head(source);
    const density = (found && found[3]) || D.mixed;
    const cubicMetres = (l * w * h) / 1e9;
    const kg = cubicMetres * density;
    return { kg: Math.round(kg * 100) / 100, exact: false, from: 'оценка по габаритам' };
  }

  /** Как показать вес человеку: точный без оговорок, оценку — с тильдой. */
  function weightText(weight) {
    if (!weight || weight.kg === null) return '';
    const kg = weight.kg;
    const text = kg >= 1 ? `${Math.round(kg * 10) / 10} кг` : `${Math.round(kg * 1000)} г`;
    return weight.exact ? text : `~${text}`;
  }

  // ---------- проверка чужого перевода ----------
  //
  // ЗАЧЕМ ЭТО ЗДЕСЬ. Словарь ниже знает 62 главных слова, а продавцы заводят
  // товары какие захотят: словарь всегда будет отставать. Поэтому название
  // может перевести языковая модель, запущенная на этом же компьютере.
  // Модель — не справочник: она отвечает уверенно и тогда, когда не знает.
  //
  // Вот чего проверка не должна пропустить:
  //     Salfetka nam 15 dona  ->  Салфетки влажные, 60 шт
  // Пятнадцать превратилось в шестьдесят, и выглядит это как знание. Числа
  // языковые модели путают охотнее всего — это их известное свойство, а не
  // случай с конкретной моделью. Ни одна здесь пока не запускалась: проверка
  // написана до первого запуска, потому что после него будет поздно.
  //
  // И она нужна тем более, что модель теперь отвечает не по одному названию,
  // а пачкой на двадцать пять. В пачке ошибается не только текст: модель
  // возвращает двадцать четыре ответа вместо двадцати пяти или сдвигает их
  // на один — и тогда правильный перевод встаёт к чужому товару. Сверку
  // порядка делает name-llm.js, а эту функцию проходит каждый ответ
  // по отдельности, как если бы его спросили одного.
  //
  // Поэтому её ответ проверяется, а не принимается на веру. Правила
  // построены на одном принципе: В ОТВЕТЕ НЕ ДОЛЖНО ПОЯВИТЬСЯ НИЧЕГО,
  // ЧЕГО НЕ БЫЛО В ИСХОДНОМ НАЗВАНИИ. Число, которого нет в оригинале, —
  // выдумка. Латинское слово, которого нет в оригинале, — выдуманный
  // бренд. Проверка ничего не чинит: не прошло — берём то, что даёт
  // словарь, и это честнее подделки.

  const LLM_MAX_CHARS = 70;

  // Следы «размышлений» и болтовни вокруг ответа.
  const LLM_JUNK = /(<think|```|перевод\s*:|translation|перевожу|as an ai|i cannot|извините)/i;

  function digitGroups(text) {
    return String(text || '').match(/\d+/g) || [];
  }

  function latinWords(text) {
    return (String(text || '').replace(APOS, "'").match(/[a-z][a-z'\-]*/gi) || [])
      .map(w => w.toLowerCase());
  }

  /**
   * Годится ли ответ модели вместо названия.
   * Возвращает { ok, text, why } — why нужен, чтобы в отчёте было видно,
   * ЧТО именно модель делает не так, а не просто «не получилось».
   */
  function checkTranslation(original, candidate) {
    const src = String(original || '');
    let text = String(candidate || '').trim();

    // Модель часто отвечает абзацем: берём первую непустую строку.
    text = (text.split(/\r?\n/).find(line => line.trim().length) || '').trim();
    // Кавычки и точка в конце — оформление, а не название.
    //
    // СНИМАЕМ ПО КРУГУ, пока снимается. Одного прохода не хватает: модель
    // отвечает «Мыло детское, 140 г». — кавычка стоит ПОД точкой, и порядок
    // «сначала кавычки, потом точка» оставлял кавычку висеть. На полке это
    // выглядело как «Мыло детское, 140 г»» — лишний знак в каждом втором
    // названии, и поди пойми, часть это названия или нет.
    let previous;
    do {
      previous = text;
      text = text.replace(/^["'«»\s]+|["'«»\s]+$/g, '').replace(/[.\s]+$/, '').trim();
    } while (text !== previous);
    text = text.replace(/\s+/g, ' ');

    if (!text) return { ok: false, text: '', why: 'пустой ответ' };
    if (LLM_JUNK.test(text)) return { ok: false, text, why: 'ответ с пояснениями' };
    if (text.length > LLM_MAX_CHARS) return { ok: false, text, why: `длиннее ${LLM_MAX_CHARS} знаков` };

    const letters = text.match(/[а-яёa-z]/gi) || [];
    if (!letters.length) return { ok: false, text, why: 'без букв' };
    const cyr = letters.filter(ch => CYRILLIC.test(ch)).length;
    if (cyr / letters.length < 0.5) return { ok: false, text, why: 'ответ не по-русски' };
    if (!/[а-яё]{3}/i.test(text)) return { ok: false, text, why: 'нет ни одного слова' };

    // Числа. Каждое число ответа должно стоять и в оригинале.
    const known = new Set(digitGroups(src));
    const invented = digitGroups(text).filter(d => !known.has(d));
    if (invented.length) return { ok: false, text, why: `придумано число ${invented[0]}` };

    // Латиница. Бренд может остаться как есть, но появиться из воздуха — нет.
    const inSrc = new Set(latinWords(src));
    const strange = latinWords(text).filter(w => w.length > 2 && !inSrc.has(w));
    if (strange.length) return { ok: false, text, why: `придумано слово «${strange[0]}»` };

    // Ответ = вопрос: модель не перевела, а вернула строку обратно.
    if (norm(text) === norm(src)) return { ok: false, text, why: 'название не изменилось' };

    // Заявленное количество вернём сами: модель его часто теряет, а оно
    // написано цифрами и читается точно.
    const q = quantity(src);
    if (q && !digitGroups(text).includes(String(q.value).replace('.', ''))
        && !text.includes(q.text)) {
      const qText = q.text;
      if ((text.length + qText.length + 2) <= LLM_MAX_CHARS) text = `${text}, ${qText}`;
    }

    text = text.charAt(0).toUpperCase() + text.slice(1);
    return { ok: true, text, why: '' };
  }

  /**
   * Отпечаток исходного названия. Нужен кэшу: если продавец переименовал
   * товар, старый перевод больше не про него и его надо забыть. Хэш
   * короткий и нестойкий к подбору — он и не должен быть стойким, это метка
   * «то же самое название или уже другое».
   */
  function srcKey(text) {
    const s = norm(text);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return `${s.length.toString(36)}${h.toString(36)}`;
  }

  /**
   * Что показать человеку: сохранённый перевод, если он про это же
   * название, иначе — то, что умеет словарь. Одна точка решения на всё
   * расширение, чтобы список приёмки и попап не разошлись.
   */
  function displayName(fullName, cached) {
    const full = String(fullName || '');
    if (!full) return { text: '', by: 'нет' };
    if (cached && cached.text && cached.src === srcKey(full)) {
      return { text: cached.text, by: cached.by || 'модель' };
    }
    const short = shortName(full);
    return { text: short.text || full, by: short.known ? 'словарь' : 'как в WMS' };
  }

  root.UCoreSkuName = {
    shortName, quantity, color, head, weightKg, weightText, norm,
    checkTranslation, srcKey, displayName, LLM_MAX_CHARS,
    // словари наружу: тесты и будущее пополнение
    HEADS, COLORS, MODS
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
