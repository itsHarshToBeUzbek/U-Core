// ==========================================
// infolist.js — страница предпросмотра и печати инфолиста
// ==========================================
// Обычно инфолист печатается прямо из попапа, не открывая ничего лишнего.
// Эта страница — запасной путь и предпросмотр: она нужна, когда печатать
// некуда (открыта chrome://-вкладка или страница магазина расширений, куда
// расширению хода нет) и когда лист хочется рассмотреть целиком до печати.
//
// Раскладку считает layoutSheets из infolist-sheet.js — тот же код, что и в
// попапе, чтобы предпросмотр и печать не разъезжались.

import { INFO_TEMPLATES, layoutSheets, INFOLIST_CSS, formatSheetDate } from './infolist-sheet.js';

const el = (id) => document.getElementById(id);
const sheets = el('sheets');

const style = document.createElement('style');
style.textContent = INFOLIST_CSS;
document.head.appendChild(style);

const state = { key: 'fbs', data: {}, parts: 1, fit: null };

function render() {
  const laid = layoutSheets(sheets, state.key, state.data);
  state.parts = laid.parts;
  state.fit = laid.fit;
  const count = laid.items;
  const copies = laid.copies;
  const data = state.data;

  const tpl = INFO_TEMPLATES[state.key];
  el('facts').innerHTML = `
    <div class="facts__row"><span>Тип</span><b>${tpl.title}</b></div>
    <div class="facts__row"><span>Отправитель</span><b>${data.sender || '—'}</b></div>
    <div class="facts__row"><span>Дата</span><b>${formatSheetDate(data.date) || '—'}</b></div>
    ${count ? `<div class="facts__row"><span>Позиций</span><b>${count}</b></div>` : ''}
    <div class="facts__row"><span>Листов на печать</span><b>${state.parts * copies}</b></div>`;

  const f = state.fit;
  const notes = [];
  if (state.parts > 1) {
    notes.push(`Позиции не помещаются на один лист — печатаем ${state.parts} листа, `
             + 'на каждом написано «лист N из M».');
  } else if (f && (f.cols > 1 || f.list < 1)) {
    notes.push(`Список разложен в ${f.cols} ${f.cols === 2 ? 'колонки' : 'колонки'}`
             + (f.list < 1 ? ` и уменьшен до ${Math.round(f.list * 100)}%` : '')
             + ' — иначе не влезал. Шапка осталась в полный размер.');
  }
  el('note').textContent = notes.join(' ');
  el('note').style.display = notes.length ? 'block' : 'none';
}

chrome.storage.local.get(['infolistPrint'], (saved) => {
  const payload = saved.infolistPrint;
  if (!payload || !INFO_TEMPLATES[payload.type]) {
    el('facts').innerHTML = '<div class="facts__row"><span>Нет данных для печати</span></div>';
    el('print').disabled = true;
    return;
  }
  state.key = payload.type;
  state.data = {
    ...payload,
    items: (payload.items || []).map(x => String(x).trim()).filter(Boolean),
    logoUrl: chrome.runtime.getURL('icons/uzum_logo.svg')
  };

  const start = () => {
    render();
    // Шрифт бланка (Bahnschrift) системный, но ждём готовности шрифтов:
    // подгонка по неготовому шрифту посчитает не те ширины.
    if (payload.auto) setTimeout(() => window.print(), 250);
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start);
  else start();
});

el('print').addEventListener('click', () => window.print());
