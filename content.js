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

  // Кратковременная зелёная обводка — визуальное подтверждение, что поле заполнено.
  function flashSuccess(input) {
    if (!input) return;
    const prevOutline = input.style.outline;
    const prevTransition = input.style.transition;
    input.style.transition = 'outline-color 0.2s ease';
    input.style.outline = '2px solid #2e7d32';
    setTimeout(() => {
      input.style.outline = prevOutline;
      input.style.transition = prevTransition;
    }, 900);
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
      chrome.storage.local.get(['savedCounts', 'savedBagNumber'], (data) => {
        if (chrome.runtime.lastError) {
          console.error(`${LOG_PREFIX} ошибка чтения хранилища —`, chrome.runtime.lastError.message);
          alert('❌ Не удалось прочитать сохранённые данные из расширения.');
          return;
        }

        const counts = data.savedCounts || {};
        const bagNumber = data.savedBagNumber;
        console.log(`${LOG_PREFIX} читаю данные из хранилища:`, { bagNumber, counts });

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
          const count = counts[denom];
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

        console.log(`${LOG_PREFIX} заполнено полей номиналов:`, filledCount);

        const hasSavedData = (bagNumber !== undefined && bagNumber !== '')
          || Object.keys(counts).some(k => counts[k] !== undefined && counts[k] !== '' && counts[k] !== '0');

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

  function createFillButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Заполнить (ПВЗ Помощник)';
    btn.setAttribute(INJECTED_ATTR, 'true');
    btn.style.cssText = [
      'margin-left: auto',
      'background: #7000ff',
      'color: #ffffff',
      'border: none',
      'border-radius: 6px',
      'padding: 6px 14px',
      'font-family: Inter, Arial, sans-serif',
      'font-weight: 600',
      'font-size: 12px',
      'cursor: pointer',
      'white-space: nowrap'
    ].join(';');
    btn.addEventListener('mouseenter', () => { btn.style.background = '#5a00cc'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#7000ff'; });
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

  function injectButtonIfNeeded() {
    // Проверяем, что на странице реально открыта форма "Начать работу",
    // а не какая-то другая side-панель.
    if (!document.querySelector('.form-cash')) return;

    const row = findEmployeeRow();
    if (!row) return;
    if (row.querySelector(`[${INJECTED_ATTR}]`)) return; // уже вставлено

    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.appendChild(createFillButton());
    console.log(`${LOG_PREFIX} кнопка "Заполнить" добавлена в панель "Начать работу".`);
  }

  // Панель открывается динамически (без перезагрузки страницы),
  // поэтому следим за изменениями DOM.
  const observer = new MutationObserver(() => injectButtonIfNeeded());
  observer.observe(document.body, { childList: true, subtree: true });
  console.log(`${LOG_PREFIX} наблюдатель за DOM запущен, жду появления панели "Начать работу".`);

  // На случай, если content script загрузился уже при открытой панели.
  injectButtonIfNeeded();
})();