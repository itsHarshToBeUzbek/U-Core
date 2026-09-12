// Работает в MAIN-мире страницы dp.uzum.uz, на document_start.
//
// ДЕЛАЕТ РОВНО ДВА ДЕЛА:
//
//   1) запоминает заголовок Authorization, который страница ставит сама;
//   2) по просьбе расширения выполняет GET и отдаёт ответ обратно.
//
// Чего он больше НЕ делает: не перехватывает и не разбирает ответы страницы.
// Раньше он копировал каждый ответ WMS и передавал расширению «на разбор» —
// оттуда в таблицу приёмки попадал мусор, который потом приходилось ловить
// правилами. Теперь данные приходят только тогда, когда оператор нажал
// кнопку, и только с тех адресов, которые расширение спросило само.
//
// Почему запрос делает страница, а не расширение: у страницы живая сессия и
// свежий токен по построению. Любая попытка это воспроизвести была догадкой,
// и каждая догадка кончалась 401 при работающем WMS.

(function () {
  'use strict';

  const CHANNEL = 'ucore-wms';

  function registrableBase(hostname) {
    const parts = String(hostname || '').split('.');
    return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
  }

  const PAGE_HOST = location.hostname;
  const PAGE_BASE = registrableBase(PAGE_HOST);

  // Домен НЕ зашит: он выводится из адреса самой страницы, а где расширению
  // вообще разрешено работать — записано в manifest.json. Зашитый домен
  // ломал этот проект пять раз подряд, причём молча.
  function sameHost(url) {
    try {
      const host = new URL(url, location.href).hostname;
      return host === PAGE_HOST || registrableBase(host) === PAGE_BASE;
    } catch (e) {
      return false;
    }
  }

  function post(entry) {
    try {
      window.postMessage({ __ucore: CHANNEL, entry }, location.origin);
    } catch (e) {
      /* postMessage не должен ронять страницу ни при каких данных */
    }
  }

  // ---------- 1. Заголовок авторизации ----------
  //
  // WMS авторизует ТОЛЬКО заголовком: куки к api-wms не уходят вовсе
  // (страница шлёт credentials:'same-origin', а хост чужой).
  //
  // Заголовки лежат внутри объекта Request — приложение вызывает
  // fetch(new Request(url, {headers})), и второй аргумент пустой.
  //
  // И главное: на один домен идут ДВА вида запросов, вперемешку —
  //     к api-wms    -> {accept, accept-language, authorization}
  //     к dp.uzum.uz -> {x-experiments, x-requested-with}
  // Запоминать «последний увиденный набор» нельзя: соседний запрос без
  // токена затирал токен, и наружу уходил набор без авторизации. Слить их
  // в один тоже нельзя — x-* заголовки api-wms в CORS не разрешает, и
  // запрос с ними не доходит вовсе. Поэтому берём ЦЕЛИКОМ тот набор, в
  // котором пришёл токен.

  const REPLAY_HEADERS = /^(authorization|accept|accept-language)$/i;

  let lastAuth = null;
  let lastSignature = '';

  function collect(headers) {
    const out = {};
    if (!headers) return out;
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((value, key) => {
          if (REPLAY_HEADERS.test(key)) out[key.toLowerCase()] = value;
        });
      } else if (Array.isArray(headers)) {
        for (const [key, value] of headers) {
          if (REPLAY_HEADERS.test(key)) out[String(key).toLowerCase()] = value;
        }
      } else if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) {
          if (REPLAY_HEADERS.test(key) && typeof value === 'string') out[key.toLowerCase()] = value;
        }
      }
    } catch (e) { /* нестандартный контейнер — пропускаем */ }
    return out;
  }

  // Подпись по ДЛИНЕ токена не годится: обновлённый JWT почти всегда ровно
  // той же длины, и обновление не замечалось — расширение целую смену
  // ходило со старым токеном.
  function cheapHash(value) {
    let h = 5381;
    for (let i = 0; i < value.length; i++) h = ((h << 5) + h + value.charCodeAt(i)) | 0;
    return String(h);
  }

  function remember(headers) {
    const auth = collect(headers);
    if (!auth.authorization) return;
    lastAuth = auth;
    const signature = cheapHash(auth.authorization);
    if (signature === lastSignature) return;
    lastSignature = signature;
    post({ __authHeaders: auth, at: Date.now() });
  }

  const nativeFetch = window.fetch;

  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      try {
        const input = args[0];
        const init = args[1] || {};
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (sameHost(url)) remember(init.headers || (input && input.headers));
      } catch (e) { /* перехват не должен мешать странице работать */ }
      return nativeFetch.apply(this, args);
    };
  }

  // XHR. Живой WMS 3.90.5 ходит через fetch — проверено. Но перехват
  // только одного транспорта означал бы, что переход приложения на XHR
  // сломает авторизацию МОЛЧА: расширение просто перестанет видеть токен,
  // а выглядеть это будет как «сессия истекла». Десять строк здесь дешевле
  // такого расследования. Тела ответов не читаются и тут.
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try { this.__ucoreUrl = url; } catch (e) { /* не мешаем запросу */ }
    return nativeOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (sameHost(this.__ucoreUrl || '') && REPLAY_HEADERS.test(String(name))) {
        this.__ucoreHeaders = this.__ucoreHeaders || {};
        this.__ucoreHeaders[String(name).toLowerCase()] = value;
        if (this.__ucoreHeaders.authorization) remember(this.__ucoreHeaders);
      }
    } catch (e) { /* см. выше */ }
    return nativeSetHeader.call(this, name, value);
  };

  // РУКОПОЖАТИЕ. Этот скрипт стартует на document_start, а content.js — на
  // document_idle: первые запросы страницы (именно они несут токен) уходят
  // раньше, чем появляется слушатель. Отправка дедуплицирована, поэтому одно
  // потерянное сообщение означало бы, что токен не увидят никогда.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.__ucore !== 'ucore-ready') return;
    if (lastAuth) post({ __authHeaders: lastAuth, at: Date.now() });
  });

  // ---------- 2. Запрос по просьбе расширения ----------

  const ALLOWED_PATH = /^\/(de|or)\//;
  const FORBIDDEN_PATH = /(acceptance|item-acceptance|encashment|withdraw|assign-identifier|place-return|complete|confirm|cancel|adjustment)/i;

  // ЕДИНСТВЕННЫЙ разрешённый POST — справочник товаров. Тело: список
  // числовых id, ответ: названия и габариты. Он ничего не меняет, но всё
  // равно вынесен в поимённый список, а тело проверяется.
  const ALLOWED_POST = new Set(['/de/sku/basic/all/id']);

  function isPlainIdList(body) {
    try {
      const parsed = JSON.parse(body);
      return Array.isArray(parsed) && parsed.length > 0 && parsed.length <= 500
        && parsed.every((v) => typeof v === 'number' && Number.isFinite(v));
    } catch (e) {
      return false;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__ucore !== 'ucore-fetch' || !msg.id) return;

    const reply = (payload) => post({ __fetchResult: { id: msg.id, ...payload } });

    let target;
    try {
      target = new URL(msg.url, location.href);
    } catch (e) {
      reply({ ok: false, error: 'плохой адрес' });
      return;
    }

    // Последний рубеж перед реальным сетевым вызовом. Те же границы
    // проверяет и расширение — здесь они продублированы намеренно.
    if (!sameHost(target.href) || !ALLOWED_PATH.test(target.pathname)
        || FORBIDDEN_PATH.test(target.pathname)) {
      reply({ ok: false, error: 'адрес не разрешён' });
      return;
    }

    const method = String(msg.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      reply({ ok: false, error: 'метод не разрешён' });
      return;
    }
    if (method === 'POST' && (!ALLOWED_POST.has(target.pathname) || !isPlainIdList(msg.body))) {
      reply({ ok: false, error: 'этот POST не разрешён' });
      return;
    }

    if (!lastAuth || !lastAuth.authorization) {
      reply({ ok: false, error: 'страница ещё не сделала ни одного запроса к WMS' });
      return;
    }

    const headers = { ...lastAuth };
    const options = { method, headers };
    if (method === 'POST') {
      options.body = msg.body;
      options.headers = { ...headers, 'content-type': 'application/json' };
    }

    // credentials НЕ 'include': приложение шлёт 'same-origin', то есть куки
    // в api-wms не уходят вовсе. Запрос с 'include' на чужой origin сервер
    // обязан разрешить отдельно, и если не разрешает — браузер рубит ответ
    // ещё до кода состояния. Повторяем ровно то, что делает страница.
    nativeFetch.call(window, target.href, options)
      .then((response) => response.text().then((body) => reply({
        ok: response.ok, status: response.status, body: body.slice(0, 2000000)
      })))
      .catch((err) => reply({ ok: false, error: String((err && err.message) || err).slice(0, 200) }));
  });
})();
