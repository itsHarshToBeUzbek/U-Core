// ==========================================
// app.js — страница предпросмотра и печати АПП
// ==========================================
// Обычно акт печатается прямо из попапа, не открывая ничего лишнего. Эта
// страница — запасной путь и предпросмотр: она нужна, когда печатать некуда
// (открыта chrome://-вкладка или магазин расширений, куда расширению хода
// нет) и когда лист хочется рассмотреть целиком до печати.

import { buildAppSheets, APP_TYPES, APP_CSS, formatAppDate, ROWS_PER_SHEET } from './app-sheet.js';

const el = (id) => document.getElementById(id);

const style = document.createElement('style');
style.textContent = APP_CSS;
document.head.appendChild(style);

function render(data) {
  const built = buildAppSheets(data);
  el('sheets').innerHTML = built.html;

  const tpl = APP_TYPES[data.type] || APP_TYPES.diagnostic;
  const items = (data.items || []).filter(i => (i.order || '').trim() || (i.barcode || '').trim());
  el('facts').innerHTML = `
    <div class="facts__row"><span>Вид</span><b>${tpl.n}. ${tpl.title}</b></div>
    <div class="facts__row"><span>Администратор</span><b>${data.admin || '—'}</b></div>
    <div class="facts__row"><span>Табельный номер</span><b>${data.tabel || '—'}</b></div>
    <div class="facts__row"><span>Дата</span><b>${formatAppDate(data.date) || '—'}</b></div>
    <div class="facts__row"><span>ПВЗ</span><b>${data.pvz || '—'}</b></div>
    <div class="facts__row"><span>Заказов</span><b>${items.length}</b></div>
    <div class="facts__row"><span>Листов на печать</span><b>${built.parts * built.copies}</b></div>`;

  const notes = [];
  if (built.parts > 1) {
    notes.push(`Заказов больше ${ROWS_PER_SHEET} — акт разделён на ${built.parts} листа: `
             + 'у каждого свой номер и «Стр. N из M».');
  }
  el('note').textContent = notes.join(' ');
  el('note').style.display = notes.length ? 'block' : 'none';
  return built;
}

chrome.storage.local.get(['appPrint'], (saved) => {
  const payload = saved.appPrint;
  if (!payload) {
    el('facts').innerHTML = '<div class="facts__row"><span>Нет данных для печати</span></div>';
    el('print').disabled = true;
    return;
  }
  const start = () => {
    render(payload);
    // Шрифт бланка (Calibri) системный, но ждём готовности шрифтов: подгонка
    // по неготовому шрифту посчитает не те ширины.
    if (payload.auto) setTimeout(() => window.print(), 250);
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start);
  else start();
});

el('print').addEventListener('click', () => window.print());
