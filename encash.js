// ==========================================
// encash.js — страница печати инкассации
// ==========================================
// Отдельная страница, а не попап: попап Chrome закрывается, как только фокус
// ушёл, а печать здесь в ДВА захода — лицевые стороны, потом обороты. Терять
// состояние между ними нельзя.
//
// Что эта страница убирает из работы оператора: масштаб 70% (лист свёрстан
// в натуральную величину), выбор нечётных страниц (в каждом заходе на листе
// только нужная сторона) и перекладывание стопки руками (порядок считается
// из того, как принтер выдаёт бумагу).

import { buildPages, numberToWordsRu, formatActDate, migrateActConstants, ACT_DEFAULTS, ACT_CSS }
  from './encash-act.js';

// «Сумма в WMS» здесь СОЗНАТЕЛЬНО не читается. В акт идёт то, что физически
// уезжает в мешке, — сумма «Инкассация» из калькулятора, собранная из купюр
// по номиналам. Это не одно и то же: при недосдаче или излишке инкассация
// отличается от суммы WMS ровно на разницу, и печатать в банк сумму WMS
// значило бы обещать деньги, которых в мешке нет.
const KEYS = ['savedCounts', 'savedEncashCounts', 'savedBagNumber', 'savedBagAt',
              'savedEncashBlocked', 'cashZeroMode', 'encashActConstants',
              'encashPrinterInkjet', 'encashPrinterReverse',
              'wmsUserName'];

const el = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU').replace(/,/g, ' ');

const state = {
  data: null,
  constants: { ...ACT_DEFAULTS },
  inkjet: false,        // лазерный по умолчанию: он и есть у оператора
  frontDone: false
};

// ПОРЯДОК ПЕЧАТИ СЧИТАЕТСЯ ЗДЕСЬ, И ОН РАЗНЫЙ У ДВУХ ЗАХОДОВ.
//
// Оба принтера выдают лист НАПЕЧАТАННОЙ СТОРОНОЙ ВНИЗ, поэтому последний
// напечатанный лист оказывается сверху стопки. Между заходами стопка
// возвращается в лоток, и дальше всё решает то, с какого конца принтер её
// подхватит:
//
//   лазерный — кассета снизу, лист лежит, подхватывается СВЕРХУ стопки,
//              то есть в порядке, обратном печати;
//   струйный — лоток сзади, листы стоят, подхватывается с другого конца,
//              и порядок печати сохраняется.
//
// Отсюда:
//
//   обороты печатаются ВСЕГДА 3, 2, 1 — в этом порядке лежит стопка после
//   первого захода у лазерного и встаёт в лоток у струйного;
//   лицевые у лазерного идут 1, 2, 3, у струйного 3, 2, 1 — так, чтобы
//   стопка легла оборотами под свои листы, а готовая вышла первой нусхой
//   вверх.
//
// Раньше оба захода шли одним и тем же порядком, 3-2-1. Первый заход
// оставлял стопку первой нусхой сверху, второй печатал на неё оборот
// ТРЕТЬЕЙ — памятку «МИЖОЗНИНГ АХБОРОТИГА» вместо росписи купюр. В банк
// уезжал акт с чужим оборотом.
function passReverse(side) {
  return side === 'back' ? true : state.inkjet;
}

// Стили бланка живут в одном месте с самим бланком — иначе превью и печать
// разъезжаются, а это ровно та беда, из-за которой всё затевалось.
const styleTag = document.createElement('style');
styleTag.textContent = ACT_CSS;
document.head.appendChild(styleTag);

// КОЛЕСО МЫШИ НЕ МЕНЯЕТ ЧИСЛА. У number-инпута в фокусе колесо крутит
// значение, и прокрутка страницы над таким полем молча его переписывает.
document.addEventListener('wheel', (event) => {
  const el = document.activeElement;
  if (!el || el.type !== 'number') return;
  if (el !== event.target && !el.contains(event.target)) return;
  event.preventDefault();
}, { passive: false, capture: true });

/** Помечает листы стороной — по ней @media print прячет лишнюю половину. */
function markSides(root) {
  for (const sheet of root.querySelectorAll('.sheet')) {
    sheet.dataset.side = sheet.classList.contains('act') ? 'front' : 'back';
  }
}

function render() {
  const d = state.data;
  el('sheets').innerHTML =
    buildPages(d, { side: 'front', reverse: false }) +
    buildPages(d, { side: 'back', reverse: false });
  markSides(el('sheets'));

  el('facts').innerHTML = `
    <div class="facts__row"><span>Дата</span><b>${d.dateText}</b></div>
    <div class="facts__row"><span>Номер мешка</span><b>${d.bagNumber || '— не указан —'}</b></div>
    <div class="facts__row facts__row--big"><span>Инкассация</span><b>${fmt(d.amount)}</b></div>
    <div class="facts__row"><span>Экземпляров</span><b>${state.constants.copies}</b></div>`;

  // Как класть стопку обратно — теми же словами, какими описан лоток:
  // напечатанная сторона и верхний край. Порядок листов не трогаем.
  el('feed-hint').innerHTML = state.inkjet
    ? 'Возьмите стопку как она вышла — <b>не переворачивайте</b> и не меняйте порядок листов. '
      + 'Поставьте её в задний лоток <b>напечатанной стороной вправо, верхним краем вниз</b> — '
      + 'так же, как стоит чистая бумага.'
    : 'Возьмите стопку как она вышла — <b>не переворачивайте</b> и не меняйте порядок листов. '
      + 'Положите её в кассету <b>напечатанной стороной вниз, верхним краем вправо</b> — '
      + 'так же, как лежит чистая бумага.';
}

function warn(text, level) {
  const box = el('warn');
  if (!text) { box.style.display = 'none'; return; }
  box.textContent = text;
  box.dataset.state = level || 'warn';
  box.style.display = 'block';
}

function print(side) {
  el('sheets').innerHTML = buildPages(state.data, { side, reverse: passReverse(side) });
  markSides(el('sheets'));

  document.body.dataset.print = side;
  window.print();
  document.body.removeAttribute('data-print');
  render();
}

chrome.storage.local.get(KEYS, (saved) => {
  state.constants = migrateActConstants(saved.encashActConstants, saved.wmsUserName);
  // Прежний тумблер назывался «выдаёт лицом вверх» и означал лазерный.
  // Читаем его один раз, чтобы выбор оператора не сбросился.
  if (saved.encashPrinterInkjet !== undefined) state.inkjet = saved.encashPrinterInkjet === true;
  else if (saved.encashPrinterReverse !== undefined) state.inkjet = saved.encashPrinterReverse === false;
  el('inkjet').checked = state.inkjet;

  // Сумма акта = сумма ИНКАССАЦИИ: столько купюр каждого номинала уходит
  // в мешок. Складываем их здесь, а не берём готовое число, чтобы роспись
  // купюр на обороте и сумма на лицевой стороне не могли разойтись.
  const counts = saved.savedEncashCounts || {};
  const amount = Object.entries(counts)
    .reduce((sum, [denom, n]) => sum + Number(denom) * (Number(n) || 0), 0);

  state.data = {
    dateText: formatActDate(new Date()),
    bagNumber: saved.savedBagNumber === undefined ? '' : String(saved.savedBagNumber),
    amount,
    amountWords: numberToWordsRu(amount),
    counts,
    constants: state.constants
  };

  // ПЕЧАТАТЬ ПУСТОЙ ИЛИ ЗАВЕДОМО НЕВЕРНЫЙ БЛАНК — ХУЖЕ, ЧЕМ НЕ ПЕЧАТАТЬ.
  if (saved.savedEncashBlocked) {
    warn('Авто-расчёт кассы отключён: недосдача больше сдачи. Разберитесь с деньгами '
       + 'на вкладке «Инкассация» — печатать этот бланк нельзя.', 'bad');
    el('print-front').disabled = true;
  } else if (!amount) {
    warn('Инкассация нулевая: посчитайте купюры на вкладке «Инкассация».', 'bad');
    el('print-front').disabled = true;
  } else if (!state.data.bagNumber) {
    warn('Номер мешка не указан — в бланке останется пустое поле.', 'warn');
  } else if (!String(state.constants.chief || '').trim()) {
    warn('Фамилия в строке «Хужалик юритувчи субъект рахбари» не заполнена. '
       + 'Расширение берёт её из левого нижнего угла WMS — откройте WMS или '
       + 'впишите её в реквизитах ниже.', 'warn');
  } else if (saved.cashZeroMode) {
    warn('Касса обнуляется: в инкассацию уходит вся сумма, сдача не остаётся.', 'warn');
  }

  for (const [id, key] of [['c-sender', 'sender'], ['c-receiver', 'receiver'], ['c-account', 'account'],
                           ['c-bank', 'bankName'], ['c-mfo', 'mfo'], ['c-chief', 'chief'],
                           ['c-copies', 'copies']]) {
    const input = el(id);
    input.value = state.constants[key];
    input.addEventListener('input', () => {
      const value = key === 'copies' ? Math.max(1, Math.min(3, Number(input.value) || 1)) : input.value;
      state.constants[key] = value;
      state.data.constants = state.constants;
      chrome.storage.local.set({ encashActConstants: state.constants });
      render();
    });
  }

  // Реквизиты могли приехать из старой версии кириллицей — сохраняем
  // выправленные, чтобы в следующий раз не выправлять снова.
  chrome.storage.local.set({ encashActConstants: state.constants });

  render();

  // Шрифт бланка вшит в стиль, но грузится всё равно асинхронно. Печать до
  // его загрузки нарисует лист системным шрифтом — другой ширины, с уехавшей
  // выключкой. Пока не загрузился, печатать не даём.
  if (document.fonts && document.fonts.load) {
    const back = el('print-back');
    const front = el('print-front');
    const wasFront = front.disabled;
    front.disabled = true;
    document.fonts.load('10pt ActInter', 'Далолатнома 0123456789')
      .catch(() => {})
      .then(() => { front.disabled = wasFront; if (state.frontDone) back.disabled = false; });
  }
});

el('inkjet').addEventListener('change', (e) => {
  state.inkjet = e.target.checked;
  chrome.storage.local.set({ encashPrinterInkjet: state.inkjet });
  render();
});

el('print-front').addEventListener('click', () => {
  print('front');
  state.frontDone = true;
  el('step1').dataset.done = '1';
  el('print-back').disabled = false;
  el('print-back').textContent = 'Печатать обороты';
});

el('print-back').addEventListener('click', () => {
  print('back');
  el('step2').dataset.done = '1';
});
