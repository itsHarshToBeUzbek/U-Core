// ==========================================
// row-list.js — список полей, который растёт по Enter
// ==========================================
// Один и тот же список нужен трижды: номера в инфолисте, заказы в АПП и
// всё, что появится дальше. Раньше это была одна большая textarea — номера
// в ней слипались, лишний перенос строки давал пустую позицию, а сколько
// их набрано, приходилось считать глазами.
//
// В строке может быть несколько полей, и они бывают двух видов:
//
//   * text — обычный ввод;
//   * flag — переключатель на два положения. В АПП это «вскрыта / не
//     вскрыта»: у девяноста девяти заказов из ста коробка целая, поэтому
//     это не выпадающий список, который надо открыть на каждой строке, а
//     одно нажатие, и по умолчанию стоит нормальное состояние. Отличается
//     от нормального — видно цветом: важен именно редкий случай.
//
// Колонку можно ВЫВЕСТИ ИЗ ПУТИ ENTER (setEnterSkip), не убирая её с глаз:
// на классике ШК товара не переписывают, и Enter должен вести сразу на
// следующую строку — но само поле остаётся, потому что «не переписывают»
// не значит «никогда». Поле на месте, мышью и Tab до него доберёшься, и
// вписанное в него печатается.
//
// Переключатели в пути Enter не стоят НИКОГДА. Enter — это «дальше», а не
// «поменяй»; заход на переключатель по дороге к следующей строке ставил бы
// «вскрыта» тому, кто просто шёл вперёд.
//
// Вставка столбца из Excel или из выгрузки WMS раскладывается по строкам
// сама: оператор всё равно вставит — вопрос только в том, разложим мы это
// или напечатаем в одну строку.
//
// Проверка на повтор смотрит ТОЛЬКО первую колонку и ничего не запрещает:
// второй такой же номер — это либо двойной удар сканером, либо реальная
// вторая позиция. Решает оператор, но увидеть он это должен.

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host      контейнер строк
 * @param {HTMLElement} [opts.countEl] куда писать число заполненных строк
 * @param {HTMLElement} [opts.addBtn]  кнопка «ещё строка»
 * @param {Array<{key:string, type?:'text'|'flag', placeholder?:string,
 *                flex?:number, on?:string, off?:string, title?:string}>} opts.columns
 * @param {number} [opts.max]          сколько строк имеет смысл держать
 * @param {Function} [opts.onChange]   вызывается после любого изменения
 */
export function createRowList({ host, countEl, addBtn, columns, max = 400, onChange }) {
  const keys = columns.map(c => c.key);
  const byKey = Object.fromEntries(columns.map(c => [c.key, c]));
  const textKeys = columns.filter(c => (c.type || 'text') === 'text').map(c => c.key);
  const single = textKeys.length === 1;
  const skipped = new Set();

  const rows = () => [...host.querySelectorAll('.ilist__row')];
  const cellsOf = (row) => [...row.querySelectorAll('[data-key]')];
  /** Куда ведёт Enter: только текстовые поля и только не выведенные из пути. */
  const path = (row) => cellsOf(row).filter(
    c => c.tagName === 'INPUT' && !skipped.has(c.dataset.key));
  const cell = (row, key) => row.querySelector(`[data-key="${key}"]`);

  const readCell = (el) => el.tagName === 'BUTTON'
    ? (el.dataset.on === '1' ? byKey[el.dataset.key].on : byKey[el.dataset.key].off)
    : el.value.trim();

  // Пока конструктор не вернул объект, звать onChange нельзя: вызывающий код
  // почти всегда держит список в const и обращается к нему из обработчика,
  // а до присваивания эта переменная в мёртвой зоне — исключение оттуда
  // рвёт весь модуль, и молча отваливаются кнопки ниже по файлу.
  let booted = false;

  /** Строки как объекты; пустые отброшены. */
  function values() {
    return rows().map((row) => {
      const out = {};
      for (const el of cellsOf(row)) out[el.dataset.key] = readCell(el);
      return out;
    }).filter(o => textKeys.some(k => o[k]));
  }

  function refresh() {
    const seen = new Set();
    rows().forEach((row, i) => {
      row.querySelector('.ilist__n').textContent = i + 1;
      const first = cell(row, textKeys[0]).value.trim();
      const dupe = !!first && seen.has(first);
      if (first) seen.add(first);
      row.classList.toggle('ilist__row--dupe', dupe);
      row.title = dupe ? 'Такой номер уже есть выше' : '';
    });
    if (countEl) countEl.textContent = values().length;
    if (booted && onChange) onChange();
  }

  function cellHtml(c) {
    const style = c.flex ? ` style="flex:${c.flex}"` : '';
    if ((c.type || 'text') === 'flag') {
      return `<button type="button" class="ilist__flag" data-key="${c.key}" data-on="0"`
           + `${c.title ? ` title="${c.title}"` : ''}${style}>${c.off}</button>`;
    }
    return `<input type="text" spellcheck="false" autocomplete="off" data-key="${c.key}"`
         + (c.placeholder ? ` placeholder="${c.placeholder}"` : '') + style + '>';
  }

  function setFlag(el, on) {
    el.dataset.on = on ? '1' : '0';
    el.textContent = on ? byKey[el.dataset.key].on : byKey[el.dataset.key].off;
  }

  function makeRow(value) {
    const row = document.createElement('div');
    row.className = 'ilist__row';
    row.innerHTML = `<span class="ilist__n"></span>${columns.map(cellHtml).join('')}`
      + `<button type="button" class="ilist__del" title="Убрать строку" aria-label="Убрать строку">`
      + `<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor"`
      + ` stroke-width="2.2" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg></button>`;
    if (value && typeof value === 'object') {
      for (const c of columns) {
        const el = cell(row, c.key);
        if (value[c.key] === undefined) continue;
        if ((c.type || 'text') === 'flag') setFlag(el, value[c.key] === c.on || value[c.key] === true);
        else el.value = value[c.key] || '';
      }
    } else if (value) {
      cell(row, textKeys[0]).value = String(value);
    }
    return row;
  }

  function addRow(value = null, after = null, focus = true) {
    if (rows().length >= max) return null;
    const row = makeRow(value);
    if (after && after.parentNode === host) after.after(row);
    else host.appendChild(row);
    refresh();
    if (focus) path(row)[0].focus();
    return row;
  }

  function setValues(list) {
    host.innerHTML = '';
    const src = (list && list.length) ? list : [null];
    for (const v of src) host.appendChild(makeRow(v));
    refresh();
  }

  /** Вывести колонку из пути Enter (или вернуть). Само поле остаётся. */
  function setEnterSkip(key, skip) {
    if (skip) skipped.add(key); else skipped.delete(key);
    host.dataset.skip = [...skipped].join(' ');
  }

  host.addEventListener('keydown', (e) => {
    const el = e.target.closest('[data-key]');
    if (!el || !host.contains(el)) return;
    const row = el.closest('.ilist__row');
    const line = path(row);
    const at = line.indexOf(el);

    if (e.key === 'Enter') {
      // Enter ведёт вправо по текстовым полям, потом на следующую строку.
      // Мимо переключателей и мимо колонок, выведенных из пути: попасть на
      // них по дороге вперёд — не то, ради чего жмут Enter. Если фокус СЕЙЧАС
      // на переключателе (пришли туда мышью), Enter уводит на следующую
      // строку и ничего не переключает.
      e.preventDefault();
      if (at >= 0 && at < line.length - 1) { line[at + 1].focus(); return; }
      const next = row.nextElementSibling;
      if (next) path(next)[0].focus();
      else addRow(null, row);
    } else if (e.key === 'Backspace' && el.tagName === 'INPUT' && !el.value
               && at === 0 && rows().length > 1) {
      e.preventDefault();
      const prev = row.previousElementSibling;
      const next = row.nextElementSibling;
      row.remove();
      refresh();
      const target = prev || next;
      if (target) {
        const f = path(target)[0];
        f.focus();
        if (f.setSelectionRange) f.setSelectionRange(f.value.length, f.value.length);
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Стрелки ходят по ВСЕМ полям строки, включая выведенные из пути и
      // переключатель: это осознанный шаг вбок, а не поток ввода.
      const sibling = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
      if (!sibling) return;
      e.preventDefault();
      const col = cellsOf(row).indexOf(el);
      const other = cellsOf(sibling);
      other[Math.min(col, other.length - 1)].focus();
    }
  });

  host.addEventListener('input', refresh);

  host.addEventListener('click', (e) => {
    const flag = e.target.closest('.ilist__flag');
    if (flag) { setFlag(flag, flag.dataset.on !== '1'); refresh(); return; }
    const del = e.target.closest('.ilist__del');
    if (!del) return;
    const row = del.closest('.ilist__row');
    if (rows().length === 1) {
      for (const c of columns) {
        const el = cell(row, c.key);
        if ((c.type || 'text') === 'flag') setFlag(el, false); else el.value = '';
      }
      refresh();
      return;
    }
    row.remove();
    refresh();
  });

  host.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text || !/[\n\r\t;]/.test(text)) return;
    const target = e.target.closest('input[data-key]');
    if (!target) return;
    e.preventDefault();
    let anchor = target.closest('.ilist__row');

    // Столбец из Excel приходит строками, таблица — строками с табуляцией.
    // Раскладываем по колонкам ровно так, как вставили; переключатели при
    // вставке не трогаем — их ставит человек, глядя на коробку.
    const lines = text.split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
    const table = lines.map(l => l.split(/[\t;]/).map(s => s.trim()));
    const parts = single
      ? table.flat().filter(Boolean).map(v => ({ [textKeys[0]]: v }))
      : table.map(cs => Object.fromEntries(textKeys.map((k, i) => [k, cs[i] || ''])));
    if (!parts.length) return;

    for (const k of textKeys) if (parts[0][k] !== undefined) cell(anchor, k).value = parts[0][k];
    for (const v of parts.slice(1)) {
      const created = addRow(v, anchor, false);
      if (!created) break;
      anchor = created;
    }
    refresh();
    path(anchor)[0].focus();
  });

  if (addBtn) addBtn.addEventListener('click', () => addRow(null, host.lastElementChild));

  setValues([]);
  booted = true;
  return { values, setValues, addRow, refresh, rows, setEnterSkip };
}
