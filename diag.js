// ==========================================
// diag.js — страница печати акта на диагностику
// ==========================================
// Отдельная страница, а не попап: попап Chrome закрывается, как только фокус
// ушёл, а печать здесь в ДВА захода — лицевые стороны, потом обороты. Терять
// состояние между ними нельзя.
//
// ТРИ ЭКЗЕМПЛЯРА: один остаётся у покупателя, два уезжают на склад.

import { buildDiagPages, diagMissing, DIAG_COPIES, DIAG_CSS } from './diag-act.js';

const el = (id) => document.getElementById(id);

// Все три экземпляра одинаковые, поэтому порядок листов здесь ничего не
// решает — в отличие от инкассации, где у каждой нусхи свой оборот. Тумблер
// нужен только для подсказки: как вернуть стопку в лоток.
const state = { data: null, inkjet: false, frontDone: false };

const styleTag = document.createElement('style');
styleTag.textContent = DIAG_CSS;
document.head.appendChild(styleTag);

// КОЛЕСО МЫШИ НЕ МЕНЯЕТ ЧИСЛА. У number-инпута в фокусе колесо крутит
// значение, и прокрутка страницы над таким полем молча его переписывает.
document.addEventListener('wheel', (event) => {
  const active = document.activeElement;
  if (!active || active.type !== 'number') return;
  if (active !== event.target && !active.contains(event.target)) return;
  event.preventDefault();
}, { passive: false, capture: true });

/** Помечает листы стороной — по ней @media print прячет лишнюю половину. */
function markSides(root) {
  for (const sheet of root.querySelectorAll('.sheet')) {
    sheet.dataset.side = sheet.classList.contains('diag-back') ? 'back' : 'front';
  }
}

function render() {
  const d = state.data;
  el('sheets').innerHTML = buildDiagPages(d, { side: 'front' }) + buildDiagPages(d, { side: 'back' });
  markSides(el('sheets'));

  el('facts').innerHTML = `
    <div class="facts__row"><span>Заказ</span><b>${d.order || '— не указан —'}</b></div>
    <div class="facts__row"><span>Товар</span><b>${d.item || '—'}</b></div>
    <div class="facts__row"><span>Покупатель</span><b>${d.client || '—'}</b></div>
    <div class="facts__row"><span>Дата возврата</span><b>${d.returnDate || '—'}</b></div>
    <div class="facts__row"><span>Экземпляров</span><b>${DIAG_COPIES}</b></div>`;

  // Как класть стопку обратно — теми же словами, какими описан лоток.
  el('feed-hint').innerHTML = state.inkjet
    ? 'Возьмите стопку как она вышла — <b>не переворачивайте</b> её. Поставьте в задний лоток '
      + '<b>напечатанной стороной вправо, верхним краем вниз</b> — так же, как стоит чистая бумага.'
    : 'Возьмите стопку как она вышла — <b>не переворачивайте</b> её. Положите в кассету '
      + '<b>напечатанной стороной вниз, верхним краем вправо</b> — так же, как лежит чистая бумага.';
}

function warn(text, level) {
  const box = el('warn');
  if (!text) { box.style.display = 'none'; return; }
  box.textContent = text;
  box.dataset.state = level || 'warn';
  box.style.display = 'block';
}

function print(side) {
  const html = buildDiagPages(state.data, { side });
  el('sheets').innerHTML = html;
  markSides(el('sheets'));

  document.body.dataset.print = side;
  window.print();
  document.body.removeAttribute('data-print');
  render();
}

chrome.storage.local.get(['diagPrint', 'diagPrinterInkjet', 'diagPrinterReverse'], (saved) => {
  const payload = saved.diagPrint;
  if (saved.diagPrinterInkjet !== undefined) state.inkjet = saved.diagPrinterInkjet === true;
  else if (saved.diagPrinterReverse !== undefined) state.inkjet = saved.diagPrinterReverse === false;
  el('inkjet').checked = state.inkjet;

  if (!payload) {
    warn('Нет данных для печати: заполните акт на вкладке «Диагностика».', 'bad');
    el('facts').innerHTML = '<div class="facts__row"><span>Нет данных для печати</span></div>';
    el('print-front').disabled = true;
    return;
  }

  state.data = { ...payload, copies: DIAG_COPIES };

  // ПЕЧАТАТЬ ПУСТОЙ АКТ ХУЖЕ, ЧЕМ НЕ ПЕЧАТАТЬ: по нему товар возвращают
  // владельцу, и без номера заказа или дефекта он ничего не доказывает.
  const missing = diagMissing(state.data);
  if (missing.length) warn(`Не заполнено: ${missing.join(', ')}.`, 'bad');

  render();

  const start = () => { if (payload.auto) setTimeout(() => print('front'), 250); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start);
  else start();
});

el('inkjet').addEventListener('change', (e) => {
  state.inkjet = e.target.checked;
  chrome.storage.local.set({ diagPrinterInkjet: state.inkjet });
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
