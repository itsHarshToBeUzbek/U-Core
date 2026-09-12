// ==========================================
// Автозаполнение формы "Начать работу" на dp.uzum.uz/cashbox
// ==========================================
// ВАЖНО: этот скрипт НИКОГДА не нажимает "Начать работу" и не отправляет форму —
// он только подставляет значения. Проверка и подтверждение остаются за пользователем.
//
// Диагностика: все сообщения этого файла помечены префиксом [ПВЗ Помощник],
// чтобы их было легко найти в консоли DevTools (F12 → Console) при отладке.

(function () {
  'use strict';

  const LOG_PREFIX = '[ПВЗ Помощник]';
  const INJECTED_ATTR = 'data-pvz-helper-injected';
  // Тот же порядок номиналов, что и в калькуляторе (popup.js) — сверху вниз,
  // как расположены строки в "Покупюрной ведомости" WMS.
  const DENOMINATIONS = [200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000];

  console.log(`${LOG_PREFIX} content script загружен на`, location.href);

  // Если расширение было перезагружено (обновление кода) при уже открытой
  // вкладке WMS, этот экземпляр content script остаётся "осиротевшим" —
  // любое обращение к chrome.* API выбросит "Extension context invalidated".
  // Ловим это отдельно, чтобы показать понятную инструкцию вместо немой ошибки.
  function isContextInvalidated(err) {
    return !!err && /context invalidated/i.test(err.message || '');
  }

  // Устанавливаем значение через нативный сеттер, чтобы Vue-компонент
  // (v-model) действительно увидел изменение, а не просто визуально
  // обновлённый <input>, который фреймворк проигнорирует.
  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);

    // Используем InputEvent (а не просто Event) — некоторые кастомные
    // числовые поля (маски, валидация) явно проверяют тип события.
    let inputEvent;
    try {
      inputEvent = new InputEvent('input', { bubbles: true, cancelable: true, composed: true });
    } catch (e) {
      inputEvent = new Event('input', { bubbles: true });
    }
    input.dispatchEvent(inputEvent);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Некоторые компоненты форматируют/фиксируют значение только по потере
    // фокуса — досылаем blur на случай, если поле именно так и работает.
    input.dispatchEvent(new Event('blur'));
  }

  // Визуальное подтверждение, что поле заполнено: мягкая зелёная заливка,
  // которая плавно "растворяется" обратно в исходный фон поля — вместо
  // прежней жёсткой зелёной рамки-квадрата, которая смотрелась грубо.
  function flashSuccess(input) {
    if (!input) return;
    const prevBg = input.style.backgroundColor;
    const prevTransition = input.style.transition;

    // Ставим стартовый цвет без анимации, форсируем reflow, чтобы браузер
    // "зафиксировал" зелёный как отправную точку, а затем включаем плавный
    // переход обратно к исходному фону.
    input.style.transition = 'none';
    input.style.backgroundColor = 'rgba(46, 125, 50, 0.38)';
    void input.offsetWidth;
    input.style.transition = 'background-color 1.1s ease';
    input.style.backgroundColor = prevBg;

    setTimeout(() => {
      input.style.transition = prevTransition;
    }, 1150);
  }

  // Поле "Номер сумки" не имеет собственного id/data-test-id — все четыре
  // .input-ui блока в форме используют один и тот же data-test-id.
  // Находим нужный по тексту его .label.
  function findBagNumberInput(formCash) {
    const blocks = formCash.querySelectorAll('[data-test-id="input-ui"]');
    for (const block of blocks) {
      const label = block.querySelector('.label');
      if (label && label.textContent.trim() === 'Номер сумки') {
        return block.querySelector('input');
      }
    }
    return null;
  }

  // ЧИНИМ ЗДЕСЬ (раунд 2): консоль показала, что "Номер сумки" находится
  // внутри .form-cash (предупреждения о его отсутствии не было), а строки
  // номиналов — НЕТ, ни по тексту "...сум", ни по старому классу
  // .form-banknote-statement, даже при поиске ПО ВСЕМУ .form-cash. Значит
  // таблица номиналов физически не вложена в .form-cash — это отдельный
  // блок где-то рядом (соседний компонент в общей панели "Начать работу"),
  // а не его потомок. Поиск, ограниченный формой, был обречён найти 0 строк
  // независимо от текста или класса.
  //
  // Поэтому теперь мы не ищем строго внутри .form-cash: начинаем с него и
  // поднимаемся по родителям вверх, на каждом уровне проверяя, не появились
  // ли в этом более широком контейнере строки с "...сум". Как только строки
  // нашлись — используем их и не поднимаемся дальше. Это находит таблицу
  // независимо от того, лежит ли она внутри формы, рядом с ней или в общей
  // обёртке панели, и не зависит ни от одного конкретного имени класса.
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findDenominationRows(startEl) {
    let scope = startEl;
    let depth = 0;
    const maxDepth = 25; // с большим запасом — практически гарантированно дойдёт до <body>
    while (scope && depth < maxDepth) {
      const rows = Array.from(scope.querySelectorAll('tr')).filter(row => {
        const cell = row.querySelector('td, th');
        const text = cell ? cell.textContent : '';
        return /сум/i.test(text) && /\d/.test(text) && isVisible(row);
      });
      if (rows.length > 0) return rows;
      scope = scope.parentElement;
      depth++;
    }
    return [];
  }

  function getDenominationInputMap(formCash) {
    const map = {};

    findDenominationRows(formCash).forEach(row => {
      const cell = row.querySelector('td, th');
      const digits = cell.textContent.replace(/\D/g, ''); // цифры, независимо от вида пробела-разделителя
      if (!digits) return;
      const denom = parseInt(digits, 10);
      const input = row.querySelector('input.u-text-field__input')
        || row.querySelector('input[type="number"]')
        || row.querySelector('input');
      if (input) map[denom] = input;
    });

    if (Object.keys(map).length > 0) return map;

    // Последний резервный вариант — старое поведение по позиции строки
    // внутри .form-banknote-statement, теперь уже по всему документу
    // (вдруг класс существует, но не рядом с .form-cash).
    console.warn(`${LOG_PREFIX} не нашёл строки номиналов ни по тексту, ни поднимаясь по предкам — пробую резервный способ по .form-banknote-statement во всём документе`);
    const legacyRows = document.querySelectorAll('.form-banknote-statement tbody tr');
    Array.from(legacyRows).forEach((row, idx) => {
      const denom = DENOMINATIONS[idx];
      const input = row.querySelector('input.u-text-field__input') || row.querySelector('input[type="number"]');
      if (denom !== undefined && input) map[denom] = input;
    });

    return map;
  }

  function fillForm() {
    const formCash = document.querySelector('.form-cash');
    if (!formCash) {
      console.warn(`${LOG_PREFIX} .form-cash не найден в момент клика — форма ещё не открыта?`);
      alert('⚠️ Форма открытия смены не найдена на странице.');
      return;
    }

    try {
      // savedCounts — это ВСЕ купюры "по факту" (инкассация + сдача, которая
      // остаётся в кассе). Для формы WMS нужны только купюры на инкассацию,
      // поэтому читаем отдельно сохранённый набор savedEncashCounts (считается
      // в popup.js по той же логике, что и колонка "Инкассация" в калькуляторе).
      // savedCounts при этом всё ещё нужен — по нему определяем, пользовался
      // ли человек калькулятором вообще (см. hasSavedData ниже).
      chrome.storage.local.get(['savedCounts', 'savedEncashCounts', 'savedBagNumber',
                               'savedEncashBlocked'], (data) => {
        if (chrome.runtime.lastError) {
          console.error(`${LOG_PREFIX} ошибка чтения хранилища —`, chrome.runtime.lastError.message);
          alert('❌ Не удалось прочитать сохранённые данные из расширения.');
          return;
        }

        // НЕДОСДАЧА БОЛЬШЕ СДАЧИ — В ФОРМУ НИЧЕГО НЕ ПОДСТАВЛЯЕМ.
        //
        // Калькулятор в таком случае честно не считает раскладку: покрыть
        // такую недостачу нечем. Заполнить форму «хоть чем-то» значит
        // подсказать оператору неверное действие с деньгами, и заметит он
        // это в лучшем случае у банка.
        if (data.savedEncashBlocked) {
          alert('❌ Авто-заполнение отключено.\n\nНедосдача больше 500 000 — покрыть её сдачей '
              + 'нельзя. Откройте расширение, вкладка «Инкассация», и разберитесь с деньгами: '
              + 'подставлять числа в кассу в таком виде нельзя.');
          return;
        }

        const factCounts = data.savedCounts || {};
        const encashCounts = data.savedEncashCounts || {};
        const bagNumber = data.savedBagNumber;
        console.log(`${LOG_PREFIX} читаю данные из хранилища:`, { bagNumber, factCounts, encashCounts });

        const bagInput = findBagNumberInput(formCash);
        if (bagInput) {
          if (bagNumber !== undefined && bagNumber !== '') {
            setNativeValue(bagInput, String(bagNumber));
            flashSuccess(bagInput);
          }
        } else {
          console.warn(`${LOG_PREFIX} поле "Номер сумки" не найдено — возможно, изменилась вёрстка WMS.`);
        }

        const denomMap = getDenominationInputMap(formCash);
        console.log(`${LOG_PREFIX} найдено полей номиналов на странице:`, Object.keys(denomMap).length, '(ожидалось как минимум', DENOMINATIONS.length, ')');

        let filledCount = 0;
        DENOMINATIONS.forEach((denom) => {
          const input = denomMap[denom];
          const count = encashCounts[denom];
          if (!input) {
            console.warn(`${LOG_PREFIX} не найдено поле для номинала ${denom} на странице — пропускаю.`);
            return;
          }
          if (count !== undefined && count !== '' && count !== '0') {
            setNativeValue(input, String(count));
            flashSuccess(input);
            filledCount++;
          }
        });

        console.log(`${LOG_PREFIX} заполнено полей номиналов (только инкассация, без сдачи):`, filledCount);

        // "Есть ли вообще что подставлять" проверяем по ФАКТИЧЕСКИМ купюрам
        // (не по encashCounts) — иначе если весь факт ушёл в "Сдачу" (остаток
        // кассы не превысил минимальный резерв), пользователю ошибочно
        // покажет предупреждение "нет сохранённых данных", хотя калькулятор
        // на самом деле заполнен, просто инкассировать сейчас нечего.
        const hasSavedData = (bagNumber !== undefined && bagNumber !== '')
          || Object.keys(factCounts).some(k => factCounts[k] !== undefined && factCounts[k] !== '' && factCounts[k] !== '0');

        if (!hasSavedData) {
          alert('⚠️ В расширении нет сохранённых данных калькулятора. Заполните вкладку "Инкассация" сначала (или импортируйте данные с другого компьютера).');
        } else if (Object.keys(denomMap).length === 0) {
          alert('❌ Не удалось найти таблицу номиналов на странице — похоже, изменилась вёрстка WMS. Откройте консоль (F12 → Console) и пришлите разработчику, что там написано.');
        }
      });
    } catch (err) {
      if (isContextInvalidated(err)) {
        console.error(`${LOG_PREFIX} расширение было обновлено/перезагружено — эта вкладка использует устаревший скрипт.`);
        alert('❌ Расширение было обновлено. Обновите эту страницу (F5) и попробуйте снова.');
      } else {
        console.error(`${LOG_PREFIX} неожиданная ошибка при чтении хранилища:`, err);
        alert('❌ Не удалось прочитать данные расширения. См. консоль (F12) для деталей.');
      }
    }
  }

  const BTN_GRADIENT = 'linear-gradient(135deg, #7000ff, #9b4dff)';
  const BTN_GRADIENT_HOVER = 'linear-gradient(135deg, #5a00cc, #7f33e6)';

  function createFillButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(INJECTED_ATTR, 'true');
    // Пилюля с иконкой-молнией вместо плоского прямоугольника — заметнее
    // как акцентная кнопка действия и не выглядит как элемент формы WMS.
    btn.innerHTML = [
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">',
      '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
      '</svg>',
      '<span>Заполнить (U-Core)</span>'
    ].join('');
    btn.style.cssText = [
      'margin-left: auto',
      'display: inline-flex',
      'align-items: center',
      'gap: 6px',
      `background: ${BTN_GRADIENT}`,
      'color: #ffffff',
      'border: none',
      'border-radius: 999px',
      'padding: 7px 16px',
      'font-family: Inter, Arial, sans-serif',
      'font-weight: 600',
      'font-size: 12px',
      'line-height: 1',
      'cursor: pointer',
      'white-space: nowrap',
      'box-shadow: 0 3px 10px -3px rgba(112, 0, 255, 0.55)',
      'transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease'
    ].join(';');
    btn.addEventListener('mouseenter', () => {
      btn.style.background = BTN_GRADIENT_HOVER;
      btn.style.boxShadow = '0 5px 14px -3px rgba(112, 0, 255, 0.65)';
      btn.style.transform = 'translateY(-1px)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = BTN_GRADIENT;
      btn.style.boxShadow = '0 3px 10px -3px rgba(112, 0, 255, 0.55)';
      btn.style.transform = 'translateY(0)';
    });
    btn.addEventListener('mousedown', () => { btn.style.transform = 'translateY(0) scale(0.97)'; });
    btn.addEventListener('mouseup', () => { btn.style.transform = 'translateY(-1px) scale(1)'; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fillForm();
    });
    return btn;
  }

  // Находим строку "Сотрудник" по тексту заголовка, а не по data-test-id —
  // тот же data-test-id используется на других side-панелях приложения.
  function findEmployeeRow() {
    const items = document.querySelectorAll('[data-test-id="side-page__info-item"]');
    for (const item of items) {
      const title = item.querySelector('.info-title');
      if (title && title.textContent.trim() === 'Сотрудник') {
        return item;
      }
    }
    return null;
  }

  // ---------- Имя оператора для бланка инкассации ----------
  // В акте есть строка «Хужалик юритувчи субъект рахбари» — фамилия того,
  // кто сдаёт деньги. В банке её сверяют, и подставлять туда чужую фамилию
  // из образца нельзя. WMS показывает её в левом нижнем углу в том самом
  // виде, в каком она должна попасть в бланк: «MURODOV M.».
  //
  // Ищем по ФОРМЕ значения, а не по классу: вёрстка WMS меняется от релиза
  // к релизу, а «ФАМИЛИЯ И.» — не меняется. Чтобы не поймать похожую строку
  // из таблицы заказов, берём только то, что стоит в нижней левой четверти
  // окна, и только самый глубокий узел с таким текстом.
  const WMS_NAME_RE = /^[A-ZА-ЯЁ][A-ZА-ЯЁ'`\-]{1,}\s+[A-ZА-ЯЁ]\.$/;
  let lastSyncedName = null;

  // ПОЛНОЕ ФИО — для актов на диагностику и приёма-передачи. Там подпись
  // стоит целиком: «MURODOV MUHAMMADSAID BAXTIYOR O'G'LI», а не «MURODOV M.».
  // Ищем его тоже по форме, но с якорем: первое слово ОБЯЗАНО совпасть с
  // фамилией из короткого имени, которое мы уже нашли в левом нижнем углу.
  // Без этого якоря сюда попадало бы любое написанное капслоком название из
  // таблицы заказов; с ним — только строка про того же человека.
  const WMS_FULL_RE = /^[A-ZА-ЯЁ][A-ZА-ЯЁ'`ʻ’\-]{1,}(?:\s+[A-ZА-ЯЁ][A-ZА-ЯЁ'`ʻ’\-]{1,}){1,4}$/;
  let lastSyncedFullName = null;

  function findOperatorName() {
    const h = window.innerHeight, w = window.innerWidth;
    let best = null;
    for (const el of document.body.querySelectorAll('*')) {
      if (el.children.length) continue;                 // только листовые узлы
      const text = (el.textContent || '').trim();
      if (text.length > 40 || !WMS_NAME_RE.test(text)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.top < h * 0.6 || r.left > w * 0.45) continue;   // не левый низ — не оно
      // Из нескольких кандидатов берём самый нижний и самый левый.
      const score = r.top - r.left * 0.2;
      if (!best || score > best.score) best = { text, score };
    }
    return best ? best.text : null;
  }

  /** Полное ФИО того же человека: первое слово — фамилия из короткого имени. */
  function findOperatorFullName(shortName) {
    const surname = String(shortName || '').split(/\s+/)[0];
    if (!surname || surname.length < 3) return null;
    let best = null;
    for (const el of document.body.querySelectorAll('*')) {
      // Полное ФИО часто висит в подсказке, а на экране обрезано многоточием.
      const candidates = [el.getAttribute && el.getAttribute('title'),
                          el.getAttribute && el.getAttribute('aria-label'),
                          el.children.length ? null : el.textContent];
      for (const raw of candidates) {
        const text = (raw || '').trim().replace(/\s+/g, ' ');
        if (!text || text.length > 70) continue;
        if (WMS_NAME_RE.test(text)) continue;             // это короткая форма
        if (!WMS_FULL_RE.test(text)) continue;
        if (text.split(' ')[0] !== surname) continue;     // другой человек
        // Из нескольких вариантов берём самый полный: обрезанный вариант
        // подписать акт не годится.
        if (!best || text.length > best.length) best = text;
      }
    }
    return best;
  }

  function syncOperatorName() {
    const name = findOperatorName();
    if (!name || name === lastSyncedName) return;
    lastSyncedName = name;
    try {
      chrome.storage.local.set({ wmsUserName: name, wmsUserNameAt: Date.now() }, () => {
        if (chrome.runtime.lastError) return;
        console.log(`${LOG_PREFIX} имя для бланка инкассации: ${name}`);
      });
    } catch (err) {
      if (!isContextInvalidated(err)) console.error(`${LOG_PREFIX} не удалось прочитать имя оператора:`, err);
    }
  }

  function syncOperatorFullName() {
    const full = findOperatorFullName(lastSyncedName || findOperatorName());
    if (!full || full === lastSyncedFullName) return;
    lastSyncedFullName = full;
    try {
      chrome.storage.local.set({ wmsUserFullName: full, wmsUserFullNameAt: Date.now() }, () => {
        if (chrome.runtime.lastError) return;
        console.log(`${LOG_PREFIX} полное ФИО для актов: ${full}`);
      });
    } catch (err) {
      if (!isContextInvalidated(err)) console.error(`${LOG_PREFIX} не удалось прочитать ФИО оператора:`, err);
    }
  }

  // ---------- Автоматическое чтение "Сумма в WMS" ----------
  // На главной странице "Касса" (когда смена уже открыта) сумма показана в
  // виджете work-shift-balance под заголовком "В кассе наличных" — это и есть
  // та величина, с которой оператор сверяет физический пересчёт купюр в
  // калькуляторе расширения. Текст выглядит как "5 135 659 сум" (с &nbsp;
  // или обычными пробелами как разделителями тысяч), поэтому парсим только
  // цифры и отбрасываем всё остальное.
  //
  // ЭФФЕКТИВНЫЙ БАЛАНС (вычитаем "К инкассации"): "В кассе наличных" не
  // уменьшается в момент, когда кассир физически отдал деньги инкассатору —
  // WMS списывает эту сумму только по нажатию "Инкассировать" и подтверждению.
  // Пока это не сделано, физически в кассе уже меньше денег, чем показывает
  // "В кассе наличных", ровно на "К инкассации" (виджет .work-shift-blocked-balance).
  // Поэтому:
  //
  //     эффективный баланс = "В кассе наличных" − "К инкассации"
  //
  // Читаем оба числа заново при КАЖДОЙ синхронизации и ВСЕГДА вычитаем — по
  // подтверждению от пользователя, WMS обновляет "К инкассации" в DOM сразу
  // же по нажатию (без задержки/рассинхрона), так что отдельно детектировать
  // "инкассация подтверждена / ещё нет" не нужно: как только она подтверждена,
  // "К инкассации" сам станет 0, и вычитание нуля ничего не испортит.
  //
  // Если виджета "К инкассации" нет в DOM вообще — считаем его равным 0
  // (а не блокируем синхронизацию суммы кассы целиком). Это предположение:
  // сейчас нет подтверждения, всегда ли этот виджет рендерится (в т.ч. с
  // "0 сум") или пропадает из DOM, когда инкассировать нечего — если оно
  // неверное, в консоли будет видно расхождение.
  const WMS_BALANCE_STORAGE_KEY = 'wmsBalanceFromDom';
  let lastSyncedWmsKey = null;

  function parseWmsBalanceText(text) {
    const digitsOnly = (text || '').replace(/\D/g, '');
    if (!digitsOnly) return null;
    const value = parseInt(digitsOnly, 10);
    return Number.isFinite(value) ? value : null;
  }

  function readBalanceBySelector(selector) {
    const el = document.querySelector(selector);
    return el ? parseWmsBalanceText(el.textContent) : null;
  }

  function syncWmsBalanceFromDom() {
    const cashValue = readBalanceBySelector('.work-shift-balance .balance');
    if (cashValue === null) return; // смены нет / не на странице кассы — ничего не трогаем

    const blockedValue = readBalanceBySelector('.work-shift-blocked-balance .balance') ?? 0;
    const effective = Math.max(0, cashValue - blockedValue);

    // Дедуп по ОБОИМ сырым числам, а не по итоговой разнице — иначе если
    // касса и "к инкассации" одновременно изменятся на одну и ту же сумму
    // (эффективный баланс совпадёт со старым), обновление молча потеряется.
    const syncKey = `${cashValue}|${blockedValue}`;
    if (syncKey === lastSyncedWmsKey) return;
    lastSyncedWmsKey = syncKey;

    try {
      chrome.storage.local.set({
        [WMS_BALANCE_STORAGE_KEY]: effective,
        wmsCashInRegister: cashValue,
        wmsPendingEncashment: blockedValue,
        wmsBalanceFromDomAt: Date.now()
      }, () => {
        if (chrome.runtime.lastError) {
          console.error(`${LOG_PREFIX} ошибка сохранения суммы из кассы —`, chrome.runtime.lastError.message);
          return;
        }
        console.log(`${LOG_PREFIX} "Сумма в WMS" обновлена: касса ${cashValue} − к инкассации ${blockedValue} = ${effective}`);
      });
    } catch (err) {
      if (isContextInvalidated(err)) {
        // Расширение перезагрузили при открытой вкладке — молча пропускаем,
        // это не критично (не мешает работе формы "Начать работу"), а
        // навязчивый alert на каждое изменение баланса был бы избыточен.
        console.warn(`${LOG_PREFIX} расширение обновлено — синхронизация суммы WMS приостановлена до обновления страницы.`);
      } else {
        console.error(`${LOG_PREFIX} неожиданная ошибка при синхронизации суммы WMS:`, err);
      }
    }
  }

  function injectButtonIfNeeded() {
    // Проверяем, что на странице реально открыта форма "Начать работу",
    // а не какая-то другая side-панель.
    if (!document.querySelector('.form-cash')) return;

    const row = findEmployeeRow();
    if (!row) return;

    // ЧИНИМ ЗДЕСЬ: раньше кнопка вставлялась ВНУТРЬ самого блока "Сотрудник"
    // и переводила его в display:flex, из-за чего заголовок "Сотрудник" и имя
    // сотрудника (например, "MURODOV M.") оказывались прижаты друг к другу в
    // одну строку вместо родного вида (заголовок сверху, имя снизу), а кнопка
    // висела прямо рядом с именем. Теперь блок "Сотрудник" не трогаем вообще —
    // кнопку добавляем в его родительский контейнер (общую строку с другими
    // инфо-блоками side-панели), последним элементом. За счёт margin-left:auto
    // в стилях кнопки это ставит её в конец строки, не мешая соседним блокам.
    const targetRow = row.parentElement || row;
    if (targetRow.querySelector(`[${INJECTED_ATTR}]`)) return; // уже вставлено

    const targetDisplay = window.getComputedStyle(targetRow).display;
    if (!/flex/.test(targetDisplay)) {
      // Подстраховка на случай, если родительский контейнер сам по себе не
      // горизонтальный — тогда включаем flex именно на нём (а не на блоке
      // "Сотрудник"), чтобы margin-left:auto кнопки сработал как задумано.
      targetRow.style.display = 'flex';
      targetRow.style.alignItems = 'center';
    }

    targetRow.appendChild(createFillButton());
    console.log(`${LOG_PREFIX} кнопка "Заполнить" добавлена в панель "Начать работу".`);
  }

  // Панель открывается динамически (без перезагрузки страницы),
  // поэтому следим за изменениями DOM.
  const observer = new MutationObserver(() => {
    injectButtonIfNeeded();
    syncWmsBalanceFromDom();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  console.log(`${LOG_PREFIX} наблюдатель за DOM запущен, жду появления панели "Начать работу".`);

  // На случай, если content script загрузился уже при открытой панели
  // или на уже открытой смене (главная страница "Касса").
  injectButtonIfNeeded();
  syncWmsBalanceFromDom();

  // Имя в углу не меняется в течение смены, а обход всех узлов страницы —
  // не то, что стоит делать на каждое изменение DOM. Смотрим редко.
  const syncNames = () => { syncOperatorName(); syncOperatorFullName(); };
  syncNames();
  setInterval(syncNames, 60_000);
})();
// ==========================================
// ПРИЁМКА: связь расширения с WMS
// ==========================================
// Отдельный IIFE — логика инкассации выше не затронута ни одной строкой.
//
// ЧТО ЗДЕСЬ ОСТАЛОСЬ И ЧЕГО БОЛЬШЕ НЕТ.
//
// Раньше этот блок непрерывно подслушивал страницу: копировал каждый ответ
// WMS, разбирал его наугад, запоминал «шаблоны запросов», подчищал DOM. Из
// этого рождался мусор в таблице, а каждая новая заплатка порождала
// следующую. Данные теперь приходят ТОЛЬКО двумя путями:
//
//   1) оператор нажал кнопку сбора — расширение само спрашивает WMS по
//      известным адресам (см. WMS-API-NOTES.md), а страница лишь выполняет
//      запрос своими руками, потому что у неё живой токен;
//   2) оператор загрузил CSV-выгрузку из WMS.
//
// Здесь остались ровно три вещи:
//   * переслать в расширение заголовок авторизации, увиденный перехватчиком;
//   * запомнить номер ПВЗ (он есть в адресе любого запроса WMS);
//   * мост: попросить страницу выполнить запрос и вернуть ответ.
//
// Ничего не разбирается и ничего не сохраняется в таблицу — это делает
// background.js, и только по нажатию.

(function () {
  'use strict';

  const LOG_PREFIX = '[U-Core Приёмка]';
  const CHANNEL = 'ucore-wms';

  function contextInvalidated(err) {
    return /Extension context invalidated|message port closed/i.test(String(err && err.message || err));
  }

  // ---------- мост: расширение просит страницу сходить за данными ----------
  // Запрос выполняет САМА СТРАНИЦА: у неё правильный origin и свежий токен,
  // который приложение обновляет само. Расширение ничего не имитирует.

  const pageFetches = new Map();
  let fetchSeq = 0;

  function askPageToFetch(url, options = {}, timeoutMs = 30000) {
    return new Promise((resolve) => {
      const id = `f${++fetchSeq}_${Date.now()}`;
      const timer = setTimeout(() => {
        pageFetches.delete(id);
        resolve({ ok: false, error: 'страница не ответила вовремя' });
      }, timeoutMs);
      pageFetches.set(id, { resolve, timer });
      try {
        window.postMessage({
          __ucore: 'ucore-fetch', id, url,
          method: options.method || 'GET',
          body: options.body || null
        }, location.origin);
      } catch (err) {
        clearTimeout(timer);
        pageFetches.delete(id);
        resolve({ ok: false, error: 'не удалось передать запрос странице' });
      }
    });
  }

  // ---------- сообщения от перехватчика ----------

  let lastDpKey = null;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__ucore !== CHANNEL || !data.entry) return;

    // Ответ на запрос, который расширение попросило сделать страницу.
    if (data.entry.__fetchResult) {
      const pending = pageFetches.get(data.entry.__fetchResult.id);
      if (pending) {
        pageFetches.delete(data.entry.__fetchResult.id);
        clearTimeout(pending.timer);
        pending.resolve(data.entry.__fetchResult);
      }
      return;
    }

    // Заголовок авторизации. Значения не печатаем: это учётные данные.
    if (data.entry.__authHeaders) {
      try {
        chrome.storage.local.set({
          priemkaAuth: { headers: data.entry.__authHeaders, at: Date.now(), origin: location.origin }
        }, () => {
          if (chrome.runtime.lastError) return;
          console.log(`${LOG_PREFIX} авторизация подхвачена`);
        });
      } catch (err) {
        if (!contextInvalidated(err)) console.warn(`${LOG_PREFIX} не удалось сохранить авторизацию`);
      }
    }
  });

  // ---------- адрес API и номер ПВЗ ----------
  // Два факта, которых нет в коде и не должно быть: на каком хосте живёт
  // API и какой у этого ПВЗ номер. Оба видны в адресах запросов, которые
  // страница делает сама. Ответы при этом НЕ читаются — только адреса.

  let lastApiBase = null;

  function noteFrom(url) {
    let parsed;
    try {
      parsed = new URL(url, location.href);
    } catch (e) {
      return;
    }

    // Хост API. У ТАШ-120 это api-wms.uzum.uz — НЕ тот, где открыта
    // страница. Зашивать его в код нельзя: этот проект уже пять раз молча
    // ломался из-за захардкоженного домена, и ни один тест до него не
    // дотягивался. Берём из адреса запроса, который страница сделала сама.
    if (/^\/(de|or)\//.test(parsed.pathname) && parsed.origin !== lastApiBase) {
      lastApiBase = parsed.origin;
      chrome.storage.local.set({ priemkaApiBase: parsed.origin });
    }

    // Номер ПВЗ. WMS передаёт его почти в каждом запросе — то как dpKey,
    // то как deliveryPointKey.
    const dp = parsed.searchParams.get('dpKey') || parsed.searchParams.get('deliveryPointKey');
    if (dp && /^\d+$/.test(dp) && dp !== lastDpKey) {
      lastDpKey = dp;
      chrome.storage.local.set({ priemkaDpKey: dp });
    }
  }

  // PerformanceObserver знает обо всех запросах страницы и ничего к ним не
  // добавляет: он не перехватывает, не копирует тела и не может ничего
  // сломать. Ровно то, что нужно, — увидеть адреса и больше ничего.
  try {
    const seen = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) noteFrom(entry.name);
    });
    seen.observe({ entryTypes: ['resource'] });
    for (const entry of performance.getEntriesByType('resource')) noteFrom(entry.name);
  } catch (e) { /* без него сбор просто попросит выбрать ПВЗ */ }

  // ---------- запросы из расширения ----------

  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.type === 'ucore:page-fetch') {
        askPageToFetch(message.url, { method: message.method, body: message.body })
          .then(sendResponse);
        return true;
      }
      return undefined;
    });
  } catch (err) {
    console.warn(`${LOG_PREFIX} не удалось подписаться на сообщения расширения:`, err);
  }

  // Сообщаем перехватчику, что слушатель готов: он встал раньше нас и мог
  // уже отправить авторизацию в пустоту (см. рукопожатие в wms-harvester.js).
  try {
    window.postMessage({ __ucore: 'ucore-ready' }, location.origin);
  } catch (err) { /* не критично: следующий же запрос страницы всё донесёт */ }

  console.log(`${LOG_PREFIX} мост к WMS готов (только чтение, только по кнопке).`);
})();
