// ==========================================
// 0. УТИЛИТЫ
// ==========================================

// Экранирование пользовательского ввода перед вставкой в HTML,
// который затем инжектится в активную вкладку (защита от HTML/скрипт-инъекций).
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

// Простой debounce, чтобы не долбить chrome.storage.local на каждое нажатие клавиши.
function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// Приводит значение поля к неотрицательному целому. Пустое поле оставляем
// пустым — это осознанное состояние ("ещё не введено"), а не 0.
function clampNonNegative(inputElement) {
  if (inputElement.value === '') return;
  const num = Number(inputElement.value);
  if (isNaN(num) || num < 0) {
    inputElement.value = 0;
  } else if (!Number.isInteger(num)) {
    inputElement.value = Math.floor(num);
  }
}

// ==========================================
// 1. ВКЛАДКИ
// ==========================================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

// ==========================================
// 2. КАЛЬКУЛЯТОР ИНКАССАЦИИ
// ==========================================
const DENOMINATIONS = [200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000];
const MIN_CASH_RESERVE = 500000;    // минимальный остаток, который должен оставаться в кассе ПВЗ
const DISCREPANCY_TOLERANCE = 5000; // допустимая погрешность перед тем, как считать это ошибкой

const container = document.getElementById('bill-inputs');
const wmsInput = document.getElementById('wms-total');
const bagNumberInput = document.getElementById('bag-number');
const formatSum = (num) => num.toLocaleString('ru-RU').replace(/,/g, ' ');

// Последний рассчитанный набор количеств купюр по номиналам — нужен, чтобы
// сохранять его вместе с номером сумки, даже если менялось только это поле.
let currentCounts = {};

// Единая точка сохранения состояния калькулятора в chrome.storage.local.
// Используется и калькулятором, и импортом — чтобы не было двух версий
// одной и той же логики сохранения.
const persistCalculatorState = debounce((counts, wmsValue, bagNumber) => {
  chrome.storage.local.set({ savedCounts: counts, savedWms: wmsValue, savedBagNumber: bagNumber }, () => {
    if (chrome.runtime.lastError) {
      console.error('Ошибка сохранения состояния:', chrome.runtime.lastError.message);
    }
  });
}, 400);

function attachInputBehaviors(inputElement) {
  inputElement.addEventListener('focus', (e) => e.target.select());
  inputElement.addEventListener('input', (e) => clampNonNegative(e.target));
  inputElement.addEventListener('blur', (e) => {
    if (e.target.value === '' || isNaN(e.target.value)) {
      e.target.value = '0';
      calculateTotals();
    }
  });
}

// Номер сумки — НЕ денежное поле: пустое значение не должно превращаться в "0"
// на blur (0 выглядел бы как реальный номер сумки), и его изменение не должно
// пересчитывать вердикт/контроль кассы — это про другое поле.
function attachBagNumberBehaviors(inputElement) {
  inputElement.addEventListener('focus', (e) => e.target.select());
  inputElement.addEventListener('input', (e) => {
    clampNonNegative(e.target);
    persistCalculatorState(currentCounts, wmsInput.value, bagNumberInput.value);
  });
}

// Стрелки Вверх/Вниз двигают фокус между полями (номинал за номиналом,
// с "Сумма в WMS:" и "Номер сумки" последними полями снизу), а не крутят
// значение вверх/вниз, как это делают нативные number-инпуты.
function setupArrowNavigation(inputs) {
  inputs.forEach((input, idx) => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault(); // блокируем нативное изменение числа стрелками

      const targetIndex = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
      const target = inputs[targetIndex];
      if (target) target.focus();
    });
  });
}

DENOMINATIONS.forEach(denom => {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `
    <div style="font-weight: 500;">${formatSum(denom)}</div>
    <div><input type="number" class="fact-input" data-denom="${denom}" value="0" min="0"></div>
    <div class="readonly-box" id="encash-${denom}">0</div>
    <div class="readonly-box" id="change-${denom}">0</div>
  `;
  container.appendChild(row);
  attachInputBehaviors(row.querySelector('.fact-input'));
});
attachInputBehaviors(wmsInput);
attachBagNumberBehaviors(bagNumberInput);

const navigableInputs = [...document.querySelectorAll('.fact-input'), wmsInput, bagNumberInput];
setupArrowNavigation(navigableInputs);

container.addEventListener('input', calculateTotals);
wmsInput.addEventListener('input', calculateTotals);

function calculateTotals() {
  const wmsTotal = Math.max(0, Number(wmsInput.value) || 0);
  let totalFact = 0, counts = {};

  document.querySelectorAll('.fact-input').forEach(input => {
    const denom = Number(input.dataset.denom);
    const count = Math.max(0, Number(input.value) || 0);
    totalFact += denom * count;
    counts[denom] = input.value;
  });

  const targetEncashment = totalFact - MIN_CASH_RESERVE;
  let currentEncashmentSum = 0, totalEncashment = 0, totalChange = 0;

  DENOMINATIONS.forEach(denom => {
    const count = Number(counts[denom]) || 0;
    const remainingTarget = targetEncashment - currentEncashmentSum;

    let encashCount = 0;
    if (remainingTarget > 0) encashCount = Math.min(count, Math.floor(remainingTarget / denom));

    const changeCount = count - encashCount;
    currentEncashmentSum += (encashCount * denom);
    totalEncashment += (encashCount * denom);
    totalChange += (changeCount * denom);

    document.getElementById(`encash-${denom}`).textContent = encashCount;
    document.getElementById(`change-${denom}`).textContent = changeCount;
  });

  const diff = totalFact - wmsTotal;
  let verdict = diff > DISCREPANCY_TOLERANCE
    ? "⚠️ Излишек"
    : (diff < -DISCREPANCY_TOLERANCE ? "❌ Недосдача" : (diff !== 0 ? "☑️ Незначительное расхождение" : "✅ Всё сошлось"));
  // Состояние для цвета чипа — считается из тех же условий, что и текст выше,
  // ничего в самой логике вердикта не меняет.
  let verdictState = diff > DISCREPANCY_TOLERANCE
    ? "warn"
    : (diff < -DISCREPANCY_TOLERANCE ? "bad" : (diff !== 0 ? "warn" : "ok"));

  let control = "✅ Всё сошлось";
  let controlState = "ok";
  if (totalFact < MIN_CASH_RESERVE) {
    control = "⚠️ В кассе меньше 500 тыс";
    controlState = "warn";
  } else if (Math.abs(targetEncashment - totalEncashment) > DISCREPANCY_TOLERANCE) {
    control = "❌ ОШИБКА в кассе!";
    controlState = "bad";
  } else if (targetEncashment !== totalEncashment) {
    control = "☑️ Незначительное расхождение";
    controlState = "warn";
  }

  document.getElementById('total-fact').textContent = formatSum(totalFact);
  document.getElementById('total-encash').textContent = formatSum(totalEncashment);
  document.getElementById('total-change').textContent = formatSum(totalChange);
  document.getElementById('diff').textContent = formatSum(diff);
  document.getElementById('verdict').textContent = verdict;
  document.getElementById('verdict').dataset.state = verdictState;
  document.getElementById('control').textContent = control;
  document.getElementById('control').dataset.state = controlState;

  currentCounts = counts;
  persistCalculatorState(counts, wmsInput.value, bagNumberInput.value);
}

// ==========================================
// 3. ИНФОЛИСТЫ (Шаблоны)
// ==========================================
const TEMPLATES = {
  fbo: { title: "ОТМЕНЕННЫЕ ЗАКАЗЫ FBO", fields: ['receiver'] },
  fbo_defect: { title: "ОТМЕНЕННЫЕ ЗАКАЗЫ FBO (БРАК)", fields: ['receiver'] },
  fbs: { title: "ОТМЕНЕННЫЕ ЗАКАЗЫ FBS", subtitle: "(Отмененные по причине: Отказ, Качество, Размер, Отмена заказа, Истек срок хранения)", fields: ['receiver'] },
  fbs_defect: { title: "ОТМЕНЕННЫЕ ЗАКАЗЫ FBS (БРАК)", fields: ['receiver'] },

  diagnostic: { title: "ТОВАР НА ДИАГНОСТИКУ В ОТДЕЛ СЕРВИСА", fields: ['order', 'barcode'] },
  uzum_bank: { title: "НЕВОСТРЕБОВАННЫЕ КАРТЫ UZUM BANK", listLabel: "Номера карт Uzum Bank:", showCount: true, countLabel: "Количество возвращаемых позиций в коробе:", fields: ['receiver', 'list'] },
  aliexpress: { title: "НЕВОСТРЕБОВАННЫЕ ЗАКАЗЫ ALIEXPRESS", listLabel: "Номера заказов/ШК товаров:", fields: ['receiver', 'list'] },
  uzum_global: { title: "НЕВОСТРЕБОВАННЫЕ ЗАКАЗЫ UZUM GLOBAL", listLabel: "Номера заказов/ШК товаров:", fields: ['receiver', 'list'] },
  canceled_earlier: { title: "РАНЕЕ ОТМЕНЕННЫЕ ЗАКАЗЫ", listLabel: "Номера заказов/ШК товаров:", fields: ['receiver', 'list'] },
  redirect: { title: "ПЕРЕНАПРАВЛЕНИЕ", listLabel: "Номера заказов/ШК товаров:", fields: ['receiver', 'list'] },
  unknown: { title: "НЕИЗВЕСТНЫЕ ТОВАРЫ", listLabel: "ШК товаров:", fields: ['receiver', 'list', 'unknown_count'] },
  kgt: { title: "КРУПНО-ГАБАРИТНЫЙ ТОВАР ОТГРУЖЕН В КОРОБ", fields: ['receiver', 'gm', 'barcode'] }
};

const select = document.getElementById('doc-type-select');
Object.keys(TEMPLATES).forEach(key => {
  const opt = document.createElement('option');
  opt.value = key; opt.textContent = TEMPLATES[key].title;
  select.appendChild(opt);
});

// Переключение видимости полей при смене шаблона
select.addEventListener('change', () => {
  const tpl = TEMPLATES[select.value];
  document.querySelectorAll('.dynamic-field').forEach(el => el.style.display = 'none');

  tpl.fields.forEach(f => {
    document.getElementById(`group-${f}`).style.display = 'flex';
  });

  if (tpl.fields.includes('list')) {
    document.getElementById('label-list').textContent = tpl.listLabel;
  }
});

// Устанавливаем сегодняшнюю дату
document.getElementById('input-date').valueAsDate = new Date();
select.dispatchEvent(new Event('change')); // Инициализируем первое состояние

// Проверка обязательных полей перед печатью — чтобы не печатать пустой бланк
function validateBeforePrint(tpl, data) {
  const missing = [];

  if (!data.sender.trim()) missing.push('ПВЗ Отправитель');
  if (!data.rawDate) missing.push('Дата отправки');

  if (tpl.fields.includes('receiver') && !data.receiver.trim()) missing.push('Куда');
  if (tpl.fields.includes('gm') && !data.gm.trim()) missing.push('ГМ короба');
  if (tpl.fields.includes('order') && !data.order.trim()) missing.push('Номер заказа');
  if (tpl.fields.includes('barcode') && !data.barcode.trim()) missing.push('ШК товара');
  if (tpl.fields.includes('list') && data.items.length === 0) missing.push('Список номеров/ШК');

  return missing;
}

// Кнопка печати
document.getElementById('btn-print').addEventListener('click', async () => {
  const tplKey = select.value;
  const tpl = TEMPLATES[tplKey];

  // Собираем данные
  const sender = document.getElementById('input-sender').value;
  const receiver = document.getElementById('input-receiver').value;

  // Форматируем дату (ГГГГ-ММ-ДД -> ДД.ММ.ГГГГ)
  const rawDate = document.getElementById('input-date').value;
  const dateArr = rawDate.split('-');
  const formattedDate = dateArr.length === 3 ? `${dateArr[2]}.${dateArr[1]}.${dateArr[0]}` : rawDate;

  const gm = document.getElementById('input-gm').value;
  const order = document.getElementById('input-order').value;
  const barcode = document.getElementById('input-barcode').value;
  const unknownCount = Math.max(0, Number(document.getElementById('input-unknown_count').value) || 0);

  const itemsText = document.getElementById('input-items').value.trim();
  const items = itemsText ? itemsText.split('\n').map(i => i.trim()).filter(i => i) : [];

  const missingFields = validateBeforePrint(tpl, { sender, rawDate, receiver, gm, order, barcode, items });
  if (missingFields.length > 0) {
    alert(`⚠️ Заполните обязательные поля:\n\n${missingFields.join('\n')}`);
    return;
  }

  // Сохраняем "Отправителя", чтобы не вводить каждый раз
  chrome.storage.local.set({ savedSender: sender }, () => {
    if (chrome.runtime.lastError) {
      console.error('Ошибка сохранения отправителя:', chrome.runtime.lastError.message);
    }
  });

  // Экранируем все пользовательские значения перед вставкой в HTML,
  // который будет инжектирован в активную вкладку.
  const safeSender = escapeHtml(sender);
  const safeReceiver = escapeHtml(receiver);
  const safeDate = escapeHtml(formattedDate);
  const safeGm = escapeHtml(gm);
  const safeOrder = escapeHtml(order);
  const safeBarcode = escapeHtml(barcode);
  const safeItems = items.map(escapeHtml);

  // ГЕНЕРИРУЕМ HTML ДЛЯ ПЕЧАТИ
  const printHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Печать инфолиста</title>
      <style>
        body { font-family: Arial, Helvetica, sans-serif; padding: 40px; color: #000; font-size: 18px; line-height: 1.6; }
        .logo { display: block; margin: 0 auto 30px auto; height: 60px; }
        .header { text-align: center; color: #7000ff; margin-bottom: 25px; }
        .header h1 { margin: 0; font-size: 28px; font-family: 'Arial Black', Impact, sans-serif; text-transform: uppercase; letter-spacing: 0.5px; }
        .header h2 { margin: 5px 0 0 0; font-size: 16px; font-weight: bold; font-family: Arial, sans-serif; }
        .sub-header { text-align: center; font-weight: bold; font-size: 20px; margin-bottom: 25px; color: #000; }
        .info-block p { margin: 8px 0; font-size: 19px; }
        .list-block { margin-top: 15px; font-size: 19px; }
      </style>
    </head>
    <body>
      <img class="logo" src="${chrome.runtime.getURL('uzum_logo.png')}">

      <div class="header">
        <h1>${escapeHtml(tpl.title)}</h1>
        ${tpl.subtitle ? `<h2>${escapeHtml(tpl.subtitle)}</h2>` : ''}
      </div>

      <div class="sub-header">Информационный лист</div>

      <div class="info-block">
        <p><strong>ПВЗ Отправитель:</strong> ${safeSender}</p>
        ${tpl.fields.includes('receiver') ? `<p><strong>Куда:</strong> ${safeReceiver}</p>` : ''}
        <p><strong>Дата отправки:</strong> ${safeDate}</p>

        ${tpl.fields.includes('gm') ? `<p><strong>ГМ короба:</strong> ${safeGm}</p>` : ''}
        ${tpl.fields.includes('order') ? `<p><strong>Номер заказа:</strong> ${safeOrder}</p>` : ''}
        ${tpl.fields.includes('barcode') ? `<p><strong>ШК товара:</strong> ${safeBarcode}</p>` : ''}

        ${tpl.showCount ? `<p><strong>${escapeHtml(tpl.countLabel)}</strong> ${safeItems.length}</p>` : ''}
      </div>

      ${tpl.fields.includes('list') ? `
        <div class="list-block">
          <strong>${escapeHtml(tpl.listLabel)}</strong>
          <div style="margin-top: 10px; line-height: 1.5;">${safeItems.join('<br>')}</div>
        </div>
      ` : ''}

      ${tpl.fields.includes('unknown_count') ? `
        <div class="list-block" style="margin-top: 20px;">
          <strong>Количество товаров без ШК:</strong> ${unknownCount}
        </div>
      ` : ''}
    </body>
    </html>
  `;

  // ВНЕДРЕНИЕ И ПЕЧАТЬ В ТЕКУЩЕЙ ВКЛАДКЕ
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || tab.url.startsWith('chrome://')) {
      alert("⚠️ Откройте вкладку с любой рабочей страницей (например, WMS), чтобы принтер сработал корректно.");
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (html) => {
        const iframe = document.createElement('iframe');
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = 'none';
        iframe.style.zIndex = '-9999';
        document.body.appendChild(iframe);

        const doc = iframe.contentWindow.document;
        doc.open();
        doc.write(html);
        doc.close();

        setTimeout(() => {
          iframe.contentWindow.focus();
          iframe.contentWindow.print();

          setTimeout(() => iframe.remove(), 2000);
        }, 300);
      },
      args: [printHTML]
    });
  } catch (err) {
    alert("❌ Ошибка печати! Убедитесь, что в manifest.json есть права 'activeTab' и 'scripting'.");
    console.error(err);
  }
});

// ==========================================
// 4. ПЕРЕНОС ДАННЫХ МЕЖДУ КОМПЬЮТЕРАМИ (Экспорт / Импорт)
// ==========================================
// Экспортирует текущие купюры + сумму WMS + номер сумки в текстовый JSON-код,
// который можно скопировать и вставить в расширение на другом компьютере.
// Импорт пишет ровно в те же ключи chrome.storage.local, которые уже читает
// content.js на dp.uzum.uz — поэтому после импорта кнопка "Заполнить" на
// другом компьютере сразу подставит перенесённые данные, без каких-либо
// дополнительных действий.

const EXPORT_TYPE = 'uzum_pvz_incasso_export';
const EXPORT_VERSION = 1;

const exportOutput = document.getElementById('export-output');
const importInput = document.getElementById('import-input');
const exportStatus = document.getElementById('export-status');
const importStatus = document.getElementById('import-status');

function showTransferStatus(el, text, isError) {
  el.textContent = text;
  el.style.color = isError ? '#c62828' : '#2e7d32';
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.textContent = ''; }, 2500);
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    return false;
  }
}

function buildExportPayload() {
  const counts = {};
  document.querySelectorAll('.fact-input').forEach(input => {
    counts[input.dataset.denom] = input.value || '0';
  });

  return {
    type: EXPORT_TYPE,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    bagNumber: bagNumberInput.value || '',
    wmsTotal: wmsInput.value || '0',
    counts
  };
}

document.getElementById('btn-export').addEventListener('click', async () => {
  const payload = buildExportPayload();
  exportOutput.value = JSON.stringify(payload, null, 2);
  exportOutput.select();

  const copied = await copyTextToClipboard(exportOutput.value);
  showTransferStatus(exportStatus, copied ? 'Готово, скопировано ✅' : 'Готово. Нажмите «Скопировать»', false);
});

document.getElementById('btn-copy-export').addEventListener('click', async () => {
  if (!exportOutput.value.trim()) {
    showTransferStatus(exportStatus, 'Сначала нажмите «Экспортировать»', true);
    return;
  }
  exportOutput.select();
  const copied = await copyTextToClipboard(exportOutput.value);
  if (copied) {
    showTransferStatus(exportStatus, 'Скопировано ✅', false);
  } else {
    const ok = document.execCommand('copy');
    showTransferStatus(exportStatus, ok ? 'Скопировано ✅' : 'Выделите текст и нажмите Ctrl+C', !ok);
  }
});

document.getElementById('btn-import').addEventListener('click', () => {
  const raw = importInput.value.trim();
  if (!raw) {
    showTransferStatus(importStatus, 'Вставьте данные для импорта', true);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    showTransferStatus(importStatus, '❌ Ошибка JSON — проверьте, что код скопирован полностью', true);
    return;
  }

  if (!payload || payload.type !== EXPORT_TYPE || typeof payload.counts !== 'object') {
    showTransferStatus(importStatus, '❌ Формат данных не распознан', true);
    return;
  }

  DENOMINATIONS.forEach(denom => {
    const input = document.querySelector(`.fact-input[data-denom="${denom}"]`);
    if (input && payload.counts[denom] !== undefined) {
      input.value = payload.counts[denom];
      clampNonNegative(input);
    }
  });

  if (payload.wmsTotal !== undefined) {
    wmsInput.value = payload.wmsTotal;
    clampNonNegative(wmsInput);
  }
  if (payload.bagNumber !== undefined) {
    bagNumberInput.value = payload.bagNumber;
    clampNonNegative(bagNumberInput);
  }

  calculateTotals(); // пересчитывает UI и одним вызовом сохраняет всё в chrome.storage.local

  importInput.value = '';
  showTransferStatus(importStatus, '✅ Импортировано и сохранено', false);
});

// ==========================================
// 5. ЗАГРУЗКА СОСТОЯНИЯ ПРИ СТАРТЕ
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['savedCounts', 'savedWms', 'savedSender', 'savedBagNumber'], (data) => {
    if (data.savedCounts) {
      document.querySelectorAll('.fact-input').forEach(input => {
        const denom = input.dataset.denom;
        if (data.savedCounts[denom] !== undefined) input.value = data.savedCounts[denom];
      });
    }
    if (data.savedWms !== undefined) wmsInput.value = data.savedWms;
    if (data.savedBagNumber !== undefined) bagNumberInput.value = data.savedBagNumber;
    calculateTotals();

    if (data.savedSender) document.getElementById('input-sender').value = data.savedSender;
  });
});