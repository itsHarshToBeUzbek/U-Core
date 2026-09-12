// ==========================================
// popup.js — UI расширения
// ==========================================
// Подключён как ES-модуль (см. popup.html), поэтому здесь доступен import.
// Ядро распределения по ячейкам живёт отдельным файлом и не знает ни про
// chrome.*, ни про DOM — его же гоняет `node test-allocation.mjs`.
import { AllocationEngine, PLACEMENT_REASONS, sizeTierFromDimensions } from './allocation-core.js';
import { recordsFromCsv } from './wms-csv.js';

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

// ---------- Денежное поле с разделителями тысяч "вживую" ----------
// type="number" физически не может показывать "1 910 709" — браузер обязан
// хранить в нём чистое число без пробелов. Поэтому для "Сумма в WMS" (может
// доходить до 7-8 значащих цифр) используем type="text" с ручным
// форматированием при вводе: пользователь видит и печатает как обычно, а
// внутри всегда остаётся чистая цифровая строка для расчётов/сохранения.
function rawDigits(str) {
  return (str || '').replace(/\D/g, '');
}

function formatDigitsForDisplay(digits) {
  if (!digits) return '';
  return Number(digits).toLocaleString('ru-RU').replace(/,/g, ' ');
}

// Читает денежное поле как чистое число, независимо от того, отформатировано
// оно пробелами или нет.
function getMoneyInputValue(inputEl) {
  return Number(rawDigits(inputEl.value)) || 0;
}

// Программно проставляет значение денежного поля с готовым форматированием
// (используется при автоподстановке из кассы, восстановлении сохранённого
// состояния и импорте — везде, где значение приходит не от живого ввода).
function setMoneyInputValue(inputEl, rawValue) {
  inputEl.value = formatDigitsForDisplay(rawDigits(String(rawValue ?? '')));
}

// Обработчик события 'input' — переформатирует по мере набора, сохраняя
// позицию курсора ОТНОСИТЕЛЬНО КОНЦА строки, а не начала: иначе при вводе
// в середину уже введённого числа курсор "прыгал" бы каждый раз, когда
// добавляется или пропадает разделяющий пробел.
function formatMoneyInputLive(inputEl) {
  const digits = rawDigits(inputEl.value);
  const distanceFromEnd = inputEl.value.length - inputEl.selectionStart;
  inputEl.value = formatDigitsForDisplay(digits);
  const newPos = Math.max(0, inputEl.value.length - distanceFromEnd);
  inputEl.setSelectionRange(newPos, newPos);
}

// ==========================================
// 1. ВКЛАДКИ
// ==========================================
const tabsBar = document.getElementById('tabs');
const tabsIndicator = document.getElementById('tabsIndicator');
const tabBtns = document.querySelectorAll('.tab-btn');

function moveIndicatorTo(btn, animate = true) {
  if (!btn || !tabsIndicator) return;
  tabsIndicator.style.transition = animate
    ? 'transform .32s cubic-bezier(.65,0,.35,1), width .32s cubic-bezier(.65,0,.35,1)'
    : 'none';
  tabsIndicator.style.width = `${btn.offsetWidth}px`;
  tabsIndicator.style.transform = `translateX(${btn.offsetLeft}px)`;
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn, .tab-content').forEach(el => el.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    moveIndicatorTo(btn, true);
    // Если вкладка выходит за видимую область — плавно докручиваем к ней
    btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    setTimeout(markTabOverflow, 350);
  });
});

// Какие края полосы вкладок ещё можно прокрутить. Полосу прокрутки мы
// прячем, поэтому единственный признак, что за краем что-то есть, — это
// растворение полосы в фон; ставим его по фактическому положению.
function markTabOverflow() {
  if (!tabsBar) return;
  const max = tabsBar.scrollWidth - tabsBar.clientWidth;
  const at = tabsBar.scrollLeft;
  const flags = [];
  if (at > 2) flags.push('start');
  if (at < max - 2) flags.push('end');
  const bar = document.getElementById('tabsbar') || tabsBar;
  bar.dataset.scroll = flags.join(' ');
}
if (tabsBar) {
  tabsBar.addEventListener('scroll', markTabOverflow, { passive: true });
  window.addEventListener('resize', markTabOverflow);
  markTabOverflow();
}

// Ставим индикатор под активную вкладку сразу при открытии попапа
// (без анимации — иначе он "приедет" из левого угла при каждом открытии)
function initTabIndicator() {
  const activeBtn = document.querySelector('.tab-btn.active');
  moveIndicatorTo(activeBtn, false);
}
// Скрипт подключён в конце body, поэтому DOM уже готов — считаем сразу,
// а 'load' держим как подстраховку (иконки/шрифты могут чуть сдвинуть layout).
initTabIndicator();
markTabOverflow();
window.addEventListener('load', () => { initTabIndicator(); markTabOverflow(); });
// Шрифт Manrope грузится асинхронно — после его подгрузки ширины кнопок
// могут чуть измениться, поэтому пересчитываем индикатор без анимации.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => moveIndicatorTo(document.querySelector('.tab-btn.active'), false));
}
window.addEventListener('resize', () => moveIndicatorTo(document.querySelector('.tab-btn.active'), false));

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
// currentCounts — это ВСЕ купюры "по факту" (инкассация + то, что остаётся
// как сдача/резерв в кассе). currentEncashCounts — только та часть, которая
// реально идёт на инкассацию (та же логика, что и колонка "Инкассация" в
// таблице). Расширение на dp.uzum.uz должно подставлять в форму WMS именно
// currentEncashCounts, а не currentCounts — иначе туда попадали бы и деньги,
// которые остаются на сдачу.
let currentCounts = {};
let currentEncashCounts = {};
let currentBlocked = false;      // авто-расчёт отключён: недосдача больше сдачи
let cashZeroMode = false;        // «обнулить кассу» — сдачу не оставляем
let bagSavedAt = 0;              // когда номер мешка вводили в последний раз
let bagLoadedValue = '';         // что подставилось при открытии
let staleBagHint = null;         // номер, который НЕ подставили — слишком старый

// Единая точка сохранения состояния калькулятора в chrome.storage.local.
// Используется и калькулятором, и импортом — чтобы не было двух версий
// одной и той же логики сохранения.
const persistCalculatorState = debounce((counts, encashCounts, wmsValue, bagNumber) => {
  chrome.storage.local.set({
    savedCounts: counts,
    savedEncashCounts: encashCounts,
    savedWms: wmsValue,
    savedBagNumber: bagNumber,
    savedBagAt: bagSavedAt,
    // Расширение на dp.uzum.uz читает этот флаг и НЕ заполняет форму, когда
    // авто-расчёт отключён: подставить в кассу числа, которые сами себе
    // противоречат, хуже, чем не подставить ничего.
    savedEncashBlocked: currentBlocked,
    cashZeroMode
  }, () => {
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

function attachMoneyInputBehaviors(inputElement) {
  inputElement.addEventListener('focus', (e) => e.target.select());
  inputElement.addEventListener('input', (e) => formatMoneyInputLive(e.target));
  inputElement.addEventListener('blur', (e) => {
    if (rawDigits(e.target.value) === '') {
      e.target.value = '0';
      calculateTotals();
    }
  });
}

// Номер сумки — НЕ денежное поле: пустое значение не должно превращаться в "0"
// на blur (0 выглядел бы как реальный номер сумки), и его изменение не должно
// пересчитывать вердикт/контроль кассы — это про другое поле.
/**
 * ПРЕДЫДУЩИЙ ДЕНЬ ИНКАССАЦИИ — НЕ ВСЕГДА ВЧЕРА.
 *
 * В воскресенье инкассация не приезжает, поэтому «вчерашний мешок» в
 * понедельник — это субботний. Считать календарное «вчера» значит один раз
 * в неделю называть свежий номер устаревшим, а устаревший — свежим.
 */
function previousCollectionDay(from) {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0);
  return d;
}

function sameDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

const DAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
function dayLabel(date) {
  const d = new Date(date);
  return `${DAY_SHORT[d.getDay()]}, ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * «с позавчера» / «с чт, 04.09» — по какой день номер держится неизменным.
 * Позавчера считаем тоже по дням инкассации: в понедельник позавчерашний
 * день — пятница, потому что в воскресенье инкассация не приезжает.
 */
function sinceLabel(at) {
  if (!at) return 'неизвестно с какого дня';
  const beforeYesterday = previousCollectionDay(previousCollectionDay(Date.now()));
  if (sameDay(at, beforeYesterday)) return `с позавчерашнего дня (${dayLabel(at)})`;
  return `с ${dayLabel(at)}`;
}

/**
 * НОМЕР МЕШКА — САМОЕ НЕЗАМЕТНОЕ ПОЛЕ И САМАЯ ДОРОГАЯ ОШИБКА.
 *
 * Мешок каждый день новый, а поле хранит вчерашний номер и выглядит
 * заполненным. Оператор его не перечитывает — и в банк уходит акт с чужим
 * номером. Поэтому:
 *   * вчерашний номер подставляется, но об этом сказано вслух, и надпись
 *     держится до тех пор, пока номер не сменят: мешок меняют каждый день
 *     инкассации, поэтому вчерашний — почти наверняка ещё живой;
 *   * номер позавчерашний, старше или НЕИЗВЕСТНО КОГДА введённый не
 *     подставляется вовсе — за него нельзя поручиться, а пустое поле
 *     честнее подозрительного;
 *   * «вчера» и «позавчера» считаются по дням инкассации: воскресенья
 *     в них нет.
 */
function bagState() {
  const now = Date.now();
  const value = bagNumberInput.value.trim();
  if (!value) return { kind: 'empty' };
  if (value !== bagLoadedValue) return { kind: 'fresh' };
  if (!bagSavedAt) return { kind: 'unknown' };
  if (sameDay(bagSavedAt, now)) return { kind: 'today' };
  if (sameDay(bagSavedAt, previousCollectionDay(now))) return { kind: 'yesterday', at: bagSavedAt };
  return { kind: 'stale', at: bagSavedAt };
}

function renderBagNote() {
  const note = document.getElementById('bag-note');
  if (!note) return;
  const st = bagState();
  const text = {
    empty: '',
    fresh: '',
    today: '',
    unknown: 'Неизвестно, когда вводили этот номер — проверьте, что он с сегодняшнего мешка',
    yesterday: '',
    stale: ''
  }[st.kind];

  if (st.kind === 'yesterday') {
    note.textContent = `Это номер со вчерашней инкассации (${dayLabel(st.at)}) — смените на сегодняшний`;
    note.dataset.state = 'warn';
    note.style.display = 'block';
    bagNumberInput.dataset.state = 'warn';
    return;
  }
  if (st.kind === 'empty' && staleBagHint) {
    // Говорим не «старый», а С КАКОГО ДНЯ он не менялся: «с позавчера» —
    // это уже повод пойти и посмотреть на мешок, а «старый» ни к чему не
    // обязывает.
    note.textContent = `Мешок ${staleBagHint.number} не менялся ${sinceLabel(staleBagHint.at)}`
      + ' — подставлять его нельзя. Впишите номер сегодняшнего мешка';
    note.dataset.state = 'bad';
    note.style.display = 'block';
    return;
  }
  if (st.kind === 'stale') {
    note.textContent = `Этот номер не менялся ${sinceLabel(st.at)} — впишите номер сегодняшнего мешка`;
    note.dataset.state = 'bad';
    note.style.display = 'block';
    bagNumberInput.dataset.state = 'warn';
    return;
  }
  if (text) {
    note.textContent = text;
    note.dataset.state = 'warn';
    note.style.display = 'block';
    bagNumberInput.dataset.state = 'warn';
    return;
  }
  note.style.display = 'none';
  delete bagNumberInput.dataset.state;
}

function attachBagNumberBehaviors(inputElement) {
  inputElement.addEventListener('focus', (e) => e.target.select());
  inputElement.addEventListener('input', (e) => {
    clampNonNegative(e.target);
    // Номер сменили руками — с этой минуты он «сегодняшний».
    if (e.target.value.trim() && e.target.value.trim() !== bagLoadedValue) bagSavedAt = Date.now();
    renderBagNote();
    persistCalculatorState(currentCounts, currentEncashCounts, getMoneyInputValue(wmsInput), bagNumberInput.value);
  });
}

// КОЛЕСО МЫШИ НЕ МЕНЯЕТ ЧИСЛА.
//
// У number-инпута в фокусе колесо крутит значение. Попап длиннее экрана, и
// прокрутка к кнопке печати проходит ровно над полями: «Копий» уезжало с 3
// на 1, номиналы — на соседние числа, и заметить это нечем, потому что глаз
// в этот момент следит за кнопкой. Ни одно поле здесь не выигрывает от
// прокрутки колесом, поэтому глушим её на всей странице разом.
document.addEventListener('wheel', (event) => {
  const el = document.activeElement;
  if (!el || el.type !== 'number') return;
  if (el !== event.target && !el.contains(event.target)) return;
  event.preventDefault();
}, { passive: false, capture: true });

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
attachMoneyInputBehaviors(wmsInput);
attachBagNumberBehaviors(bagNumberInput);

const navigableInputs = [...document.querySelectorAll('.fact-input'), wmsInput, bagNumberInput];
setupArrowNavigation(navigableInputs);

container.addEventListener('input', calculateTotals);
wmsInput.addEventListener('input', calculateTotals);

function calculateTotals() {
  const wmsTotal = getMoneyInputValue(wmsInput);
  let totalFact = 0, counts = {};

  document.querySelectorAll('.fact-input').forEach(input => {
    const denom = Number(input.dataset.denom);
    const count = Math.max(0, Number(input.value) || 0);
    totalFact += denom * count;
    counts[denom] = input.value;
  });

  // СКОЛЬКО ДОЛЖНО УЙТИ В ИНКАССАЦИЮ.
  //
  // Считается от того, что выручкой считает WMS, а не от того, что насчитали
  // руками. Разница между ними — излишек или недосдача — ложится на СДАЧУ,
  // на те самые пятьсот тысяч: недостача сто тысяч оставляет в кассе
  // четыреста, излишек сто тысяч — шестьсот. Инкассация при этом не
  // «плавает» вслед за ошибкой счёта, а остаётся ровно той, что ждёт банк.
  //
  // Если же недосдача БОЛЬШЕ пятисот тысяч, покрывать её нечем: сдачи не
  // хватит даже целиком. Тогда авто-расчёт выключается совсем — раскладывать
  // купюры в этом случае значит подсказать оператору неверное действие с
  // деньгами, а он к тому же может этого не заметить.
  const reserve = cashZeroMode ? 0 : MIN_CASH_RESERVE;
  const base = (!cashZeroMode && wmsTotal > 0) ? wmsTotal : totalFact;
  const shortage = Math.max(0, base - totalFact);
  const blocked = !cashZeroMode && wmsTotal > 0 && shortage > reserve;

  let targetEncashment = blocked ? 0 : Math.min(totalFact, base - reserve);
  let currentEncashmentSum = 0, totalEncashment = 0, totalChange = 0;
  const encashCounts = {};

  DENOMINATIONS.forEach(denom => {
    const count = Number(counts[denom]) || 0;
    const remainingTarget = targetEncashment - currentEncashmentSum;

    let encashCount = 0;
    if (!blocked && remainingTarget > 0) encashCount = Math.min(count, Math.floor(remainingTarget / denom));

    const changeCount = count - encashCount;
    currentEncashmentSum += (encashCount * denom);
    totalEncashment += (encashCount * denom);
    totalChange += (changeCount * denom);
    encashCounts[denom] = encashCount;

    document.getElementById(`encash-${denom}`).textContent = blocked ? '—' : encashCount;
    document.getElementById(`change-${denom}`).textContent = blocked ? '—' : changeCount;
  });

  const diff = totalFact - wmsTotal;
  let verdict = diff > DISCREPANCY_TOLERANCE
    ? "⚠️ Излишек"
    : (diff < -DISCREPANCY_TOLERANCE ? "❌ Недосдача" : (diff !== 0 ? "🟡 Незначительное расхождение" : "✅ Всё сошлось"));
  // Состояние для цвета чипа — считается из тех же условий, что и текст выше,
  // ничего в самой логике вердикта не меняет.
  let verdictState = diff > DISCREPANCY_TOLERANCE
    ? "warn"
    : (diff < -DISCREPANCY_TOLERANCE ? "bad" : (diff !== 0 ? "warn" : "ok"));

  let control = "✅ Всё сошлось";
  let controlState = "ok";
  if (blocked) {
    // Самое важное сообщение во всей вкладке: деньги не сходятся настолько,
    // что автоматике здесь делать нечего.
    control = `❌ Недосдача ${formatSum(shortage)} — авто-расчёт отключён`;
    controlState = "bad";
  } else if (cashZeroMode) {
    control = "🔵 Обнуление кассы — всё в инкассацию";
    controlState = "warn";
  } else if (totalFact < MIN_CASH_RESERVE) {
    control = "⚠️ В кассе меньше 500 тыс";
    controlState = "warn";
  } else if (Math.abs(targetEncashment - totalEncashment) > DISCREPANCY_TOLERANCE) {
    control = "❌ ОШИБКА в кассе!";
    controlState = "bad";
  } else if (wmsTotal > 0 && Math.abs(totalChange - MIN_CASH_RESERVE) > DISCREPANCY_TOLERANCE) {
    // Сдача перестала быть ровно пятьюстами тысячами — это следствие
    // расхождения, и оператор должен знать, сколько он оставляет в кассе.
    control = `🟡 В кассе останется ${formatSum(totalChange)}`;
    controlState = "warn";
  } else if (targetEncashment !== totalEncashment) {
    control = "🟡 Незначительное расхождение";
    controlState = "warn";
  }

  document.getElementById('total-fact').textContent = formatSum(totalFact);
  document.getElementById('total-encash').textContent = formatSum(totalEncashment);
  document.getElementById('total-change').textContent = formatSum(totalChange);
  document.getElementById('diff').textContent = formatSum(diff);
  document.getElementById('diff').dataset.state = verdictState;
  document.getElementById('verdict').textContent = verdict;
  document.getElementById('verdict').dataset.state = verdictState;
  document.getElementById('control').textContent = control;
  document.getElementById('control').dataset.state = controlState;

  currentCounts = counts;
  currentEncashCounts = encashCounts;
  currentBlocked = blocked;
  renderBagNote();
  persistCalculatorState(counts, encashCounts, getMoneyInputValue(wmsInput), bagNumberInput.value);
}

// ==========================================
// 3. ИНФОЛИСТЫ
// ==========================================
// Сам бланк живёт в infolist-sheet.js и печатается на своей странице; здесь
// только форма. Три вещи, которых ей не хватало:
//
//   * ТИП ЛИСТА. Тринадцать названий в обычном <select> — это прокрутка
//     вслепую: они длинные, начинаются одинаково («ОТМЕНЕННЫЕ ЗАКАЗЫ…»)
//     и различаются в конце. Теперь список с поиском, и ищет он ещё и по
//     словам, которых в названии нет: «али», «кгт», «сервис».
//
//   * СПИСОК НОМЕРОВ. Была одна textarea. Пустая строка в ней давала пустую
//     позицию в коробе, а посчитать набранное можно было только глазами.
//     Теперь строка = поле: Enter открывает следующее, счётчик на виду,
//     повторы подсвечиваются. Вставка столбца из Excel сама разложится
//     по строкам.
//
//   * КОПИИ. Один и тот же лист часто нужен в двух экземплярах — в короб и
//     себе. Поле стоит рядом с датой, потому что решается это тогда же.

import {
  INFO_TEMPLATES, FIELD_LABELS, INFO_DEFAULTS, missingFields, layoutSheets, INFOLIST_CSS
} from './infolist-sheet.js';

const infoUi = {
  combo: document.getElementById('doc-combo'),
  btn: document.getElementById('doc-btn'),
  value: document.getElementById('doc-value'),
  panel: document.getElementById('doc-panel'),
  search: document.getElementById('doc-search'),
  list: document.getElementById('doc-list'),
  empty: document.getElementById('doc-empty'),
  rows: document.getElementById('list-rows'),
  count: document.getElementById('list-count'),
  add: document.getElementById('list-add'),
  labelList: document.getElementById('label-list'),
  warn: document.getElementById('il-warn'),
  print: document.getElementById('btn-print')
};

const infoState = { type: 'fbs', active: 0, matches: [] };

// ---------- выпадающий список с поиском ----------

/** Нормализация для поиска: регистр и «ё» не должны мешать найти. */
const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е').trim();

function templateEntries() {
  return Object.entries(INFO_TEMPLATES).map(([key, tpl]) => ({
    key, title: tpl.title, keywords: tpl.keywords || '',
    haystack: norm(`${tpl.title} ${tpl.keywords || ''} ${tpl.subtitle || ''}`)
  }));
}

function highlight(title, query) {
  const at = norm(title).indexOf(query);
  if (!query || at < 0) return escapeHtml(title);
  return escapeHtml(title.slice(0, at)) + '<mark>' + escapeHtml(title.slice(at, at + query.length))
       + '</mark>' + escapeHtml(title.slice(at + query.length));
}

function renderOptions(query) {
  const q = norm(query || '');
  // Слова ищем по отдельности: «фбс брак» должно находить лист про брак FBS.
  const words = q ? q.split(/\s+/).filter(Boolean) : [];
  infoState.matches = templateEntries().filter(e => words.every(w => e.haystack.includes(w)));
  infoUi.list.innerHTML = infoState.matches.map((e, i) => {
    const hit = e.keywords && q && !norm(e.title).includes(q) ? e.keywords : '';
    return `<button type="button" class="combo__opt" role="option" data-key="${e.key}"
      data-index="${i}" aria-selected="${e.key === infoState.type}"
      ${i === infoState.active ? 'data-active="1"' : ''}>${highlight(e.title, q)}
      ${hit ? `<small>${escapeHtml(hit)}</small>` : ''}</button>`;
  }).join('');
  infoUi.empty.hidden = infoState.matches.length > 0;
}

function moveActive(delta) {
  if (!infoState.matches.length) return;
  infoState.active = (infoState.active + delta + infoState.matches.length) % infoState.matches.length;
  renderOptions(infoUi.search.value);
  const node = infoUi.list.querySelector('[data-active="1"]');
  if (node) node.scrollIntoView({ block: 'nearest' });
}

function openCombo() {
  infoUi.panel.hidden = false;
  infoUi.btn.setAttribute('aria-expanded', 'true');
  infoUi.search.value = '';
  infoState.active = Math.max(0, templateEntries().findIndex(e => e.key === infoState.type));
  renderOptions('');
  infoUi.search.focus();
  const node = infoUi.list.querySelector('[data-active="1"]');
  if (node) node.scrollIntoView({ block: 'nearest' });
}

function closeCombo() {
  infoUi.panel.hidden = true;
  infoUi.btn.setAttribute('aria-expanded', 'false');
}

function selectTemplate(key) {
  if (!INFO_TEMPLATES[key]) return;
  infoState.type = key;
  infoUi.value.textContent = INFO_TEMPLATES[key].title;
  applyTemplateFields();
  chrome.storage.local.set({ savedInfoType: key });
}

infoUi.btn.addEventListener('click', () => {
  if (infoUi.panel.hidden) openCombo(); else closeCombo();
});
infoUi.search.addEventListener('input', () => { infoState.active = 0; renderOptions(infoUi.search.value); });
infoUi.search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const hit = infoState.matches[infoState.active];
    if (hit) { selectTemplate(hit.key); closeCombo(); infoUi.btn.focus(); }
  } else if (e.key === 'Escape') { e.preventDefault(); closeCombo(); infoUi.btn.focus(); }
});
infoUi.list.addEventListener('click', (e) => {
  const opt = e.target.closest('.combo__opt');
  if (!opt) return;
  selectTemplate(opt.dataset.key);
  closeCombo();
  infoUi.btn.focus();
});
document.addEventListener('click', (e) => {
  if (!infoUi.panel.hidden && !infoUi.combo.contains(e.target)) closeCombo();
});

// ---------- строчные поля списка ----------

function rowInputs() {
  return [...infoUi.rows.querySelectorAll('input')];
}

/** Значения без пустых — ровно то, что уйдёт в бланк. */
function listValues() {
  return rowInputs().map(i => i.value.trim()).filter(Boolean);
}

function refreshRows() {
  const inputs = rowInputs();
  const seen = new Map();
  inputs.forEach((input, i) => {
    input.closest('.ilist__row').querySelector('.ilist__n').textContent = i + 1;
    const v = input.value.trim();
    // Один и тот же номер дважды — это либо двойной удар сканером, либо
    // реальная вторая позиция. Решает оператор, но увидеть он это должен.
    const dupe = v && seen.has(v);
    if (v) seen.set(v, true);
    input.closest('.ilist__row').classList.toggle('ilist__row--dupe', !!dupe);
    input.closest('.ilist__row').title = dupe ? 'Такой номер уже есть выше' : '';
  });
  infoUi.count.textContent = listValues().length;
}

function makeRow(value = '') {
  const row = document.createElement('div');
  row.className = 'ilist__row';
  row.innerHTML = `<span class="ilist__n"></span>
    <input type="text" spellcheck="false" autocomplete="off">
    <button type="button" class="ilist__del" title="Убрать строку" aria-label="Убрать строку">
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor"
           stroke-width="2.2" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>
    </button>`;
  const input = row.querySelector('input');
  input.value = value;
  return row;
}

function addRow(value = '', after = null, focus = true) {
  const row = makeRow(value);
  if (after && after.parentNode === infoUi.rows) after.after(row);
  else infoUi.rows.appendChild(row);
  refreshRows();
  if (focus) row.querySelector('input').focus();
  return row;
}

function setRows(values) {
  infoUi.rows.innerHTML = '';
  const list = values.length ? values : [''];
  for (const v of list) infoUi.rows.appendChild(makeRow(v));
  refreshRows();
}

infoUi.rows.addEventListener('keydown', (e) => {
  const input = e.target;
  if (!input.matches('input')) return;
  const row = input.closest('.ilist__row');
  if (e.key === 'Enter') {
    e.preventDefault();
    const next = row.nextElementSibling;
    // Enter в середине списка переводит на следующую строку, а не плодит
    // пустые: новая заводится только с конца.
    if (next && !next.querySelector('input').value.trim()) next.querySelector('input').focus();
    else if (next) next.querySelector('input').focus();
    else addRow('', row);
  } else if (e.key === 'Backspace' && !input.value && rowInputs().length > 1) {
    e.preventDefault();
    const prev = row.previousElementSibling;
    const next = row.nextElementSibling;
    row.remove();
    refreshRows();
    const focusOn = prev || next;
    if (focusOn) {
      const f = focusOn.querySelector('input');
      f.focus();
      f.setSelectionRange(f.value.length, f.value.length);
    }
  } else if (e.key === 'ArrowDown' && row.nextElementSibling) {
    e.preventDefault(); row.nextElementSibling.querySelector('input').focus();
  } else if (e.key === 'ArrowUp' && row.previousElementSibling) {
    e.preventDefault(); row.previousElementSibling.querySelector('input').focus();
  }
});

infoUi.rows.addEventListener('input', refreshRows);

infoUi.rows.addEventListener('click', (e) => {
  const del = e.target.closest('.ilist__del');
  if (!del) return;
  const row = del.closest('.ilist__row');
  if (rowInputs().length === 1) { row.querySelector('input').value = ''; refreshRows(); return; }
  row.remove();
  refreshRows();
});

// Вставка столбца (из Excel, из выгрузки WMS, из чата) раскладывается по
// строкам сама — иначе оператор вставляет всё в одно поле и печатает мусор.
infoUi.rows.addEventListener('paste', (e) => {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text || !/[\n\r\t,;]/.test(text)) return;
  e.preventDefault();
  const parts = text.split(/[\n\r\t,;]+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return;
  const input = e.target.closest('.ilist__row').querySelector('input');
  let anchor = input.closest('.ilist__row');
  input.value = parts[0];
  for (const v of parts.slice(1)) anchor = addRow(v, anchor, false);
  refreshRows();
  anchor.querySelector('input').focus();
});

infoUi.add.addEventListener('click', () => addRow('', infoUi.rows.lastElementChild));

// ---------- поля под выбранный тип ----------

function applyTemplateFields() {
  const tpl = INFO_TEMPLATES[infoState.type];
  document.querySelectorAll('#tab-infolist .dynamic-field').forEach(el => { el.hidden = true; });
  for (const f of tpl.fields) {
    if (f === 'sender' || f === 'date' || f === 'count') continue;
    const group = document.getElementById(`group-${f}`);
    if (group) group.hidden = false;
  }
  if (tpl.fields.includes('list')) {
    infoUi.labelList.textContent = (tpl.listLabel || '').replace(/:$/, '');
    if (!rowInputs().length) setRows([]);
  }
  infoUi.warn.hidden = true;
}

// ---------- сбор и печать ----------

function collectInfolist() {
  return {
    type: infoState.type,
    sender: document.getElementById('input-sender').value.trim(),
    date: document.getElementById('input-date').value,
    receiver: document.getElementById('input-receiver').value.trim(),
    target: document.getElementById('input-target').value.trim(),
    gm: document.getElementById('input-gm').value.trim(),
    order: document.getElementById('input-order').value.trim(),
    barcode: document.getElementById('input-barcode').value.trim(),
    unknown_count: Math.max(0, Number(document.getElementById('input-unknown_count').value) || 0),
    copies: Math.max(1, Math.min(50, Number(document.getElementById('input-copies').value) || 1)),
    items: listValues()
  };
}

function showInfoWarn(text, level) {
  infoUi.warn.textContent = text || '';
  infoUi.warn.dataset.level = level || 'bad';
  infoUi.warn.hidden = !text;
}

// Стиль бланка нужен и в попапе: по нему меряется, влезает ли список.
// Сцена — контейнер шириной с лист, унесённый за край экрана: попап узкий,
// а мерить нужно на настоящей ширине A4, иначе колонки посчитаются не те.
const infoStyle = document.createElement('style');
infoStyle.textContent = INFOLIST_CSS;
document.head.appendChild(infoStyle);

const infoStage = document.createElement('div');
infoStage.id = 'il-stage';
infoStage.setAttribute('aria-hidden', 'true');
infoStage.style.cssText = 'position:fixed;left:-99999px;top:0;width:210mm;pointer-events:none;';
document.body.appendChild(infoStage);

/** Логотип вшиваем в разметку: страница, куда мы её отдаём, ресурсы расширения не видит. */
let logoDataUrl = null;
async function infoLogo() {
  if (logoDataUrl) return logoDataUrl;
  try {
    const res = await fetch(chrome.runtime.getURL('icons/uzum_logo.svg'));
    const svg = await res.text();
    logoDataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  } catch (e) {
    logoDataUrl = '';
  }
  return logoDataUrl;
}

/**
 * Печатает готовую разметку В ТОЙ ЖЕ вкладке, где сейчас работает оператор:
 * скрытый iframe, свой документ, свой print(). Ничего не открывается и не
 * закрывается — окно печати появляется поверх WMS.
 *
 * Функция уезжает на страницу текстом (chrome.scripting.executeScript), так
 * что снаружи она ничего не видит: всё, что ей нужно, приходит аргументами.
 *
 * Возвращает false, если страница не дала оформить лист. Свой <style> внутри
 * iframe наследует CSP страницы-родителя, и на сайте со строгим style-src он
 * молча не применится — лист напечатается голым текстом. Проверяем это до
 * печати и в таком случае честно отступаем на свою страницу.
 */
async function printInPage(html, css, selector, title) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;z-index:-2147483647;';
  document.body.appendChild(frame);

  const win = frame.contentWindow;
  const doc = win.document;
  doc.open();
  doc.write('<!doctype html><html lang="ru"><head><meta charset="utf-8">'
    + '<title>' + (title || 'Печать') + '</title><style>' + css + '</style></head><body>'
    + html + '</body></html>');
  doc.close();

  const drop = () => { if (frame.parentNode) frame.remove(); };

  await new Promise(r => setTimeout(r, 60));
  const sheet = doc.querySelector(selector || '.il-sheet');
  // 210mm — ширина листа; если стиль не применился, ширина будет во всё окно
  // или нулевой, и печатать такое нельзя.
  const styled = sheet && Math.abs(sheet.getBoundingClientRect().width - 794) < 12;
  if (!styled) { drop(); return false; }

  // Рамку убираем не по таймеру, а когда печать закрылась: прежний код сносил
  // её через две секунды, и медленный оператор терял предпросмотр печати.
  win.addEventListener('afterprint', () => setTimeout(drop, 300));
  setTimeout(drop, 5 * 60 * 1000);

  try {
    if (doc.fonts && doc.fonts.ready) await doc.fonts.ready;
    await new Promise(r => setTimeout(r, 60));
    win.focus();
    win.print();
  } catch (e) {
    drop();
    return false;
  }
  return true;
}

infoUi.print.addEventListener('click', async () => {
  const data = collectInfolist();
  const missing = missingFields(data.type, data);
  if (missing.length) {
    showInfoWarn(`Не заполнено: ${missing.join(', ')}. Пустой лист в коробе хуже, чем ненапечатанный.`);
    return;
  }
  showInfoWarn('');
  chrome.storage.local.set({
    infolistPrint: { ...data, auto: true },
    savedSender: data.sender,
    savedInfoReceiver: data.receiver,
    savedInfoCopies: data.copies
  });

  // Раскладываем и меряем ЗДЕСЬ, в попапе: тем же кодом, что и страница
  // предпросмотра. В печать уходит уже подогнанная разметка — на чужой
  // странице мерить нечем и незачем.
  const laid = layoutSheets(infoStage, data.type, { ...data, logoUrl: await infoLogo() });
  infoStage.innerHTML = '';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const reachable = tab && tab.id && /^https?:/.test(tab.url || '');
  if (!reachable) {
    // На chrome:// и в магазине расширений вкладка нам не принадлежит —
    // печатаем со своей страницы, чтобы лист всё-таки вышел.
    chrome.tabs.create({ url: chrome.runtime.getURL('infolist.html') });
    return;
  }

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: printInPage,
      args: [laid.html, INFOLIST_CSS, '.il-sheet', 'Информационный лист']
    });
    if (!res || res[0] === undefined || res[0].result === false) {
      chrome.tabs.create({ url: chrome.runtime.getURL('infolist.html') });
      return;
    }
    const sheetsOut = laid.parts * laid.copies;
    showInfoWarn(
      `Отправлено на печать: ${sheetsOut} ${sheetsOut === 1 ? 'лист' : 'листа'}`
      + (laid.parts > 1 ? ` (позиции не влезли на один — на каждом стоит «лист N из ${laid.parts}»)` : '')
      + '. Окно печати открылось поверх страницы.', 'ok');
  } catch (e) {
    chrome.tabs.create({ url: chrome.runtime.getURL('infolist.html') });
  }
});

// ---------- начальное состояние ----------

document.getElementById('input-date').valueAsDate = new Date();
setRows([]);

// Число копий запоминается: на ПВЗ оно постоянное (лист в короб и лист себе),
// а сбрасывалось при каждом открытии попапа — и «двух копий» молча не было.
document.getElementById('input-copies').addEventListener('change', (e) => {
  const value = Math.max(1, Math.min(50, Number(e.target.value) || 1));
  e.target.value = value;
  chrome.storage.local.set({ savedInfoCopies: value });
});

chrome.storage.local.get(['savedSender', 'savedInfoType', 'savedInfoReceiver', 'savedInfoCopies'], (saved) => {
  if (saved.savedSender) document.getElementById('input-sender').value = saved.savedSender;
  if (saved.savedInfoReceiver) document.getElementById('input-receiver').value = saved.savedInfoReceiver;
  if (saved.savedInfoCopies) document.getElementById('input-copies').value = saved.savedInfoCopies;
  selectTemplate(INFO_TEMPLATES[saved.savedInfoType] ? saved.savedInfoType : 'fbs');
});
selectTemplate('fbs');


// ==========================================
// 3.1 АПП — АКТ ПРИЁМА-ПЕРЕДАЧИ
// ==========================================
// По этому листу водитель забирает заказы с ПВЗ, и подписывают его трое.
// Форма спрашивает ровно то, что оператор знает сам: реквизиты сверху и
// список заказов. Столбцы «Целостность заказов нарушена при доставки»
// заполняются на месте ручкой — расширение в них не пишет ничего.
//
// Заказов больше десяти — акт делится на листы, и это не настройка: в
// бланке ровно десять пронумерованных строк.

import { APP_TYPES, APP_DEFAULTS, APP_CSS, buildAppSheets, appMissing, ROWS_PER_SHEET,
         INTEGRITY_OK, INTEGRITY_OPEN } from './app-sheet.js';
import { createRowList } from './row-list.js';

const appUi = {
  types: document.getElementById('app-types'),
  admin: document.getElementById('app-admin'),
  tabel: document.getElementById('app-tabel'),
  date: document.getElementById('app-date'),
  pvz: document.getElementById('app-pvz'),
  copies: document.getElementById('app-copies'),
  rows: document.getElementById('app-rows'),
  cols: document.getElementById('app-cols'),
  needBarcode: document.getElementById('app-need-barcode'),
  count: document.getElementById('app-count'),
  add: document.getElementById('app-add'),
  hint: document.getElementById('app-hint'),
  undo: document.getElementById('app-undo'),
  warn: document.getElementById('app-warn'),
  print: document.getElementById('app-print')
};

let appType = APP_DEFAULTS.type;

appUi.types.innerHTML = Object.entries(APP_TYPES).map(([key, t]) => `
  <label class="pick__opt">
    <input type="radio" name="app-type" value="${key}"${key === appType ? ' checked' : ''}>
    <span class="pick__dot"></span>
    <span class="pick__text"><span class="pick__n">${t.n}.</span>${escapeHtml(t.title)}</span>
  </label>`).join('');

appUi.types.addEventListener('change', (e) => {
  if (!e.target.matches('input[name="app-type"]')) return;
  appType = e.target.value;
  saveAppDraft();
});

// ЧЕРНОВИК ЖИВЁТ, ПОКА АКТ НЕ НАПЕЧАТАН.
//
// Попап Chrome закрывается от любого клика мимо, и до этого набранные
// вручную десять номеров исчезали вместе с ним: оператор отвлёкся на
// клиента — и набирает всё заново. Теперь форма пишется в хранилище на
// каждое изменение и возвращается при открытии.
//
// Очищается она РОВНО в одном месте — после печати: акт ушёл водителю,
// следующий будет со своим списком. Реквизиты сверху при этом остаются:
// администратор, табельный и ПВЗ за смену не меняются.
const APP_DRAFT_KEY = 'appDraft';
const APP_PRINTED_KEY = 'appPrinted';

const saveAppDraft = debounce(() => {
  chrome.storage.local.set({ [APP_DRAFT_KEY]: collectApp() });
}, 250);

const appList = createRowList({
  host: appUi.rows,
  countEl: appUi.count,
  addBtn: appUi.add,
  columns: [
    { key: 'order', placeholder: 'Номер заказа' },
    { key: 'barcode', placeholder: 'ШК товара' },
    // Целостность коробки. По умолчанию «не вскрыта» — так приезжает
    // подавляющее большинство; отмечают именно исключение.
    { key: 'opened', type: 'flag', off: INTEGRITY_OK, on: INTEGRITY_OPEN,
      title: 'Целостность заказа: нажмите, если коробка вскрыта' }
  ],
  onChange: () => { appHintSheets(); saveAppDraft(); }
});

/**
 * Куда ведёт Enter. Поле ШК остаётся на месте в обоих режимах — «не
 * переписывают» не значит «никогда»: на классике попадается заказ, у
 * которого ШК виден и нужен, и убирать ради этого поле было бы хуже, чем
 * держать его вне потока ввода.
 */
function appSetBarcode(on) {
  appList.setEnterSkip('barcode', !on);
  appUi.cols.dataset.skip = on ? '' : 'barcode';
  appHintSheets();
}

appUi.needBarcode.addEventListener('change', (e) => {
  appSetBarcode(e.target.checked);
  saveAppDraft();
});

/** Подсказка о втором листе появляется раньше печати, а не после неё. */
function appHintSheets() {
  const n = appList.values().length;
  const parts = Math.max(1, Math.ceil(n / ROWS_PER_SHEET));
  appUi.hint.textContent = parts > 1
    ? `Заказов ${n} — акт уйдёт на ${parts} листа, у каждого свой номер и «Стр. N из ${parts}».`
    : appUi.needBarcode.checked
      ? 'Enter — следующее поле. Можно вставить два столбца из Excel.'
      : 'Enter — сразу следующая строка, ШК пропускается. Вписать его можно мышью.';
}

function appWarn(text, level) {
  appUi.warn.hidden = !text;
  appUi.warn.textContent = text || '';
  if (level) appUi.warn.dataset.level = level; else appUi.warn.removeAttribute('data-level');
}

function collectApp() {
  return {
    type: appType,
    admin: appUi.admin.value.trim(),
    tabel: appUi.tabel.value.trim(),
    date: appUi.date.value,
    pvz: appUi.pvz.value.trim(),
    copies: Math.max(1, Math.min(20, Number(appUi.copies.value) || 1)),
    needBarcode: appUi.needBarcode.checked,
    items: appList.values()
  };
}

/** Подставить черновик в форму целиком. */
function applyAppDraft(draft) {
  const d = draft || {};
  if (d.type && APP_TYPES[d.type]) {
    appType = d.type;
    const radio = appUi.types.querySelector(`input[value="${appType}"]`);
    if (radio) radio.checked = true;
  }
  if (d.admin !== undefined) appUi.admin.value = d.admin || '';
  if (d.tabel !== undefined) appUi.tabel.value = d.tabel || '';
  if (d.date) appUi.date.value = d.date;
  if (d.pvz !== undefined) appUi.pvz.value = d.pvz || '';
  if (d.copies) appUi.copies.value = d.copies;
  appUi.needBarcode.checked = d.needBarcode === true;
  appSetBarcode(appUi.needBarcode.checked);
  appList.setValues(d.items || []);
  appHintSheets();
}

/** Кнопка «вернуть напечатанное»: печать отменили — список не потерян. */
function showAppUndo(has) {
  appUi.undo.hidden = !has;
}

appUi.undo.addEventListener('click', () => {
  chrome.storage.local.get([APP_PRINTED_KEY], (saved) => {
    if (!saved[APP_PRINTED_KEY]) return;
    applyAppDraft(saved[APP_PRINTED_KEY]);
    showAppUndo(false);
    saveAppDraft();
  });
});

appUi.print.addEventListener('click', async () => {
  const data = collectApp();
  const missing = appMissing(data);
  if (missing.length) {
    appWarn(`Не заполнено: ${missing.join(', ')}. Пустой акт водитель не примет.`);
    return;
  }
  appWarn('');

  // АКТ УШЁЛ В ПЕЧАТЬ — список заказов обнуляется, реквизиты остаются.
  // Напечатанное складываем отдельно: если окно печати закрыли, не выбрав
  // принтер, десять набранных вручную номеров обязаны возвращаться одним
  // нажатием, а не набираться заново.
  const fresh = { ...data, items: [] };
  chrome.storage.local.set({
    appPrint: { ...data, auto: true },
    [APP_PRINTED_KEY]: data,
    [APP_DRAFT_KEY]: fresh
  });
  appList.setValues([]);
  appHintSheets();
  showAppUndo(true);

  const built = buildAppSheets(data);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const reachable = tab && tab.id && /^https?:/.test(tab.url || '');
  if (!reachable) {
    // На chrome:// и в магазине расширений вкладка нам не принадлежит —
    // печатаем со своей страницы, чтобы лист всё-таки вышел.
    chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
    return;
  }

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: printInPage,
      args: [built.html, APP_CSS, '.app-sheet', 'Акт приёма-передачи']
    });
    if (!res || res[0] === undefined || res[0].result === false) {
      chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
      return;
    }
    const sheets = built.parts * built.copies;
    appWarn(`Отправлено на печать: ${sheets} ${sheets === 1 ? 'лист' : 'листа'}`
      + (built.parts > 1 ? ` (заказы не влезли на один — акт разделён на ${built.parts})` : '')
      + '. Окно печати открылось поверх страницы.', 'ok');
  } catch (e) {
    chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
  }
});

appUi.date.valueAsDate = new Date();
appHintSheets();

for (const input of [appUi.admin, appUi.tabel, appUi.date, appUi.pvz]) {
  input.addEventListener('input', saveAppDraft);
}

appUi.copies.addEventListener('change', (e) => {
  const value = Math.max(1, Math.min(20, Number(e.target.value) || 1));
  e.target.value = value;
  saveAppDraft();
});

appSetBarcode(false);

chrome.storage.local.get([APP_DRAFT_KEY, APP_PRINTED_KEY, 'wmsUserFullName'], (saved) => {
  const draft = saved[APP_DRAFT_KEY];
  if (draft) applyAppDraft(draft);
  // ФИО берём из WMS, если оно там нашлось: администратор — это тот, кто
  // сейчас в системе, и переписывать его имя руками каждый раз незачем.
  if (!appUi.admin.value && saved.wmsUserFullName) appUi.admin.value = saved.wmsUserFullName;
  if (!appUi.date.value) appUi.date.valueAsDate = new Date();
  // Кнопка возврата — только когда возвращать есть что и форма пустая:
  // иначе она предлагала бы затереть уже набранное.
  showAppUndo(!!saved[APP_PRINTED_KEY] && !appList.values().length);
});


// ==========================================
// 3.2 ДИАГНОСТИКА — АКТ ПРИЁМА ТОВАРА НА ПРОВЕРКУ
// ==========================================
// Талон, по которому товар уезжает в сервисный центр и по которому потом
// возвращается владельцу. Юридический текст в нём неизменен — заполняется
// только шапка. Печать всегда в трёх экземплярах и с двух сторон, поэтому
// она живёт на отдельной странице: печать в два захода, а попап закрывается
// от любого клика мимо.

import { DIAG_DEFAULTS, diagMissing } from './diag-act.js';

const DIAG_INPUTS = ['order', 'pvz', 'item', 'client', 'issued', 'phone',
                     'returnDate', 'phone2', 'kit', 'condition', 'defect', 'admin'];
// Что не меняется от товара к товару: ПВЗ и администратор — вообще, а
// комплект с состоянием — почти всегда («Полный», «Отлично»). Остальное
// относится к конкретной вещи и после печати обнуляется.
const DIAG_STICKY = ['pvz', 'admin', 'kit', 'condition'];
const DIAG_DRAFT_KEY = 'diagDraft';
const DIAG_PRINTED_KEY = 'diagPrinted';

const dgEl = Object.fromEntries(DIAG_INPUTS.map(k => [k, document.getElementById(`dg-${k}`)]));
const dgWarn = document.getElementById('dg-warn');
const dgUndo = document.getElementById('dg-undo');

function collectDiag() {
  return Object.fromEntries(DIAG_INPUTS.map(k => [k, (dgEl[k].value || '').trim()]));
}

// ЧЕРНОВИК ЖИВЁТ, ПОКА АКТ НЕ НАПЕЧАТАН. Попап закрывается от клика мимо,
// а дефект со слов покупателя — это две строки текста, набранные руками.
const saveDiagDraft = debounce(() => {
  chrome.storage.local.set({ [DIAG_DRAFT_KEY]: collectDiag() });
}, 250);

function applyDiag(draft) {
  const d = draft || {};
  for (const k of DIAG_INPUTS) if (d[k] !== undefined) dgEl[k].value = d[k] || '';
}

for (const k of DIAG_INPUTS) dgEl[k].addEventListener('input', saveDiagDraft);

dgUndo.addEventListener('click', () => {
  chrome.storage.local.get([DIAG_PRINTED_KEY], (saved) => {
    if (!saved[DIAG_PRINTED_KEY]) return;
    applyDiag(saved[DIAG_PRINTED_KEY]);
    dgUndo.hidden = true;
    saveDiagDraft();
  });
});

function showDiagWarn(text, level) {
  dgWarn.hidden = !text;
  dgWarn.textContent = text || '';
  if (level) dgWarn.dataset.level = level; else dgWarn.removeAttribute('data-level');
}

document.getElementById('dg-print').addEventListener('click', () => {
  const data = collectDiag();
  const missing = diagMissing(data);
  if (missing.length) {
    showDiagWarn(`Не заполнено: ${missing.join(', ')}. По этому акту товар возвращают `
      + 'владельцу — пустые поля делают его бесполезным.');
    return;
  }
  showDiagWarn('');

  // АКТ УШЁЛ В ПЕЧАТЬ — поля этого товара обнуляются, ПВЗ и администратор
  // остаются. Напечатанное складываем отдельно: печать открывается на
  // отдельной странице, её можно закрыть не напечатав, и набранный дефект
  // обязан возвращаться одним нажатием.
  const fresh = Object.fromEntries(DIAG_INPUTS.map(
    k => [k, DIAG_STICKY.includes(k) ? data[k] : (DIAG_DEFAULTS[k] || '')]));
  chrome.storage.local.set({
    diagPrint: { ...data, auto: false },
    [DIAG_PRINTED_KEY]: data,
    [DIAG_DRAFT_KEY]: fresh
  }, () => {
    applyDiag(fresh);
    dgUndo.hidden = false;
    chrome.tabs.create({ url: chrome.runtime.getURL('diag.html') });
  });
});

chrome.storage.local.get([DIAG_DRAFT_KEY, DIAG_PRINTED_KEY, 'diagSaved', 'wmsUserFullName'],
  (saved) => {
    // Черновик — главный источник. `diagSaved` остался от прежних версий:
    // читаем его один раз, чтобы ПВЗ и ФИО не пришлось вводить заново.
    const draft = saved[DIAG_DRAFT_KEY] || saved.diagSaved || {};
    for (const k of DIAG_INPUTS) {
      if (draft[k]) dgEl[k].value = draft[k];
      else if (!dgEl[k].value && DIAG_DEFAULTS[k]) dgEl[k].value = DIAG_DEFAULTS[k];
    }
    if (!dgEl.admin.value && saved.wmsUserFullName) dgEl.admin.value = saved.wmsUserFullName;
    // Возвращать есть что, и поверх ничего не набрано.
    dgUndo.hidden = !(saved[DIAG_PRINTED_KEY] && !dgEl.order.value.trim());
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
    wmsTotal: String(getMoneyInputValue(wmsInput)),
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
    setMoneyInputValue(wmsInput, payload.wmsTotal);
  }
  if (payload.bagNumber !== undefined) {
    bagNumberInput.value = payload.bagNumber;
    clampNonNegative(bagNumberInput);
  }

  calculateTotals(); // пересчитывает UI и одним вызовом сохраняет всё в chrome.storage.local

  importInput.value = '';
  showTransferStatus(importStatus, '✅ Импортировано и сохранено', false);
});

// Показывает, откуда взялось значение "Сумма в WMS" и насколько оно свежее —
// чтобы автоматическая подстановка не выглядела как чёрный ящик и оператор
// мог сам решить, доверять ли ей (поле остаётся редактируемым в любом случае).
function formatSyncTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function showWmsSyncHint(timestamp, cashInRegister, pendingEncashment) {
  const hint = document.getElementById('wms-sync-hint');
  if (!hint || !timestamp) return;

  const STALE_AFTER_MS = 12 * 60 * 60 * 1000; // старше 12 часов — вероятно, другая смена
  const isStale = (Date.now() - timestamp) > STALE_AFTER_MS;
  const timeStr = formatSyncTime(timestamp);

  // Подсказка теперь живёт ВНУТРИ карточки, прямо под полем "Сумма в WMS" —
  // источник значения и так очевиден из контекста, поэтому не повторяем его
  // словами и оставляем только время и (если есть) саму разбивку вычитания.
  // Показываем её только когда реально есть что вычитать — иначе в обычном
  // случае (ничего не ждёт инкассации) это была бы бесполезная "− 0".
  const hasBreakdown = cashInRegister !== undefined && pendingEncashment > 0;
  const breakdown = hasBreakdown
    ? ` · <span class="hint-figure">${formatSum(cashInRegister)}</span> − <span class="hint-figure">${formatSum(pendingEncashment)}</span> к инкассации`
    : '';

  hint.innerHTML = isStale
    ? `⚠️ Данные из кассы устарели (${timeStr}) — проверьте актуальность`
    : `🔄 Обновлено в ${timeStr}${breakdown}`;
  hint.style.color = isStale ? 'var(--bad)' : 'var(--good)';
  hint.style.display = 'block';
}

// ==========================================
// 5. ЗАГРУЗКА СОСТОЯНИЯ ПРИ СТАРТЕ
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(
    ['savedCounts', 'savedWms', 'savedSender', 'savedBagNumber', 'savedBagAt', 'cashZeroMode', 'wmsBalanceFromDom', 'wmsBalanceFromDomAt', 'wmsCashInRegister', 'wmsPendingEncashment'],
    (data) => {
      if (data.savedCounts) {
        document.querySelectorAll('.fact-input').forEach(input => {
          const denom = input.dataset.denom;
          if (data.savedCounts[denom] !== undefined) input.value = data.savedCounts[denom];
        });
      }

      // Значение, автоматически прочитанное со страницы кассы, приоритетнее
      // ранее вручную сохранённого — оно свежее и снимает необходимость
      // переписывать число из интерфейса WMS руками. Поле остаётся обычным
      // редактируемым input — если оно неверное или устарело, оператор может
      // просто исправить его, как и раньше.
      if (data.wmsBalanceFromDom !== undefined) {
        setMoneyInputValue(wmsInput, data.wmsBalanceFromDom);
        showWmsSyncHint(data.wmsBalanceFromDomAt, data.wmsCashInRegister, data.wmsPendingEncashment);
      } else if (data.savedWms !== undefined) {
        setMoneyInputValue(wmsInput, data.savedWms);
      }

      // СОМНИТЕЛЬНЫЙ НОМЕР НЕ ПОДСТАВЛЯЕМ — ЭТО ОБЯЗАТЕЛЬНО.
      //
      // Подставляем ровно два случая: номер сегодняшний и номер вчерашний
      // (по дням инкассации). Вчерашний — потому что мешок меняют каждый
      // день инкассации: если он менялся вчера, сегодняшний почти наверняка
      // от него и отсчитывается, и о подстановке сказано вслух.
      //
      // Всё остальное — пустое поле:
      //   * номер не менялся с позавчера и раньше: за него нельзя поручиться;
      //   * НЕИЗВЕСТНО, когда его вводили (старое хранилище, импорт с другого
      //     компьютера): «неизвестно когда» — это тот же сомнительный номер,
      //     а раньше он молча подставлялся как свой.
      // Прошлый номер показываем подписью — чтобы было от чего оттолкнуться,
      // но переписать его в поле оператор должен руками.
      bagSavedAt = Number(data.savedBagAt) || 0;
      const savedBag = data.savedBagNumber === undefined ? '' : String(data.savedBagNumber);
      const trusted = savedBag && bagSavedAt
        && (sameDay(bagSavedAt, Date.now()) || sameDay(bagSavedAt, previousCollectionDay(Date.now())));
      bagNumberInput.value = trusted ? savedBag : '';
      bagLoadedValue = bagNumberInput.value.trim();
      if (savedBag && !trusted) staleBagHint = { number: savedBag, at: bagSavedAt || 0 };

      cashZeroMode = data.cashZeroMode === true;
      const zeroToggle = document.getElementById('cash-zero');
      if (zeroToggle) zeroToggle.checked = cashZeroMode;

      calculateTotals();

      if (data.savedSender) document.getElementById('input-sender').value = data.savedSender;
    }
  );
});
// ==========================================
// 6. ПРИЁМКА
// ==========================================
// Показывает то, что content.js собрал со страниц WMS: по строке на позицию,
// с поиском и фильтром по источнику. Данные только читаются из
// chrome.storage.local — сам попап в WMS не ходит и ничего там не нажимает.

const PK_RENDER_LIMIT = 300;   // строк за раз: дальше попап начинает тормозить
const PK_STORAGE_KEYS = ['priemkaRecords', 'priemkaUpdatedAt', 'priemkaCells', 'priemkaSync',
                         'priemkaSku', 'priemkaMissingCells', 'skuNameCache'];

const pkState = {
  records: [],
  updatedAt: 0,
  cells: [],                    // справочник ячеек, как его отдаёт сам WMS
  sku: {},                      // ШК -> { name, unit, габариты } из WMS
  names: {},                    // ШК -> готовый перевод названия
  missingCells: [],             // ячейки, которых физически нет (пометил оператор)
  recommendations: new Map(),   // recordKey -> { cellId, reason, tier }
  allocationNote: ''
};

const pkEl = {
  rows: document.getElementById('pk-rows'),
  hollow: document.getElementById('pk-hollow'),
  search: document.getElementById('pk-search'),
  source: document.getElementById('pk-source'),
  status: document.getElementById('pk-status'),
  meta: document.getElementById('pk-meta'),
  banner: document.getElementById('pk-banner'),
  thRec: document.getElementById('pk-th-rec'),
  statTotal: document.getElementById('pk-stat-total'),
  statCells: document.getElementById('pk-stat-cells'),
  statNoCell: document.getElementById('pk-stat-nocell'),
  statOrders: document.getElementById('pk-stat-orders'),
  statGm: document.getElementById('pk-stat-gm')
};

// Человеческое название товара. В справочнике WMS `title` — это код
// поставщика, а читаемое имя лежит в `description`; background.js кладёт
// его в поле `name`. Старые записи (собранные до этой правки) могут иметь
// только title — их тоже показываем, чтобы не оставлять пустоту.
// Тир размера позиции по габаритам из справочника (мм).
function pkSizeTier(record) {
  const sku = record.barcode ? pkState.sku[record.barcode] : null;
  if (!sku) return null;
  return sizeTierFromDimensions(sku);
}

function pkSkuName(record) {
  if (record.itemName) return record.itemName;
  const sku = record.barcode ? pkState.sku[record.barcode] : null;
  if (!sku) return '';
  return sku.name || sku.title || '';
}

/** Сколько это весит: заявленное в названии или оценка по габаритам. */
function pkWeightKg(record) {
  const lib = globalThis.UCoreSkuName;
  if (!lib) return undefined;
  const sku = record.barcode ? pkState.sku[record.barcode] : null;
  const weight = lib.weightKg(sku, pkSkuName(record));
  return weight && weight.kg !== null ? weight.kg : undefined;
}

/**
 * Название для полки: короткое, по-русски, с количеством и цветом.
 * Оригинал никуда не девается — он уходит в подсказку и в поиск.
 */
function pkShortName(record) {
  const full = pkSkuName(record);
  if (!full) return { text: '', full: '' };
  const lib = globalThis.UCoreSkuName;
  if (!lib) return { text: full, full };
  // Сохранённый перевод модели важнее словаря — см. displayName.
  const shown = lib.displayName(full, (pkState.names || {})[record.barcode]);
  // «Узнано» — это только перевод словарём или моделью. Сокращённое
  // название переводом не является: слова в нём узбекские, просто их меньше.
  return { text: shown.text || full, full, known: shown.by === 'словарь' || shown.by === 'модель', by: shown.by };
}

const SOURCE_LABELS = {
  fbo: 'FBO', fbs: 'FBS', partner: 'Партнёр', express: 'Экспресс',
  cargo: 'Грузоместо', csv: 'CSV', unknown: '—'
};

// Партнёр важнее типа: заказ uzum-bank приходит как FBO, и если показать
// «FBO», оператор не отличит его от обычного. Тип уходит в подсказку.
function pkSourceLabel(record) {
  if (record.partner) return String(record.partner).toUpperCase();
  return SOURCE_LABELS[record.source] || record.source || '—';
}

function pkStatus(text, isError) {
  pkEl.status.textContent = text;
  pkEl.status.style.color = isError ? 'var(--bad)' : 'var(--good)';
  clearTimeout(pkEl.status._timer);
  pkEl.status._timer = setTimeout(() => { pkEl.status.textContent = ''; }, 3500);
}

function pkBanner(text, kind) {
  if (!text) { pkEl.banner.style.display = 'none'; return; }
  pkEl.banner.textContent = text;
  pkEl.banner.className = `pk-banner${kind === 'info' ? ' pk-banner--info' : ''}`;
  pkEl.banner.style.display = 'flex';
}

// ---------- загрузка ----------

function pkLoad(callback) {
  chrome.storage.local.get(PK_STORAGE_KEYS, (data) => {
    if (chrome.runtime.lastError) {
      pkStatus('Не удалось прочитать данные', true);
      return;
    }
    pkState.records = Array.isArray(data.priemkaRecords) ? data.priemkaRecords : [];
    pkState.updatedAt = data.priemkaUpdatedAt || 0;
    pkState.cells = Array.isArray(data.priemkaCells) ? data.priemkaCells : [];
    pkState.sku = data.priemkaSku || {};
    pkState.names = data.skuNameCache || {};
    pkState.missingCells = (data.priemkaMissingCells || []).map(String);
    pkRender();
    if (callback) callback();
  });
}

// ---------- фильтрация ----------

function pkMatches(record, query, source) {
  if (source && record.source !== source) return false;
  if (!query) return true;
  // Ищем И по короткому названию, И по оригиналу: оператор набирает то
  // «мыло», то «sovun» — в зависимости от того, что у него перед глазами.
  const short = pkShortName(record);
  const haystack = [
    record.cell, record.cellRaw, record.orderId, record.barcode, record.gm,
    record.clientName, record.phone, record.itemName, record.status,
    short.text, short.full
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

function pkFiltered() {
  const query = (pkEl.search.value || '').trim().toLowerCase();
  const source = pkEl.source.value;
  return pkState.records.filter(r => pkMatches(r, query, source));
}

// ---------- отрисовка ----------
// Строки собираются через createElement/textContent, а не innerHTML —
// в данные попадает то, что WMS показал на странице, и вставлять это
// как разметку нельзя (см. правило CSP-совместимости из v1.0.1).

function pkCell(record, field, options = {}) {
  const td = document.createElement('td');
  if (options.className) td.className = options.className;

  let value = record[field] || (options.fallbackField ? record[options.fallbackField] : '');

  // Названия товара в заказе нет — оно лежит в справочнике товаров,
  // который WMS отдаёт отдельным ответом. Связываем по ШК.
  let hint = null;
  if (!value && field === 'itemName' && record.barcode) {
    const short = pkShortName(record);
    value = short.text || '';
    // Оригинал WMS показываем по наведению: он длинный и по-узбекски, но
    // именно он написан на коробке, и иногда сверить надо именно с ним.
    if (short.full && short.full !== value) hint = short.full;
  }
  if (!value) {
    td.textContent = '—';
    td.classList.add('pk-dim');
    return td;
  }

  const guessed = record.confidence && record.confidence[field] === 'medium';
  if (guessed) {
    const span = document.createElement('span');
    span.className = 'pk-guess';
    span.textContent = value;
    span.title = 'Распознано по виду значения, а не по названию поля — стоит перепроверить';
    td.appendChild(span);
  } else {
    td.textContent = value;
  }
  if (hint) td.title = hint;
  return td;
}

function pkSourceCell(record) {
  const td = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = 'pk-src';
  badge.dataset.src = record.source || 'unknown';
  badge.textContent = pkSourceLabel(record);
  if (record.partner) badge.title = `партнёр: ${record.partner} · тип: ${SOURCE_LABELS[record.source] || record.source}`;
  if (record.origin === 'dom') badge.title = 'Прочитано из таблицы на странице';
  td.appendChild(badge);
  return td;
}

function pkRecommendationCell(record) {
  const td = document.createElement('td');
  const rec = pkState.recommendations.get(window.UCoreWmsParse.recordKey(record));
  if (!rec || !rec.cellId) {
    td.textContent = '—';
    td.className = 'pk-rec pk-rec--none';
    if (rec) td.title = rec.reason;
    return td;
  }
  td.textContent = rec.cellId;
  td.className = 'pk-rec';
  td.title = `${rec.tier || ''} · ${rec.reason || ''}`.trim();
  return td;
}

function pkRender() {
  const filtered = pkFiltered();
  const showRec = pkState.recommendations.size > 0;
  pkEl.thRec.style.display = showRec ? '' : 'none';

  pkEl.rows.replaceChildren();

  for (const record of filtered.slice(0, PK_RENDER_LIMIT)) {
    const tr = document.createElement('tr');
    tr.appendChild(pkCell(record, 'cell', { className: 'pk-col-cell', fallbackField: 'cellRaw' }));
    if (showRec) tr.appendChild(pkRecommendationCell(record));
    tr.appendChild(pkCell(record, 'orderId', { fallbackField: 'orderBarcode' }));
    tr.appendChild(pkCell(record, 'pid'));
    tr.appendChild(pkCell(record, 'barcode'));
    tr.appendChild(pkCell(record, 'gm'));
    tr.appendChild(pkCell(record, 'clientName', { fallbackField: 'phone' }));
    tr.appendChild(pkCell(record, 'itemName', { className: 'pk-name' }));
    tr.appendChild(pkSourceCell(record));
    pkEl.rows.appendChild(tr);
  }

  pkEl.hollow.style.display = pkState.records.length ? 'none' : 'block';

  // ---------- счётчики ----------
  // СЧИТАЕМ ПОЛКУ, А НЕ ВСЁ ПОДРЯД.
  //
  // Раньше «без ячейки» было «всего записей минус те, у кого ячейка есть» —
  // то есть в него попадали и позиции коробов (у них ячейки не бывает), и
  // выданные заказы. Получалось 600 там, где на полке без ячейки единицы.
  // И СЧИТАЕМ ВЕЩИ, А НЕ СТРОКИ. «0 / 2 шт.» на экране выдачи — это одна
  // строка и две вещи; по строкам полка выходит меньше, чем на самом деле.
  const units = (list) => globalThis.UCoreWmsParse.countUnits(list);
  const shelf = pkState.records.filter(r => r.source !== 'cargo' && !r.gone);
  const shelfUnits = units(shelf);
  const withCell = units(shelf.filter(r => r.cell));
  const noCell = shelfUnits - withCell;
  const gmCount = new Set(pkState.records.map(r => r.gm).filter(Boolean)).size;
  pkEl.statTotal.textContent = shelfUnits;
  pkEl.statCells.textContent = withCell;
  pkEl.statNoCell.textContent = noCell;
  pkEl.statNoCell.dataset.state = noCell > 0 ? 'warn' : 'ok';

  // ПОЗИЦИЯ И ЗАКАЗ — РАЗНЫЕ ЕДИНИЦЫ, и оператору нужны обе.
  // В заказе бывает шесть товаров: по позициям это шесть строк, по заказам
  // один клиент. На вкладках WMS счёт идёт по заказам, поэтому без этого
  // числа собранное не с чем сверить глазами.
  if (pkEl.statOrders) {
    const orders = new Set(shelf.map(r => String(r.orderId || r.orderBarcode)).filter(Boolean));
    pkEl.statOrders.textContent = orders.size;
  }
  pkEl.statGm.textContent = gmCount;

  // ---------- фильтр источников ----------
  const sources = [...new Set(pkState.records.map(r => r.source || 'unknown'))].sort();
  const current = pkEl.source.value;
  if (sources.join(',') !== (pkEl.source.dataset.built || '')) {
    pkEl.source.replaceChildren();
    const all = document.createElement('option');
    all.value = ''; all.textContent = 'Все источники';
    pkEl.source.appendChild(all);
    for (const source of sources) {
      const option = document.createElement('option');
      option.value = source;
      option.textContent = SOURCE_LABELS[source] || source;
      pkEl.source.appendChild(option);
    }
    pkEl.source.dataset.built = sources.join(',');
    pkEl.source.value = sources.includes(current) ? current : '';
  }

  // ---------- подвал ----------
  const parts = [];
  if (filtered.length > PK_RENDER_LIMIT) {
    parts.push(`показано ${PK_RENDER_LIMIT} из ${filtered.length}`);
  } else if (filtered.length !== pkState.records.length) {
    parts.push(`найдено ${filtered.length} из ${pkState.records.length}`);
  }
  if (pkState.cells.length) parts.push(`справочник ячеек: ${pkState.cells.length}`);
  if (pkState.updatedAt) {
    parts.push(`обновлено в ${new Date(pkState.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
  }
  pkEl.meta.textContent = parts.join(' · ');

  if (pkState.allocationNote) pkBanner(pkState.allocationNote, 'warn');
}

// ---------- кнопки ----------

document.getElementById('pk-btn-export').addEventListener('click', async () => {
  const payload = {
    type: 'ucore_priemka_export',
    version: 1,
    exportedAt: new Date().toISOString(),
    records: pkState.records
  };
  const text = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    pkStatus(`Скопировано (${pkState.records.length} позиций)`);
  } catch (err) {
    pkStatus('Буфер обмена недоступен', true);
  }
});

document.getElementById('pk-btn-clear').addEventListener('click', () => {
  if (!confirm('Удалить все собранные данные приёмки?\n\nНа WMS это никак не влияет — стирается только то, что накопило расширение.')) return;
  chrome.storage.local.remove(PK_STORAGE_KEYS, () => {
    pkState.recommendations.clear();
    pkState.allocationNote = '';
    pkBanner('');
    pkLoad(() => pkStatus('Очищено'));
  });
});

// ---------- расчёт раскладки ----------
// ЧЕСТНОЕ ОГРАНИЧЕНИЕ: сервиса обогащения (перевод -> упрощение названия ->
// оценка габаритов и веса) ещё нет, см. PROJECT-OVERVIEW.md §3.3. Значит
// size_tier и weight у товаров неизвестны, и ядро считает их самыми мелкими
// и лёгкими. Пока это так, работают только те правила, которым размер не
// нужен: запрет на одинаковые названия у разных клиентов (§6), плотная
// упаковка общего пула (§7), разброс карт/RX/SX (§8) и бессрочная привязка
// клиента к ячейке (§10). Выбор секции по размеру и этажа по весу — НЕ
// работают, и вот это прямо написано в баннере, а не спрятано.

async function pkLoadConfig() {
  const response = await fetch(chrome.runtime.getURL('pvz-config.json'));
  return response.json();
}

document.getElementById('pk-btn-allocate').addEventListener('click', async () => {
  if (!pkState.records.length) {
    pkStatus('Сначала нужно собрать данные', true);
    return;
  }

  let config;
  try {
    config = await pkLoadConfig();
  } catch (err) {
    pkStatus('Не найден pvz-config.example.json', true);
    return;
  }

  // Справочник ячеек берём из самих собранных данных: ячейки, которые WMS
  // уже использует, — это и есть реально существующие ячейки ПВЗ. Так
  // расчёт можно попробовать до того, как кто-то вручную обойдёт зал и
  // перепишет всю схему стеллажей (§9 справочника).
  // Справочник ячеек WMS отдаёт сам (GET /de/delivery-point/cells) — content.js
  // ловит этот ответ и складывает в priemkaCells. Это полный список ячеек ПВЗ,
  // а не только те, что успели попасться в заказах, поэтому он в приоритете.
  // Запасной вариант — ячейки, реально встреченные в записях.
  const seenInRecords = [...new Set(pkState.records.map(r => r.cell).filter(Boolean))].sort();
  const cellIds = pkState.cells.length ? pkState.cells : seenInRecords;
  const cellsSource = pkState.cells.length ? 'из справочника WMS' : 'по встреченным в заказах';

  if (cellIds.length < 5) {
    pkStatus('Слишком мало известных ячеек для расчёта', true);
    pkBanner(`Известно всего ${cellIds.length} ячеек. Откройте любую страницу ПВЗ в WMS — расширение поймает полный справочник ячеек само, ничего нажимать не нужно.`, 'warn');
    return;
  }

  // Рекомендация нужна ТОЛЬКО тому, у чего ячейки ещё нет. Позиция, которую
  // WMS уже разместил, никуда не переезжает — предлагать ей ячейку значит
  // предлагать оператору лишнюю работу и путать его.
  const needPlacement = pkState.records.filter(r => !r.cell);
  if (!needPlacement.length) {
    pkStatus('Все собранные позиции уже имеют ячейку — рекомендовать нечего', true);
    pkBanner('Раскладка считается только для позиций без ячейки. Сейчас таких нет: всё, что собрано, WMS уже разместил.', 'info');
    return;
  }

  const items = needPlacement.map(record => ({
    item_id: record.barcode || record.orderId || null,
    // Клиент неизвестен на многих экранах WMS — тогда группируем по заказу:
    // один заказ = один получатель, так что для целей раскладки это то же самое.
    client_id: record.clientId || record.clientName || record.phone || record.orderId || record.gm,
    simplified_name: pkShortName(record).text || null,
    // Тир размера — из НАСТОЯЩИХ габаритов справочника WMS, если они есть.
    // Без него раскладка считала всё самым мелким и не отличала баллончик
    // от коробки.
    size_tier: pkSizeTier(record) || undefined,
    // ВЕС. WMS его не отдаёт вовсе, и до сих пор этаж выбирался только по
    // размеру: пятилитровая канистра могла уехать на верхнюю полку. Теперь
    // вес берётся из названия, где продавец его написал («5 kg», «700 g»),
    // а где не написал — считается по объёму и виду товара. Это оценка, и
    // от неё нужна не точность до килограмма, а правильная полка.
    weight_estimate_kg: pkWeightKg(record),
  }));

  // Справочник WMS содержит ячейки, которых физически на ПВЗ нет. Проверено
  // на ТАШ-120: в работе 108 ячеек из 358, а весь этаж 1 в секциях 7-14
  // (811, 812, 911, 912, 1011…) не используется никогда. Оператор помечает
  // такие ячейки сам — одним нажатием, и больше их никто не предложит.
  const engineConfig = {
    ...config,
    nonexistentCells: [...new Set([
      ...(config.nonexistentCells || []).map(String),
      ...pkState.missingCells
    ])]
  };

  const engine = new AllocationEngine(engineConfig, cellIds);
  const results = engine.allocateBatch(items);

  pkState.recommendations.clear();
  results.forEach((result, i) => {
    pkState.recommendations.set(
      window.UCoreWmsParse.recordKey(needPlacement[i]),
      { cellId: result.cellId, reason: result.reason, tier: result.tier }
    );
  });

  const placed = results.filter(r => r.cellId).length;
  const noCapacity = results.filter(r => r.reason === PLACEMENT_REASONS.NO_CAPACITY).length;

  pkState.allocationNote =
    'Предварительный расчёт: габариты и вес товаров неизвестны (сервис обогащения ещё не построен), ' +
    'поэтому выбор секции по размеру и этажа по весу НЕ применялись. Работают запрет на одинаковые ' +
    'названия у разных клиентов, плотная упаковка и разброс карт.';

  pkRender();
  pkStatus(`Размещено ${placed} из ${results.length} без ячейки${noCapacity ? `, без места ${noCapacity}` : ''} · ${cellIds.length} ячеек ${cellsSource}`);
});

// ---------- живое обновление ----------

pkEl.search.addEventListener('input', debounce(pkRender, 150));
pkEl.source.addEventListener('change', pkRender);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (PK_STORAGE_KEYS.some(key => key in changes)) pkLoad();
});

pkLoad();

// ==========================================
// 7. АВТОСБОР И ИМПОРТ CSV
// ==========================================
// Два способа набрать данные без ручного перебора заказов:
//
//   «Собрать всё из WMS» — service worker сам листает списки по адресам,
//   которые страница WMS уже использовала (каталог шаблонов), включая
//   запрос товаров, где лежат ячейки FBO. Оператор при этом ничего не
//   нажимает в самом WMS.
//
//   «Импорт CSV» — та самая выгрузка «Скачать .csv». Один клик покрывает
//   всё, кроме FBO, и работает даже когда каталог ещё пуст.

const pkSyncEl = {
  button: document.getElementById('pk-btn-sync'),
  full: document.getElementById('pk-btn-sync-full'),
  status: document.getElementById('pk-sync-status'),
  progress: document.getElementById('pk-progress'),
  diag: document.getElementById('pk-diag'),
  csv: document.getElementById('pk-csv')
};

// Короткая сводка фактов под ошибкой. Нужна, чтобы по одному взгляду было
// видно, где именно оборвалось: спрашивала вкладка или расширение, какой
// адрес, что ответил сервер. Без неё любая неудача выглядит одинаково.
function pkRenderDiag(diag) {
  if (!pkSyncEl.diag) return;
  if (!diag) { pkSyncEl.diag.hidden = true; pkSyncEl.diag.textContent = ''; return; }
  const bits = [];
  if (diag.status) bits.push(`ответ ${diag.status}`);
  if (diag.path) bits.push(`адрес ${diag.path}`);
  bits.push(diag.transport === 'page' ? 'спрашивала вкладка WMS'
    : diag.transport === 'direct' ? 'спрашивало расширение'
    : 'запрос не ушёл');
  bits.push(`вкладок WMS: ${diag.tabs ?? 0}`);
  if (diag.dpKey) bits.push(`ПВЗ ${diag.dpKey}`);
  bits.push(`адресов в каталоге: ${diag.templates ?? 0}`);
  if (diag.bridgeError) bits.push(`вкладка: ${diag.bridgeError}`);
  if (diag.body) bits.push(`сервер: ${diag.body.slice(0, 120)}`);
  pkSyncEl.diag.textContent = bits.join(' · ');
  pkSyncEl.diag.hidden = false;
}

let pkSyncPoll = null;

function pkRenderSync(state) {
  const running = !!state?.running;
  pkSyncEl.progress.dataset.on = running ? '1' : '0';
  pkSyncEl.button.disabled = running;
  pkSyncEl.button.style.opacity = running ? '0.65' : '';

  if (state?.error) {
    pkSyncEl.status.textContent = state.error;
    pkSyncEl.status.dataset.state = 'err';
    pkRenderDiag(state.diag);
    return;
  }
  pkRenderDiag(null);
  if (running) {
    pkSyncEl.status.textContent = state.step || 'Идёт сбор…';
    pkSyncEl.status.dataset.state = '';
    return;
  }
  if (state?.finishedAt) {
    const bits = [];
    if (state.added) bits.push(`новых ${state.added}`);
    if (state.enriched) bits.push(`дополнено ${state.enriched}`);
    if (state.cells) bits.push(`ячеек ${state.cells}`);
    // Составы посылок: их не видно ни по «новым», ни по «дополнено» —
    // они лежат отдельным ключом, и без строки оператор не поймёт,
    // приехало что-нибудь или нет.
    if (state.packages) bits.push(`составов ${state.packages}`);
    const when = new Date(state.finishedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    pkSyncEl.status.textContent = bits.length
      ? `Готово в ${when}: ${bits.join(', ')}`
      : `Готово в ${when}: новых данных нет`;
    pkSyncEl.status.dataset.state = 'ok';

    // Каталог собирается из живого трафика, поэтому пока оператор не открыл
    // экран выдачи, запроса товаров в нём нет — а без него не будет ячеек FBO.
    // Говорим об этом прямо, а не оставляем гадать, почему ячеек нет.
    // WMS сам отвечает ошибкой по части заказов — это не наша поломка,
    // но молчать о ней нельзя: иначе непонятно, почему у нескольких
    // десятков позиций нет ячейки.
    // СВЕРКА СО СЧЁТЧИКАМИ НА ЭКРАНАХ WMS.
    //
    // Пишем ровно теми числами, которые оператор видит своими глазами:
    //   «Товары → К выдаче»  = FBO + FBS без партнёров
    //   «Заказы → К выдаче»  = то же самое плюс партнёрские
    // Так расхождение сразу видно, и не надо гадать, что с чем сравнивать.
    // СВЕРКА СО СЧЁТЧИКАМИ НА ЭКРАНАХ WMS, теми же числами, что видит
    // оператор: «Товары» = FBO+FBS без партнёров, «Заказы» = плюс партнёры.
    //
    // Числа живые: пока идёт сбор, заказы выдаются и счётчик падает.
    // Поэтому расхождением считаем только НЕДОБОР, а разницу от выдачи
    // называем своим именем, а не ошибкой.
    // ОБОРВАННЫЙ СПИСОК — ГЛАВНОЕ, ЧТО НАДО СКАЗАТЬ.
    //
    // Если список заказов не дочитан до конца, все числа ниже неполные
    // по определению, и «недостача» в них — это недочитанные страницы,
    // а не пропавший товар. Раньше расширение молчало об обрыве и писало
    // «НЕ ХВАТАЕТ 74», отправляя оператора искать несуществующую пропажу.
    if (state.listIncomplete) {
      pkSyncEl.status.textContent +=
        '. СПИСОК ЗАКАЗОВ ДОЧИТАН НЕ ДО КОНЦА — числа ниже неполные, соберите ещё раз';
      pkSyncEl.status.dataset.state = 'err';
    }

    if (state.expectedB2C) {
      // ПОКАЗЫВАЕМ ОБЕ МЕРЫ, А НЕ ОДНУ.
      //
      // Строка списка и заказ — разные вещи: у потоварной выдачи один заказ
      // приходит несколькими строками. Раньше здесь стояло «Товары: 235 из
      // 305», где 235 — заказы, а 305 — строки, и разница читалась как
      // пропажа семидесяти заказов, которой не было.
      const rows = Number.isFinite(state.listB2CRows) ? state.listB2CRows : null;
      pkSyncEl.status.textContent +=
        `. «Товары» К выдаче ${state.expectedB2C}`
        + (rows === null ? '' : `, список отдал ${rows} строк`)
        + `; заказов ${state.collectedB2C}`
        + `; партнёров ${state.collectedPartners || 0}`;
      if (state.countDrift) {
        pkSyncEl.status.textContent += `. За время сбора выдали ${state.countDrift} — это норма`;
      }
      // Потеря ВНУТРИ расширения: список строки отдал, а в базу они не легли.
      // Это наш баг, и он важнее расхождения со счётчиком — говорим первым.
      // Переполнение хранилища: живые записи выбрасывались, чтобы влезла
      // история. Теперь так не бывает, но если случится — надо знать сразу.
      if (state.droppedLive) {
        pkSyncEl.status.textContent +=
          `. ХРАНИЛИЩЕ ПЕРЕПОЛНЕНО: выброшено ${state.droppedLive} живых записей`;
        pkSyncEl.status.dataset.state = 'err';
      }
      if (state.lostInMerge) {
        pkSyncEl.status.textContent +=
          `. ПОТЕРЯНО ПРИ ЗАПИСИ ${state.lostInMerge} — это ошибка расширения, сообщите`;
        pkSyncEl.status.dataset.state = 'err';
      }
      if (state.shortfall) {
        pkSyncEl.status.textContent += `. НЕ ХВАТАЕТ ${state.shortfall} — соберите ещё раз`;
        pkSyncEl.status.dataset.state = 'err';
      }
    }

    // ПРИЁМКА: столько же, сколько оператор видит на экране «Грузоместа».
    // Число берётся из счётчиков самих коробов (N/M у каждого), а не из
    // поимённого списка позиций: список отдаёт лишь часть содержимого.
    if (state.gmPlaces) {
      // ВСЕ ЧЕТЫРЕ ЧИСЛА, А НЕ ОДНО.
      //
      // Оператор сверяет их глазами с экраном «Грузоместа», где у каждого
      // короба своя пара N/M. Показать только итог значит заставить его
      // гадать, что именно мы сложили; показать всё — значит расхождение
      // видно сразу и на нужной строке.
      pkSyncEl.status.textContent +=
        `. Грузоместа: ${state.gmPlaces} коробов`
        + `; всего ${state.gmItemsTotal}`
        + `; размещено ${state.gmItemsAccepted}`
        + `; РАЗМЕСТИТЬ ${state.gmToAccept}`
        // Сколько строк БЕЗ ячейки мы собрали — это и есть наш ответ на то же
        // «разместить». Числа должны совпасть; если нет, расхождение названо
        // сразу и числом, а не оставлено оператору на глаз.
        + (state.gmToPlace !== undefined ? `; у нас ${state.gmToPlace}` : '')
        + (state.gmRows ? `; всего строк в коробах ${state.gmRows}` : '');
      if (state.gmShortfall) {
        pkSyncEl.status.textContent +=
          ` (не хватает ${state.gmShortfall} — соберите ещё раз)`;
        pkSyncEl.status.dataset.state = 'err';
      } else if (state.gmOverflow) {
        pkSyncEl.status.textContent +=
          ` (у нас на ${state.gmOverflow} больше, чем у WMS — покажите это разработчику)`;
        pkSyncEl.status.dataset.state = 'err';
      }
    }

    // ПОСТАВКИ — вторая половина работы приёмщика. Оператор складывает
    // числа с двух экранов: коробы на «Товарах» и поставки на «Заказах».
    // Показываем и сумму, чтобы не складывать в уме.
    if (state.supplySheets) {
      pkSyncEl.status.textContent +=
        `. Поставки: ${state.supplySheets} листов, ещё едет ${state.supplyItems}`;
    }
    if (state.gmToAccept || state.supplyItems) {
      pkSyncEl.status.textContent +=
        `. ВСЕГО РАБОТЫ: ${(state.gmToAccept || 0) + (state.supplyItems || 0)}`;
    }

    if (state.brokenOrders) {
      pkSyncEl.status.textContent +=
        `. По ${state.brokenOrders} заказам WMS не отдал товары (ошибка на его стороне) — `
        + 'ячеек у них нет, попробуем в следующий сбор';
      pkSyncEl.status.dataset.state = '';
    }

    // Часть шагов могла не выполниться — это не ошибка сбора, но знать
    // об этом нужно: иначе непонятно, почему в таблице нет грузомест.
    if (Array.isArray(state.warnings) && state.warnings.length) {
      pkSyncEl.status.textContent += `. Не удалось: ${state.warnings.join(', ')}`;
      pkSyncEl.status.dataset.state = '';
    }

    if (state.missingItemsTemplate) {
      pkSyncEl.status.textContent +=
        '. Ячейки FBO не собраны: откройте в WMS «К выдаче», отметьте любой заказ и нажмите «Перейти к выдаче» один раз — расширение запомнит адрес и дальше будет брать ячейки само.';
      pkSyncEl.status.dataset.state = '';
    }
    return;
  }
  pkSyncEl.status.textContent = '';
}

function pkPollSync() {
  chrome.runtime.sendMessage({ type: 'ucore:sync-status' }, (state) => {
    if (chrome.runtime.lastError) return;
    pkRenderSync(state);
    if (state?.running) {
      if (!pkSyncPoll) pkSyncPoll = setInterval(pkPollSync, 700);
    } else if (pkSyncPoll) {
      clearInterval(pkSyncPoll);
      pkSyncPoll = null;
      pkLoad();
    }
  });
}

/**
 * ПОЛНЫЙ СБОР ЗАНОВО.
 *
 * Обычный сбор не перечитывает то, что не меняется: справочник ячеек,
 * составы запечатанных пакетов, содержимое коробов, которые никто не
 * трогал. Это и делает повторное нажатие быстрым. Но кэш без кнопки
 * «перечитать всё» — ловушка: если данные когда-нибудь разойдутся с
 * реальностью, оператору нечем будет их выправить.
 */
if (pkSyncEl.full) {
  pkSyncEl.full.addEventListener('click', () => {
    pkSyncEl.status.textContent = 'Перечитываю всё заново…';
    pkSyncEl.status.dataset.state = '';
    pkSyncEl.progress.dataset.on = '1';
    pkSyncEl.button.disabled = true;
    chrome.runtime.sendMessage({ type: 'ucore:sync-all', full: true }, () => {
      if (chrome.runtime.lastError) {
        pkSyncEl.status.textContent = 'Фоновый процесс не отвечает — перезагрузите расширение';
        pkSyncEl.status.dataset.state = 'err';
        pkSyncEl.button.disabled = false;
        pkSyncEl.progress.dataset.on = '0';
        return;
      }
      pkPollSync();
      pkLoad();
    });
  });
}

document.getElementById('btn-print-encash').addEventListener('click', () => {
  // Печать — на отдельной странице: она в два захода, а попап закрывается
  // от любого клика мимо.
  chrome.tabs.create({ url: chrome.runtime.getURL('encash.html') });
});

const zeroToggle = document.getElementById('cash-zero');
if (zeroToggle) {
  zeroToggle.addEventListener('change', (e) => {
    cashZeroMode = e.target.checked;
    calculateTotals();
  });
}

pkSyncEl.button.addEventListener('click', () => {
  pkSyncEl.status.textContent = 'Запускаю…';
  pkSyncEl.status.dataset.state = '';
  pkSyncEl.progress.dataset.on = '1';
  pkSyncEl.button.disabled = true;

  chrome.runtime.sendMessage({ type: 'ucore:sync-all' }, () => {
    if (chrome.runtime.lastError) {
      pkSyncEl.status.textContent = 'Фоновый процесс не отвечает — перезагрузите расширение';
      pkSyncEl.status.dataset.state = 'err';
      pkSyncEl.button.disabled = false;
      pkSyncEl.progress.dataset.on = '0';
      return;
    }
    pkPollSync();
    pkLoad();
  });
  setTimeout(pkPollSync, 400);
});

// ---------- импорт CSV ----------

pkSyncEl.csv.addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  event.target.value = '';   // чтобы тот же файл можно было выбрать повторно

  try {
    const text = await file.text();
    const { records, unmapped, rowCount, delimiter } = recordsFromCsv(text, { endpoint: `csv:${file.name}` });

    if (!records.length) {
      pkStatus('В файле не нашлось строк с заказами', true);
      pkBanner(`Файл разобран (${rowCount} строк, разделитель «${delimiter}»), но ни в одной строке нет ни номера заказа, ни ШК, ни ГМ. Похоже, это не та выгрузка — или колонки названы непривычно. Нераспознанные колонки: ${unmapped.join(', ') || 'нет'}.`, 'warn');
      return;
    }

    // Слияние делает service worker — той же функцией, что и для сетевых
    // данных, чтобы дедупликация была ровно одна на весь проект.
    chrome.runtime.sendMessage({ type: 'ucore:merge-records', records }, (result) => {
      if (chrome.runtime.lastError || !result) {
        pkStatus('Не удалось сохранить импорт', true);
        return;
      }
      pkLoad(() => pkStatus(`Импортировано: новых ${result.added}, дополнено ${result.enriched}`));
      if (unmapped.length) {
        pkBanner(`Импортировано ${records.length} строк из ${rowCount}. Эти колонки расширение не узнало и не сохранило: ${unmapped.join(', ')}. Если среди них есть что-то нужное — скажите, добавлю.`, 'info');
      } else {
        pkBanner('');
      }
    });
  } catch (err) {
    pkStatus('Не удалось прочитать файл', true);
  }
});

pkPollSync();

// ==========================================
// 8. ИНВЕНТАРИЗАЦИЯ (запуск отдельной вкладкой)
// ==========================================

document.getElementById('inv-open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('inventory.html') });
  window.close();
});

function invRenderStats() {
  chrome.storage.local.get(['priemkaRecords', 'priemkaInventory'], (data) => {
    if (chrome.runtime.lastError) return;
    const withCell = (data.priemkaRecords || []).filter(r => r.cell);
    const cells = new Set(withCell.map(r => String(r.cell)));
    const session = data.priemkaInventory?.cells || {};

    let done = 0, missing = 0, extra = 0;
    for (const cell of Object.values(session)) {
      if (cell.done) done++;
      missing += (cell.missing || []).length;
      extra += (cell.extra || []).length;
    }

    document.getElementById('inv-stat-cells').textContent = cells.size;
    document.getElementById('inv-stat-done').textContent = done;
    const missEl = document.getElementById('inv-stat-missing');
    const extraEl = document.getElementById('inv-stat-extra');
    missEl.textContent = missing;
    missEl.dataset.state = missing ? 'warn' : 'ok';
    extraEl.textContent = extra;
    extraEl.dataset.state = extra ? 'warn' : 'ok';
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('priemkaInventory' in changes || 'priemkaRecords' in changes)) invRenderStats();
});

invRenderStats();

// Редактор схемы зала — инструмент специалиста внедрения, а не оператора:
// открывается отдельной вкладкой и настраивает то, чего нет в API WMS.
document.getElementById('pk-btn-full').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('priemka.html') });
});

document.getElementById('pk-btn-layout').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('layout.html') });
  window.close();
});

// ==========================================
// 9. НАСТРОЙКИ СБОРА
// ==========================================
// Поля для логина и пароля здесь СОЗНАТЕЛЬНО НЕТ.
//
// Симптом «расширение не видит, что я вошёл» вызывался не отсутствием
// пароля: WMS шлёт токен заголовком, а расширение отправляло только куки,
// и сервер отвечал 401 при совершенно живой сессии. Хранение пароля этого
// не лечит — расширению всё равно пришлось бы повторять ту же авторизацию,
// зато в chrome.storage.local лежал бы открытый пароль от рабочей системы.
//
// Вместо этого заголовок авторизации подхватывается из запросов, которые
// страница WMS делает сама. Пока оператор работает в WMS — доступ есть и
// обновляется вместе с сессией. Здесь мы лишь честно показываем его
// состояние, чтобы «не работает» никогда не было загадкой.

const pkSet = {
  panel: document.getElementById('pk-settings'),
  auto: document.getElementById('pk-set-auto'),
  interval: document.getElementById('pk-set-interval'),
  forget: document.getElementById('pk-set-forget'),
  auth: document.getElementById('pk-auth'),
  authText: document.getElementById('pk-auth-text')
};

function pkRenderAuth(auth) {
  const has = !!(auth && auth.headers && Object.keys(auth.headers).length);
  pkSet.auth.dataset.state = has ? 'ok' : 'none';

  if (!has) {
    pkSet.authText.textContent =
      'Доступ к WMS ещё не подхвачен. Откройте любую страницу dp.uzum.uz — расширение возьмёт его само, вводить ничего не нужно.';
    return;
  }

  const age = Date.now() - (auth.at || 0);
  const hours = Math.floor(age / 3600000);
  const when = new Date(auth.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  pkSet.authText.textContent = hours >= 8
    ? `Доступ есть, но получен давно (в ${when}). Если сбор вернёт ошибку — обновите вкладку WMS.`
    : `Доступ к WMS есть, обновлён в ${when}. Пароль не требуется.`;
}

function pkLoadSettings() {
  chrome.storage.local.get(['priemkaSettings', 'priemkaAuth'], (data) => {
    if (chrome.runtime.lastError) return;
    const s = { autoSync: true, intervalMinutes: 30, ...(data.priemkaSettings || {}) };
    pkSet.auto.checked = s.autoSync !== false;
    pkSet.interval.value = s.intervalMinutes;
    pkSet.interval.disabled = !pkSet.auto.checked;
    pkRenderAuth(data.priemkaAuth);
  });
}

function pkSaveSettings() {
  const settings = {
    autoSync: pkSet.auto.checked,
    intervalMinutes: Math.max(5, Math.min(720, Number(pkSet.interval.value) || 30))
  };
  pkSet.interval.disabled = !settings.autoSync;
  chrome.storage.local.set({ priemkaSettings: settings });
}

pkSet.auto.addEventListener('change', pkSaveSettings);
pkSet.interval.addEventListener('change', pkSaveSettings);

pkSet.forget.addEventListener('click', () => {
  chrome.storage.local.remove(['priemkaAuth'], () => {
    pkRenderAuth(null);
    pkStatus('Доступ забыт');
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('priemkaAuth' in changes || 'priemkaSettings' in changes)) pkLoadSettings();
});

pkLoadSettings();
