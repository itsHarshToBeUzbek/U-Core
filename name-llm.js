// ==========================================
// name-llm.js — перевод названий товаров языковой моделью
// ==========================================
// ES-модуль, живёт в service worker: только он умеет ходить в сеть, когда
// попап закрыт, и только у него есть право на адрес переводчика.
//
// ПОЧЕМУ НЕ СЛОВАРЬ. В sku-name.js лежит 62 главных слова, собранных по
// живому срезу ТАШ-120. На том срезе он узнаёт 54 названия из 55 — и это
// число обманчиво дважды. Во-первых, он по этому же срезу и составлялся.
// Во-вторых, список товаров, которые может заказать человек, не закрыт:
// завтра приедет леска для триммера, полка для обуви и корм для шиншилл.
// Словарь на такое не доделывается, он обслуживается — и обслуживать его
// будет некому.
//
// КУДА УХОДЯТ НАЗВАНИЯ. К выбранной модели, по ключу владельца ПВЗ. Наружу
// уходит РОВНО название товара — то, которое и так открыто на витрине
// Uzum. Ни клиентов, ни телефонов, ни номеров заказов, ни ячеек: список
// на отправку собирается из справочника товаров, а не из записей о полке.
// Право на адрес модели лежит в optional_host_permissions — то есть его
// нет, пока человек не включил перевод и не подтвердил в окне Chrome.
//
// КЛЮЧ ВВОДИТ ЧЕЛОВЕК. Он лежит отдельно от настроек (`skuNameKey`), не
// попадает ни в отчёт о работе, ни в подсказку модели, ни в журнал. Наружу
// уходит только на тот адрес, который выбран в панели.
//
// ПОЧЕМУ ПАЧКАМИ. Подсказка с правилами и примерами весит втрое больше
// самого названия. Спрашивать по одному — значит платить за правила
// столько раз, сколько товаров. Двадцать пять названий в одном запросе
// стоят немногим больше одного, а весь справочник ПВЗ (около пятисот
// наименований) укладывается в двадцать запросов и в пару центов.
//
// ЧЕМ ПАЧКА ОПАСНА. Модель возвращает двадцать четыре ответа вместо
// двадцати пяти или сдвигает их на один — и правильный перевод встаёт к
// чужому товару. Такую ошибку не видно: название читается нормально, просто
// не про этот товар. Поэтому в каждом ответе модель обязана повторить
// начало исходного названия, и мы сверяем. Не совпало — ответ выброшен.
//
// ПОЧЕМУ ОТВЕТ ПРОВЕРЯЕТСЯ ЕЩЁ И ПО СУТИ. См. checkTranslation в
// sku-name.js: модель отвечает уверенно и когда не знает, а числа путает
// охотнее всего.

export const SETTINGS_KEY = 'skuNameLlm';
export const KEY_KEY = 'skuNameKey';
export const CACHE_KEY = 'skuNameCache';
export const RUN_KEY = 'skuNameRun';

/**
 * Куда можно ходить. Все эти сервисы говорят на одном языке —
 * OpenAI-совместимом `/chat/completions`, — поэтому транспорт один, а
 * провайдер это просто адрес, модель и место, где взять ключ.
 *
 * Адрес нельзя сделать просто полем ввода: Chrome разрешает спрашивать
 * право только на те хосты, что перечислены в манифесте. Новый сервис —
 * это строка в manifest.json, и это правильно: расширение не должно уметь
 * отправить названия куда попало.
 */
export const PROVIDERS = Object.freeze({
  gemini: {
    title: 'Google AI Studio (Gemini)',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    keys: 'aistudio.google.com/apikey'
  },
  openai: {
    title: 'OpenAI',
    base: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keys: 'platform.openai.com/api-keys'
  },
  deepseek: {
    title: 'DeepSeek',
    base: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keys: 'platform.deepseek.com/api_keys'
  },
  openrouter: {
    title: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
    keys: 'openrouter.ai/keys'
  },
  local: {
    title: 'На этом компьютере (Ollama, LM Studio)',
    base: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
    keys: null
  }
});

export const DEFAULTS = Object.freeze({
  enabled: false,
  provider: 'gemini',
  base: PROVIDERS.gemini.base,
  model: PROVIDERS.gemini.model,
  batch: 25,
  timeoutMs: 90000,
  gapMs: 300
});

export async function readSettings() {
  const data = await chrome.storage.local.get([SETTINGS_KEY]);
  return { ...DEFAULTS, ...(data[SETTINGS_KEY] || {}) };
}

export async function writeSettings(patch) {
  const next = { ...(await readSettings()), ...(patch || {}) };
  delete next.key;                   // ключ здесь не хранится, см. ниже
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Ключ отдельно от настроек: настройки уходят в отчёты, ключ — никогда. */
export async function readKey() {
  const data = await chrome.storage.local.get([KEY_KEY]);
  return typeof data[KEY_KEY] === 'string' ? data[KEY_KEY] : '';
}

/**
 * ЧТО НЕ ТАК С КЛЮЧОМ. Ключ вставляют из письма или с сайта, и вместе с ним
 * приезжает то, чего в нём быть не может: перевод строки, кавычки-ёлочки,
 * русская «с» вместо латинской.
 *
 * Проверять это нужно ЗДЕСЬ, а не в момент запроса, потому что заголовок
 * HTTP не умеет хранить ничего, кроме печатных ASCII: браузер отказывается
 * собрать такой запрос, и наружу это выходит как «не удалось соединиться».
 * Человек после этого проверяет интернет, роутер и адрес сервиса — всё,
 * кроме того единственного места, где ошибка.
 */
const KEY_ALLOWED = /^[\x21-\x7e]+$/;

export function keyProblem(key) {
  const value = String(key == null ? '' : key);
  if (!value) return null;
  if (value !== value.trim()) return 'по краям ключа есть пробелы — скопировалось лишнее';
  if (/\s/.test(value)) return 'внутри ключа пробел или перевод строки';
  if (!KEY_ALLOWED.test(value)) {
    return 'в ключе есть символы, которых в ключах не бывает — похоже, скопировалось лишнее';
  }
  return null;
}

export async function writeKey(key) {
  const value = String(key || '').trim();
  const problem = keyProblem(value);
  if (problem) return { ok: false, problem };
  if (!value) await chrome.storage.local.remove([KEY_KEY]);
  else await chrome.storage.local.set({ [KEY_KEY]: value });
  return { ok: true, hasKey: !!value };
}

export function originOf(base) {
  try {
    return `${new URL(base).origin}/*`;
  } catch (e) {
    return null;
  }
}

/** Есть ли право ходить на этот адрес. Спрашиваем, не берём. */
export async function hasAccess(base) {
  const origin = originOf(base);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (e) {
    return false;
  }
}

// ---------- подсказка ----------
//
// Примеры важнее правил: по образцу модель понимает формат надёжнее, чем по
// описанию. Все четыре взяты из живых названий ТАШ-120.

const SYSTEM = [
  'Ты сокращаешь названия товаров для пункта выдачи заказов.',
  'Отвечаешь только JSON, без пояснений и без markdown.'
].join(' ');

const SHOTS = [
  ['Bolalar atir sovuni Oila Tanlovi, 140 g (Rang: Moviy)', 'Мыло детское, 140 г, синее'],
  ['Idish yuvish uchun gel Fairy limon 900 ml', 'Гель для мытья посуды Fairy, 900 мл'],
  ['Maktab ryukzagi qizlar uchun (Rang: Pushti)', 'Рюкзак школьный, розовый'],
  ['Simsiz quloqchin JBL Tune 510BT', 'Наушники беспроводные JBL Tune 510BT']
];

/** Первые два слова названия — ими модель подтверждает, на что отвечает. */
export function echoOf(name) {
  return String(name || '').trim().split(/\s+/).slice(0, 2).join(' ');
}

export function buildPrompt(names) {
  const rules = [
    'Для каждого названия дай короткое русское: что это за вещь, сколько её, какого цвета.',
    'Главное слово узбекского названия стоит в КОНЦЕ: «idish yuvish uchun gel» — это гель.',
    'Не добавляй того, чего нет в исходном названии: ни чисел, ни марок.',
    'Ключевые слова для поиска, состав и рекламу выбрось.',
    '',
    'Ответ — JSON: {"items":[{"i":номер,"o":"первые два слова оригинала","t":"перевод"}]}',
    'Поле o обязательно: по нему видно, на какое название ты отвечаешь.',
    'Один объект на каждое название, ни одного не пропускай.'
  ].join('\n');

  const shotIn = SHOTS.map(([q], i) => `${i + 1}. ${q}`).join('\n');
  const shotOut = JSON.stringify({
    items: SHOTS.map(([q, a], i) => ({ i: i + 1, o: echoOf(q), t: a }))
  });

  const list = names.map((n, i) => `${i + 1}. ${String(n).trim()}`).join('\n');
  return `${rules}\n\nПример.\nНазвания:\n${shotIn}\nОтвет: ${shotOut}\n\nНазвания:\n${list}\nОтвет:`;
}

// ---------- транспорт ----------

function networkError(base) {
  return new Error(
    `не удалось соединиться с ${base}. Проверьте адрес, интернет`
    + ' и, если модель местная, что она запущена'
  );
}

async function chat({ base, model, key, prompt, timeoutMs, signal, json = true }) {
  const url = `${String(base).replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt }
    ]
  };
  // Режим строгого JSON поддерживают не все и не всегда под этим именем.
  // Отказ по этому поводу — не ошибка запроса, а разница между сервисами:
  // повторяем без него, разбор всё равно готов к неряшливому ответу.
  if (json) body.response_format = { type: 'json_object' };

  const broken = keyProblem(key);
  if (broken) throw new Error(`ключ не годится: ${broken}`);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let response;
  try {
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
  } catch (err) {
    if (signal && signal.aborted) throw new Error('остановлено');
    if (err && err.name === 'AbortError') {
      throw new Error(`модель не ответила за ${Math.round(timeoutMs / 1000)} с`);
    }
    // Браузер заворачивает в TypeError и отказ сети, и неправильно собранный
    // запрос. Отличаем по cause: у сетевого отказа он есть (ECONNREFUSED и
    // подобное), у испорченного заголовка — нет. Без этого любая ошибка в
    // ключе выглядела бы как обрыв связи.
    if (err instanceof TypeError && !err.cause) {
      throw new Error(`запрос не собрался: ${err.message}`);
    }
    throw networkError(base);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const text = await response.text();
  if (!response.ok) {
    const snippet = text.slice(0, 300).replace(/\s+/g, ' ').trim();
    if (json && /response_format|json/i.test(snippet) && response.status === 400) {
      return chat({ base, model, key, prompt, timeoutMs, signal, json: false });
    }
    // Про ключ говорим прямо: это единственная ошибка, которую человек
    // исправляет сам и за десять секунд.
    if (response.status === 401 || response.status === 403) {
      throw new Error('ключ не принят — проверьте его в панели «Названия…»');
    }
    if (response.status === 429) throw new Error('слишком часто: сервис просит подождать');
    throw new Error(`сервис ответил ${response.status}${snippet ? `: ${snippet}` : ''}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('сервис ответил не по формату');
  }
  const choice = data && data.choices && data.choices[0];
  return String((choice && choice.message && choice.message.content) || '');
}

// ---------- разбор ответа ----------

/**
 * Достать items из того, что приехало. Модели любят обернуть JSON в
 * ```json ... ``` или приписать строку до него — это не повод выбрасывать
 * работу, которую уже оплатили.
 */
export function parseItems(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.search(/[[{]/);
  if (start > 0) text = text.slice(start);
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return null;
  }
  const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
  if (!items) return null;
  return items;
}

const normLoose = (v) => String(v || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '');

/**
 * Разложить пачку ответов по своим товарам.
 *
 * Номер `i` даёт модель, и доверять ему одному нельзя — сдвиг на единицу
 * выглядит как исправно работающий перевод. Поэтому каждый ответ обязан
 * повторить начало исходного названия: пришло не то начало — ответ чужой,
 * и он выбрасывается целиком, а товар остаётся в очереди на следующий раз.
 */
export function alignBatch(items, names, { checkTranslation }) {
  const out = new Array(names.length).fill(null);
  const problems = [];
  for (const item of (items || [])) {
    const index = Number(item && item.i) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= names.length) {
      problems.push({ name: '(нет номера)', answer: String((item && item.t) || ''), why: 'номер вне пачки' });
      continue;
    }
    const name = names[index];
    const echo = normLoose(item && item.o);
    if (!echo || !normLoose(name).startsWith(echo)) {
      problems.push({ name, answer: String((item && item.t) || ''), why: 'ответ не про этот товар' });
      continue;
    }
    const verdict = checkTranslation(name, item && item.t);
    if (!verdict.ok) {
      problems.push({ name, answer: verdict.text, why: verdict.why });
      continue;
    }
    out[index] = verdict.text;
  }
  return { texts: out, problems };
}

// ---------- очередь ----------

/**
 * Перевести всё, что дали. Пачками, по одному запросу на пачку.
 *
 * Пачка, ответ которой не разобрался, делится пополам и повторяется:
 * причина почти всегда в одном неудачном названии, и терять из-за него
 * двадцать четыре готовых перевода незачем. Деление идёт до одного товара.
 *
 * После каждой пачки зовётся onProgress — им же живёт строка состояния и
 * сохранение на полпути. Перевод всего справочника занимает минуты, и
 * работа, которую надо начинать заново из-за закрытой вкладки, не будет
 * сделана никогда.
 */
export async function translateAll({
  items, settings, key, cache, signal, onProgress, checkTranslation, srcKey
}) {
  const s = { ...DEFAULTS, ...(settings || {}) };
  const next = { ...(cache || {}) };
  const report = {
    total: items.length, done: 0, ok: 0, failed: 0,
    requests: 0, rejected: [], error: null
  };

  // Три отказа подряд означают, что сломался не товар, а сервис: кончились
  // деньги, отозвали ключ, лежит сеть. Очередь на пятьсот названий, упершись
  // в это, потратит впустую и время, и запросы, а в отчёт напишет пятьсот
  // одинаковых строк вместо одной внятной причины.
  const GIVE_UP_AFTER = 3;
  let inARow = 0;

  const remember = (item, text) => {
    next[item.barcode] = { text, src: srcKey(item.name), by: 'модель', at: Date.now() };
  };

  async function run(chunk) {
    if (signal && signal.aborted) return;
    const names = chunk.map(it => it.name);
    let raw;
    try {
      report.requests += 1;
      raw = await chat({
        base: s.base, model: s.model, key,
        prompt: buildPrompt(names), timeoutMs: s.timeoutMs, signal
      });
      inARow = 0;
    } catch (err) {
      const message = String(err && err.message || err);
      inARow += 1;
      const hopeless = /остановлено|ключ не принят|ключ не годится|соединиться/.test(message);
      if (hopeless || inARow >= GIVE_UP_AFTER) {
        report.error = hopeless ? message : `${message} (${inARow} раза подряд)`;
        report.done += chunk.length;
        report.failed += chunk.length;
        throw new Error('__stop__');
      }
      report.done += chunk.length;
      report.failed += chunk.length;
      if (onProgress) await onProgress({ ...report, note: message });
      return;
    }

    const parsed = parseItems(raw);
    if (!parsed) {
      // Ответ не разобрался. Один товар делить дальше некуда — считаем его
      // неудачей и идём дальше, а пачку пробуем половинками.
      if (chunk.length === 1) {
        report.done += 1;
        report.failed += 1;
        report.rejected.push({ name: chunk[0].name, answer: String(raw).slice(0, 60), why: 'ответ не JSON' });
        if (onProgress) await onProgress({ ...report, cache: next });
        return;
      }
      const half = Math.ceil(chunk.length / 2);
      await run(chunk.slice(0, half));
      await run(chunk.slice(half));
      return;
    }

    const { texts, problems } = alignBatch(parsed, names, { checkTranslation });
    for (let i = 0; i < chunk.length; i++) {
      report.done += 1;
      if (texts[i]) {
        report.ok += 1;
        remember(chunk[i], texts[i]);
      } else {
        report.failed += 1;
      }
    }
    for (const problem of problems) {
      if (report.rejected.length < 20) report.rejected.push(problem);
    }
    if (onProgress) await onProgress({ ...report, cache: next });
    if (s.gapMs) await new Promise(r => setTimeout(r, s.gapMs));
  }

  const size = Math.max(1, Math.min(50, Number(s.batch) || DEFAULTS.batch));
  try {
    for (let i = 0; i < items.length; i += size) {
      if (signal && signal.aborted) break;
      await run(items.slice(i, i + size));
    }
  } catch (err) {
    if (String(err && err.message) !== '__stop__') throw err;
  }

  return { report, cache: next };
}

/** Что на том конце: список моделей. Заодно проверка ключа и адреса. */
export async function probe(settings, key) {
  const s = { ...DEFAULTS, ...(settings || {}) };
  if (!(await hasAccess(s.base))) {
    return { ok: false, needPermission: true, error: 'нет разрешения на этот адрес' };
  }
  const url = `${String(s.base).replace(/\/+$/, '')}/models`;
  let data;
  try {
    const headers = {};
    if (key) headers.authorization = `Bearer ${key}`;
    const response = await fetch(url, { headers });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: 'ключ не принят' };
    }
    if (!response.ok) return { ok: false, error: `сервис ответил ${response.status}` };
    data = await response.json();
  } catch (err) {
    return { ok: false, error: networkError(s.base).message };
  }
  const models = ((data && data.data) || [])
    .map(m => String((m && (m.id || m.name)) || ''))
    .filter(Boolean);
  const has = models.includes(s.model)
    || models.some(m => m.endsWith(`/${s.model}`) || m === `models/${s.model}`);
  return { ok: true, models, hasModel: has };
}
