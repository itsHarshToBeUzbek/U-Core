// ==========================================
// placement.js — помощник размещения (экран «Отправления»)
// ==========================================
// Работает поверх штатного экрана dp.uzum.uz/delivery-point/shipments/*.
// Как только оператор просканировал товар, показывает СВОЮ рекомендацию
// ячейки рядом с рекомендациями WMS и называет её голосом целиком.
//
// ЧТО СНЯТО С ЖИВОГО ЭКРАНА 02.09.2026 (ТАШ-120, WMS 3.90.5 build 5946823):
//
//   маршрут   /delivery-point/shipments/:tab?/:cargoPlaceBarcode?/:skuBarcode?
//             ← ГМ и штрихкод товара лежат ПРЯМО В АДРЕСЕ. Это и есть самый
//               надёжный признак «что сейчас на экране»: не зависит ни от
//               вёрстки, ни от языка, ни от того, успел ли отрисоваться DOM.
//
//   слева     .shipments-block > .shipments > .shipments-container
//               «Грузоместо №85-…»
//               .sku-card > .sku-card-section (подпись .BodySMedium + значение)
//                  Наименование / Штрихкод / К размещению
//
//   справа    .recommend-cells-block
//               h4.recommend-cells-title  = «Рекомендованные»
//               .recommend-cells          = flex, gap 16px, wrap
//                  .cell.recommended-cell = 170×104, текст — номер ячейки
//               (их может быть НЕСКОЛЬКО: видели 233 и 234)
//
// Отсюда два вывода, на которых всё построено:
//   * встраиваться надо ВНУТРЬ .recommend-cells — тогда наша карточка сама
//     встаёт справа от чужих, с тем же отступом, и чужую вёрстку мы не трогаем;
//   * «К размещению» есть и на ВКЛАДКЕ сверху, и в карточке товара. Искать
//     по тексту во всём документе нельзя — найдётся вкладка. Поэтому чтение
//     карточки ограничено .sku-card.
//
// ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ:
//   * ни одного клика по кнопкам WMS — размещает человек;
//   * ни одного касания чужой озвучки: у WMS свой тумблер «Выключить
//     озвучку». Тихо выключить чужой звук — значит однажды лишить оператора
//     сигнала, на который он привык полагаться. Мы только подсказываем, где
//     этот тумблер;
//   * ни одного запроса в сеть ради рекомендации: она считается из уже
//     собранных данных, поэтому появляется мгновенно.

(function () {
  'use strict';

  const LOG = '[U-Core размещение]';
  const ID = 'ucore-placement';

  // ------------------------------------------------------------------
  // Что сейчас на экране — из адреса
  // ------------------------------------------------------------------

  /**
   * Что сейчас на экране.
   *
   * ГЛАВНЫЙ ИСТОЧНИК — КАРТОЧКА, а не адрес. Это исправление после проверки
   * на живом ПВЗ 03.09.2026: когда оператор сканирует товар СКАНЕРОМ,
   * маршрут остаётся `/delivery-point/shipments/PLACEMENT` — ГМ и штрихкод
   * в него НЕ попадают. Они появляются в адресе только если открыть ссылку
   * вида .../PLACEMENT/<ГМ>/<ШК> руками. Пока личность бралась из адреса,
   * при настоящем сканировании помощник вечно показывал «ждём скан».
   *
   * Адрес остаётся ВТОРЫМ источником: по нему состояние восстанавливается
   * после перезагрузки и воспроизводится по ссылке.
   */
  function identity() {
    const parts = location.pathname.split('/').filter(Boolean);
    const at = parts.indexOf('shipments');
    if (at < 0) return { onScreen: false, gm: null, sku: null };

    const fromUrlGm = parts[at + 2] ? decodeURIComponent(parts[at + 2]) : null;
    const fromUrlSku = parts[at + 3] ? decodeURIComponent(parts[at + 3]) : null;

    const card = readCard();
    const gmEl = gmLabel();
    return {
      onScreen: true,
      tab: parts[at + 1] || null,
      gm: gmEl || fromUrlGm,
      sku: card.barcode || fromUrlSku,
      card
    };
  }

  /** Номер грузоместа из заголовка карточки: «Грузоместо №85-0008983088». */
  function gmLabel() {
    const scope = document.querySelector('.shipments') || document;
    for (const el of scope.querySelectorAll('div,span,p,h1,h2,h3,h4')) {
      const t = el.textContent.trim();
      if (!t.startsWith('Грузоместо №')) continue;
      const m = t.match(/№\s*([\w-]+)/);
      if (m) return m[1];
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Чтение экрана
  // ------------------------------------------------------------------

  function leafWithText(text, root) {
    const scope = root || document;
    const wanted = String(text).trim();
    for (const el of scope.querySelectorAll('div,span,p,h1,h2,h3,h4,h5,label,button,td,th,li')) {
      if (el.children.length) continue;
      if (el.textContent.trim() === wanted) return el;
    }
    return null;
  }

  /** Блок рекомендаций WMS. Сначала по имени класса, потом по подписи. */
  function recBlock() {
    const row = document.querySelector('.recommend-cells');
    if (row) {
      const cells = [...row.querySelectorAll('.recommended-cell')]
        .filter(el => !el.classList.contains('ucore-cell'));
      const values = cells.map(el => el.textContent.trim()).filter(v => /^\d{3,4}$/.test(v));
      return { row, cells, values };
    }
    // Запасной путь 1: класс переименовали — ищем по видимой подписи.
    const title = leafWithText('Рекомендованные');
    if (title && title.parentElement) {
      const holder = title.parentElement;
      const cells = [...holder.querySelectorAll('*')].filter(
        el => !el.children.length && /^\d{3,4}$/.test(el.textContent.trim())
              && !el.closest('.' + ID + '-cell'));
      return { row: holder, cells, values: cells.map(el => el.textContent.trim()), fallback: 'title' };
    }

    // Запасной путь 2: WMS не предложил НИЧЕГО — блока рекомендаций на
    // экране просто нет. Своя рекомендация в этом случае нужнее всего,
    // поэтому вешаем её в панель выбора ячейки своими руками.
    const panel = leafWithText('Сканирование и выбор ячейки');
    const host = panel && panel.parentElement;
    if (!host) return null;
    let own = document.getElementById(ID + '-row');
    if (!own) {
      own = document.createElement('div');
      own.id = ID + '-row';
      own.className = 'recommend-cells';
      own.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;';
      host.appendChild(own);
    }
    return { row: own, cells: [], values: [], fallback: 'own' };
  }

  /**
   * Поля карточки товара. Ищем ТОЛЬКО внутри .sku-card: подпись
   * «К размещению» есть ещё и на вкладке сверху, и поиск по всему
   * документу находит именно её.
   */
  function readCard() {
    const card = document.querySelector('.sku-card');
    const out = { name: null, barcode: null, qty: null };
    if (!card) return out;
    for (const section of card.querySelectorAll('.sku-card-section, div')) {
      const text = (section.innerText || '').trim();
      if (!text.includes('\n')) continue;
      const [label, ...rest] = text.split('\n');
      const value = rest.join(' ').trim();
      const key = label.trim();
      if (key === 'Наименование' && !out.name) out.name = value;
      else if (key === 'Штрихкод' && !out.barcode) out.barcode = value.replace(/\D+/g, '');
      else if (key === 'К размещению' && out.qty === null) out.qty = Number(value.replace(/\D+/g, '')) || 1;
    }
    return out;
  }

  /** Форма готова: пока нет кнопки, размещать некуда, и советовать рано. */
  function placementReady() {
    return !!leafWithText('Разместить');
  }

  /** Ячейка, выбранная оператором (нужна, чтобы знать, куда он реально положил). */
  function chosenCell() {
    const sel = document.querySelector('select');
    if (sel && /^\d{3,4}$/.test(String(sel.value || '').trim())) return String(sel.value).trim();
    const label = leafWithText('Ячейка');
    if (!label || !label.parentElement) return null;
    const text = (label.parentElement.innerText || '').replace('Ячейка', '').trim().split('\n')[0];
    const code = String(text || '').replace(/\D+/g, '');
    return /^\d{3,4}$/.test(code) ? code : null;
  }

  /** Экран перекрыт чужой бедой: истёкшая сессия, модалка ошибки. */
  function blocked() {
    const text = document.body ? document.body.innerText || '' : '';
    return /срок действия сессии|Jwt is expired|Ошибка:\s*\d/i.test(text);
  }

  // ------------------------------------------------------------------
  // Состояние
  // ------------------------------------------------------------------

  const state = {
    key: null,          // gm|sku — «тот же товар или новый»
    cell: null,
    wms: [],
    spoken: null,
    voice: true,
    hintSeen: false,
    open: null,         // {sku, gm, cell, at} — товар, который сейчас на экране
    shown: null,        // последнее показанное решение — для перерисовки
    wmsShown: null,     // с какими числами WMS его сравнивали
    lastChosen: null,
    placements: [],
    speedOn: false,
    total: null,
    goal: null
  };

  const ui = {};

  // ------------------------------------------------------------------
  // Оформление
  // ------------------------------------------------------------------

  function styles() {
    if (document.getElementById(ID + '-css')) return;
    const css = document.createElement('style');
    css.id = ID + '-css';
    css.textContent = `
      .${ID}-cell {
        min-width: 170px; min-height: 104px; box-sizing: border-box;
        border-radius: 14px; padding: 12px 16px; position: relative;
        display: flex; flex-direction: column; justify-content: center; gap: 3px;
        background: linear-gradient(160deg, #350A6B 0%, #16002F 100%);
        color: #fff; font-family: inherit;
        box-shadow: 0 0 0 2px rgba(155,105,255,.7), 0 10px 34px rgba(78,0,150,.4);
      }
      .${ID}-cell[data-state="same"] {
        background: linear-gradient(160deg, #0B5A3E 0%, #032418 100%);
        box-shadow: 0 0 0 2px rgba(46,200,138,.7), 0 10px 34px rgba(0,95,62,.35);
      }
      .${ID}-cell[data-state="none"] {
        background: linear-gradient(160deg, #3B3B46 0%, #1F1F27 100%);
        box-shadow: 0 0 0 2px rgba(255,255,255,.18);
      }
      .${ID}-tag {
        font-size: 10px; font-weight: 800; letter-spacing: .16em;
        text-transform: uppercase; opacity: .72;
      }
      .${ID}-big {
        font-size: 44px; font-weight: 800; line-height: 1;
        font-variant-numeric: tabular-nums; letter-spacing: -.01em;
      }
      .${ID}-big[data-flash="1"] { animation: ${ID}-pop .45s ease-out; }
      @keyframes ${ID}-pop { from { transform: scale(.8); opacity: .35; } to { transform: scale(1); opacity: 1; } }
      .${ID}-note { font-size: 11px; font-weight: 700; opacity: .92; }
      .${ID}-why { font-size: 10.5px; opacity: .8; line-height: 1.3; max-width: 22ch; }
      .${ID}-mute {
        position: absolute; top: 6px; right: 8px; cursor: pointer; z-index: 2;
        background: none; border: 0; color: #fff; opacity: .55; font-size: 13px; padding: 2px 4px;
      }
      .${ID}-mute:hover { opacity: 1; }
      .recommended-cell.${ID}-dim { opacity: .45; filter: grayscale(.7); transition: opacity .2s; }

      /* ПОЛОСА НЕ ЛЕПИТСЯ К КАРТОЧКЕ. Она живёт отдельным блоком под всем
         рядом рекомендаций: свой ряд в флексе (flex-basis 100%), своя ширина
         в обычном потоке и отступ сверху. Раньше она попадала в ту же
         флекс-строку и вставала вплотную справа от карточки — два разных по
         смыслу блока читались как один. */
      .${ID}-strip {
        flex: 0 0 100%; width: 100%; box-sizing: border-box;
        margin: 16px 0 0; clear: both;
        display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
        font-size: 12px; color: #3a3350;
      }
      .${ID}-hint {
        max-width: 560px; background: #F7F4FF; border: 1px solid #E6DCFF;
        border-radius: 12px; padding: 10px 12px; line-height: 1.45;
        display: flex; gap: 10px; align-items: flex-start;
      }
      .${ID}-hint button, .${ID}-strip > button {
        background: none; border: 0; cursor: pointer; color: #7000FF;
        font-weight: 800; font: inherit; padding: 0;
      }
      .${ID}-strip > button {
        border: 1px dashed #D9CEF0; border-radius: 10px; padding: 7px 12px;
        color: #6A5B8C; font-weight: 700;
      }
      .${ID}-strip > button:hover { border-color: #7000FF; color: #7000FF; background: #F7F4FF; }

      /* Блок темпа — карточка, а не строка инпутов вперемешку с текстом.
         У каждого поля подпись над ним: «всего» и «22:00 / 45» в плейсхолдере
         исчезали, как только оператор начинал печатать, и через минуту он уже
         не помнил, что в каком поле. */
      .${ID}-speed {
        box-sizing: border-box; background: #fff; border: 1px solid #E7E2F0;
        border-radius: 12px; padding: 12px 14px; min-width: 340px;
        box-shadow: 0 1px 3px rgba(20,0,60,.05);
      }
      .${ID}-speed-head {
        display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
        font-size: 10.5px; font-weight: 800; letter-spacing: .12em;
        text-transform: uppercase; color: #8A7FA6;
      }
      .${ID}-speed-head span { flex: 1; }
      .${ID}-speed-close {
        border: 0; background: none; cursor: pointer; color: #8A7FA6;
        font-size: 15px; line-height: 1; padding: 2px 4px; border-radius: 6px;
      }
      .${ID}-speed-close:hover { color: #C11F3E; background: #FDEAEA; }
      .${ID}-speed-fields { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
      .${ID}-field { display: flex; flex-direction: column; gap: 4px; }
      .${ID}-field label {
        font-size: 10.5px; font-weight: 700; color: #6A5B8C; letter-spacing: .01em;
      }
      .${ID}-field input {
        width: 96px; font: inherit; font-size: 13px; padding: 6px 8px;
        border: 1.5px solid #E7E2F0; border-radius: 8px; color: #2A2140;
        background: #fff; font-variant-numeric: tabular-nums;
      }
      .${ID}-field input:focus { outline: none; border-color: #7000FF; box-shadow: 0 0 0 3px #EFE6FF; }
      .${ID}-speed-out {
        margin-top: 11px; padding-top: 10px; border-top: 1px solid #F0ECF7;
        font-size: 12.5px; color: #3a3350; line-height: 1.5;
      }
      .${ID}-speed-out b { font-variant-numeric: tabular-nums; font-weight: 800; }
      .${ID}-speed-out[data-empty="1"] { color: #8A7FA6; }
      .${ID}-speed[data-pace="ahead"] b.pace { color: #147A54; }
      .${ID}-speed[data-pace="behind"] b.pace { color: #C11F3E; }
    `;
    (document.head || document.documentElement).appendChild(css);
  }

  function buildCell() {
    const box = document.createElement('div');
    box.className = `${ID}-cell recommended-cell`;
    box.id = ID + '-cell';

    const tag = document.createElement('div');
    tag.className = ID + '-tag';
    tag.textContent = 'U-Core';

    const big = document.createElement('div');
    big.className = ID + '-big';
    big.textContent = '—';

    const note = document.createElement('div');
    note.className = ID + '-note';

    const why = document.createElement('div');
    why.className = ID + '-why';

    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = ID + '-mute';
    mute.title = 'Озвучка U-Core';
    mute.textContent = '🔊';
    mute.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      state.voice = !state.voice;
      mute.textContent = state.voice ? '🔊' : '🔇';
      persist();
      if (state.voice && state.cell) say(state.cell);
    });

    box.append(tag, big, note, why, mute);
    ui.box = box; ui.big = big; ui.note = note; ui.why = why; ui.mute = mute;
    return box;
  }

  /**
   * Встраиваемся ВНУТРЬ .recommend-cells последним элементом.
   *
   * Это уже флекс-строка с отступом 16px, поэтому наша карточка сама встаёт
   * СПРАВА от рекомендаций WMS, а чужая вёрстка остаётся нетронутой. Vue при
   * перерисовке может нас выкинуть — наблюдатель поставит обратно.
   */
  function mount() {
    const rec = recBlock();
    if (!rec || !rec.row) return false;
    styles();
    if (!ui.box) buildCell();
    if (ui.box.parentElement !== rec.row) rec.row.appendChild(ui.box);
    if (ui.mute) ui.mute.textContent = state.voice ? '🔊' : '🔇';
    mountStrip(rec.row);
    return true;
  }

  /**
   * Полоса с подсказкой и темпом — ПОД всем блоком рекомендаций, а не рядом
   * с карточкой. Карточка отвечает на «куда нести эту коробку», полоса — на
   * «как идут дела за смену»; вплотную друг к другу они читались как один
   * блок, и оператор искал ответ не там.
   */
  function mountStrip(row) {
    const block = row.closest('.recommend-cells-block') || row.parentElement || row;
    const host = block.parentElement || block;
    if (!ui.strip || !ui.strip.isConnected) {
      ui.strip = document.createElement('div');
      ui.strip.className = ID + '-strip';
      ui.strip.id = ID + '-strip';
    }
    if (ui.strip.previousElementSibling !== block || ui.strip.parentElement !== host) {
      host.insertBefore(ui.strip, block.nextSibling);
    }
    mountHint();
    mountSpeed();
  }

  /**
   * Подсказка про чужую озвучку. Чужой звук расширение не выключает никогда:
   * молча отнятый сигнал хуже двух голосов. Показываем, где тумблер, и
   * убираем подсказку навсегда по нажатию.
   */
  function mountHint() {
    if (state.hintSeen) { if (ui.hint) { ui.hint.remove(); ui.hint = null; } return; }
    if (ui.hint && ui.hint.isConnected) return;
    const hint = document.createElement('div');
    hint.className = ID + '-hint';
    const text = document.createElement('span');
    text.textContent = 'U-Core тоже называет ячейку голосом. Если два голоса мешают, '
      + 'выключите любой из них: у WMS тумблер «Выключить озвучку» справа сверху, у нас — значок динамика на карточке.';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = 'понятно';
    ok.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      state.hintSeen = true; persist(); hint.remove(); ui.hint = null;
    });
    hint.append(text, ok);
    ui.strip.appendChild(hint);
    ui.hint = hint;
  }

  // ------------------------------------------------------------------
  // Голос
  // ------------------------------------------------------------------
  // Число называется ЦЕЛИКОМ — «двести тридцать три», а не «два-три-три».
  // По цифрам звучит быстрее, но это поток цифр, который надо собирать в
  // голове, а у оператора в этот момент в руках коробка.

  let saidCount = 0;

  function say(cell) {
    if (!state.voice || !cell) return;
    // Что именно ушло в синтезатор — видно в разметке. Нужно и для отладки
    // («почему сказал не то?»), и для проверок: озвучку иначе не измерить.
    saidCount++;
    if (ui.box) {
      ui.box.dataset.said = String(cell);
      ui.box.dataset.saidCount = String(saidCount);
    }
    try {
      if (!('speechSynthesis' in window)) return;
      // ЧУЖУЮ РЕЧЬ НЕ ОБРЫВАЕМ. Здесь был speechSynthesis.cancel() — он
      // чистит всю очередь синтезатора, а она общая со страницей. WMS в этот
      // момент называет свою ячейку, и мы обрывали его на полуслове. Это и
      // есть «тихо выключить чужой звук», от чего оговорка ниже обещала
      // воздержаться. Своя реплика — три цифры, очередь из двух не мешает.
      const u = new SpeechSynthesisUtterance(String(cell));
      u.lang = 'ru-RU';
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch (e) { /* без голоса тоже работаем */ }
  }

  // ------------------------------------------------------------------
  // Хранилище
  // ------------------------------------------------------------------

  function persist() {
    try {
      chrome.storage.local.set({
        ucorePlacementPrefs: {
          voice: state.voice, hintSeen: state.hintSeen,
          speedOn: state.speedOn, total: state.total, goal: state.goal
        },
        ucorePlacements: state.placements.slice(-2000),
        ucorePlacementOpen: state.open
      });
    } catch (e) { /* расширение перезагрузили — переживём */ }
  }

  function restore(done) {
    try {
      chrome.storage.local.get(['ucorePlacementPrefs', 'ucorePlacements', 'ucorePlacementOpen'], (data) => {
        const p = data.ucorePlacementPrefs || {};
        state.voice = p.voice !== false;
        state.hintSeen = p.hintSeen === true;
        state.speedOn = p.speedOn === true;
        state.total = Number.isFinite(p.total) ? p.total : null;
        state.goal = p.goal || null;
        state.placements = Array.isArray(data.ucorePlacements) ? data.ucorePlacements : [];
        state.open = data.ucorePlacementOpen || null;
        done();
      });
    } catch (e) { done(); }
  }

  // ------------------------------------------------------------------
  // Рекомендация
  // ------------------------------------------------------------------

  let seq = 0;

  function ask(sku, gm, card) {
    const mine = ++seq;
    // Пока считаем — старое число убираем. Показать прошлую ячейку для
    // нового товара опаснее, чем не показать ничего.
    draw({ status: '…' });

    let answered = false;
    const timer = setTimeout(() => {
      if (answered || mine !== seq) return;
      draw({ status: 'нет ответа', why: 'расширение молчит — обновите вкладку' });
    }, 2500);

    try {
      chrome.runtime.sendMessage(
        { type: 'ucore:recommend-cell', barcode: sku, gm, name: card.name, qty: card.qty,
          placements: state.placements.slice(-500) },
        (res) => {
          answered = true;
          clearTimeout(timer);
          if (mine !== seq) return;                       // ответ про прошлый товар
          if (chrome.runtime.lastError || !res) {
            draw({ status: 'нет ответа', why: 'расширение молчит' });
            return;
          }
          if (!res.ok) { draw({ status: 'нет данных', why: res.reason }); return; }
          if (String(res.barcode) !== String(sku)) return; // чужой ответ — молчим
          draw({ cell: res.cellId, why: res.why, status: res.cellId ? null : 'нет места' });
        }
      );
    } catch (e) {
      clearTimeout(timer);
      draw({ status: 'нет связи', why: String((e && e.message) || e) });
    }
  }

  // ------------------------------------------------------------------
  // Отрисовка
  // ------------------------------------------------------------------

  function draw({ cell = null, why = null, status = null } = {}, { silent = false } = {}) {
    if (!ui.box) return;
    state.cell = cell;
    state.shown = { cell, why, status };
    state.wmsShown = state.wms.join(',');

    const same = cell && state.wms.includes(String(cell));
    ui.box.dataset.state = cell ? (same ? 'same' : 'diff') : 'none';
    ui.big.textContent = cell ? String(cell) : (status || '—');

    if (cell && !silent) {
      ui.big.dataset.flash = '1';
      setTimeout(() => { if (ui.big) ui.big.dataset.flash = '0'; }, 480);
    }

    if (cell && same) ui.note.textContent = '✓ то же, что у WMS';
    else if (cell && state.wms.length) ui.note.textContent = `WMS: ${state.wms.join(' / ')}`;
    else if (cell) ui.note.textContent = 'WMS не предложил';
    else ui.note.textContent = '';

    ui.why.textContent = cell ? (why || '') : (why || '');

    dimWms(!!cell && !same);

    // Голос один раз на товар: повторный скан не должен говорить снова.
    if (cell && state.spoken !== state.key) {
      state.spoken = state.key;
      say(cell);
    }
  }

  /**
   * Рекомендацию WMS не зачёркиваем.
   *
   * Зачёркнутое читается как «неверно», а WMS не ошибается — он просто не
   * знает того, что знаем мы: что реально лежит в ячейке по последнему
   * сбору, какие ячейки оператор пометил несуществующими, что уже положено
   * за эту смену. Поэтому не «неверно», а «второстепенно»: приглушаем.
   * Оператор видит оба числа и понимает, что это выбор, а не поломка.
   */
  function dimWms(dim) {
    const rec = recBlock();
    if (!rec) return;
    for (const el of rec.cells) el.classList.toggle(ID + '-dim', !!dim);
  }

  // ------------------------------------------------------------------
  // Секундомер (ТЕСТ)
  // ------------------------------------------------------------------
  // Сколько секунд остаётся на одно место, чтобы успеть к сроку. Смысл не в
  // точности, а в темпе: сразу видно, надо ли ускоряться.

  function mountSpeed() {
    if (!ui.strip) return;
    if (!state.speedOn) {
      if (ui.speed) { ui.speed.remove(); ui.speed = null; }
      if (!ui.speedBtn || !ui.speedBtn.isConnected) {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = ID + '-speed-on';
        b.textContent = '⏱ темп';
        b.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          state.speedOn = true; persist(); b.remove(); ui.speedBtn = null; mountSpeed();
        });
        ui.strip.appendChild(b);
        ui.speedBtn = b;
      }
      return;
    }
    if (ui.speed && ui.speed.isConnected) { drawSpeed(); return; }

    const box = document.createElement('div');
    box.className = ID + '-speed';

    const head = document.createElement('div');
    head.className = ID + '-speed-head';
    const title = document.createElement('span');
    title.textContent = '⏱ темп размещения';
    const off = document.createElement('button');
    off.type = 'button'; off.className = ID + '-speed-close';
    off.textContent = '×'; off.title = 'Убрать темп';
    off.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      state.speedOn = false; persist(); box.remove(); ui.speed = null; mountSpeed();
    });
    head.append(title, off);

    const field = (labelText, input) => {
      const wrap = document.createElement('label');
      wrap.className = ID + '-field';
      const cap = document.createElement('label');
      cap.textContent = labelText;
      wrap.append(cap, input);
      return wrap;
    };

    const total = document.createElement('input');
    total.type = 'text'; total.inputMode = 'numeric'; total.placeholder = '120';
    total.title = 'Сколько мест разместить за смену';
    total.value = state.total || '';
    total.addEventListener('change', () => {
      const n = Number(String(total.value).replace(/\D+/g, ''));
      state.total = Number.isFinite(n) && n > 0 ? n : null;
      persist(); drawSpeed();
    });

    const goal = document.createElement('input');
    goal.type = 'text'; goal.placeholder = '22:00';
    goal.title = 'Время «22:00» или сколько минут осталось — «45»';
    goal.value = goalText();
    goal.addEventListener('change', () => {
      state.goal = parseGoal(goal.value);
      // «45» значит «через 45 минут», и в поле должно остаться то, во что это
      // превратилось. Иначе через полчаса оператор видит «45» и думает, что
      // у него ещё сорок пять минут.
      goal.value = goalText();
      persist(); drawSpeed();
    });

    const fields = document.createElement('div');
    fields.className = ID + '-speed-fields';
    fields.append(field('Всего мест', total), field('Успеть к', goal));

    const out = document.createElement('div');
    out.className = ID + '-speed-out';

    box.append(head, fields, out);
    ui.strip.appendChild(box);
    ui.speed = box; ui.speedOut = out;
    drawSpeed();
  }

  function goalText() {
    if (!state.goal) return '';
    const d = new Date(state.goal.at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function parseGoal(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const hm = text.match(/^(\d{1,2})[:. ](\d{2})$/);
    if (hm) {
      const at = new Date();
      at.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
      if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
      return { mode: 'deadline', at: at.getTime() };
    }
    const mins = Number(text.replace(/\D+/g, ''));
    return Number.isFinite(mins) && mins > 0 ? { mode: 'timer', at: Date.now() + mins * 60000 } : null;
  }

  function placedToday() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return state.placements.filter(p => p.at >= start.getTime());
  }

  function drawSpeed() {
    if (!ui.speed || !ui.speedOut) return;
    const done = placedToday().length;
    const left = state.total ? Math.max(0, state.total - done) : null;

    if (!state.goal || !left) {
      ui.speed.dataset.pace = '';
      ui.speedOut.dataset.empty = '1';
      ui.speedOut.textContent = state.total
        ? (state.goal ? `Размещено ${done} из ${state.total} — всё.`
                      : `Размещено ${done} из ${state.total}. Укажите, к какому времени успеть.`)
        : 'Заполните оба поля — и здесь будет видно, укладываетесь ли вы в срок.';
      return;
    }
    ui.speedOut.dataset.empty = '0';
    const secLeft = Math.max(0, (state.goal.at - Date.now()) / 1000);
    const need = secLeft / left;

    // Фактический темп берём по последним размещениям, а не за всю смену:
    // важно, как идёт СЕЙЧАС.
    const recent = placedToday().slice(-10);
    let actual = null;
    if (recent.length >= 2) {
      actual = ((recent[recent.length - 1].at - recent[0].at) / 1000) / (recent.length - 1);
    }
    ui.speed.dataset.pace = actual === null ? '' : (actual <= need ? 'ahead' : 'behind');
    ui.speedOut.innerHTML =
      `Размещено <b>${done}</b> из <b>${state.total}</b>, осталось <b>${left}</b>.<br>`
      + `Чтобы успеть — по <b class="pace">${need.toFixed(1)} с</b> на место`
      + (actual === null ? '. Сделайте ещё пару размещений, и здесь появится ваш темп.'
                         : `, сейчас идёте по <b class="pace">${actual.toFixed(1)} с</b>.`);
  }

  setInterval(() => { if (state.speedOn) drawSpeed(); }, 5000);

  // ------------------------------------------------------------------
  // Главный цикл
  // ------------------------------------------------------------------

  function tick() {
    const id = identity();
    if (!id.onScreen) return;
    if (!mount()) return;

    const rec = recBlock();
    state.wms = rec ? rec.values : [];

    // РЕКОМЕНДАЦИИ WMS ПРИХОДЯТ ПОЗЖЕ НАШЕЙ.
    //
    // Проверено на живом экране 02.09.2026: свою ячейку мы считаем из уже
    // собранных данных за миллисекунды, а WMS дорисовывает свои коробки
    // позже. Если не перерисовать сравнение, на экране навсегда остаётся
    // «WMS не предложил» — при том, что он предложил, и ровно то же самое.
    // Перерисовываем молча: решение то же, повторно называть его голосом
    // и мигать числом не за что.
    if (state.key && state.shown && state.wms.join(',') !== state.wmsShown) {
      draw(state.shown, { silent: true });
    }

    if (blocked()) {
      state.key = null; state.spoken = null;
      draw({ status: 'WMS', why: 'сессия истекла или ошибка на странице' });
      return;
    }

    // Товара нет — либо только что разместили, либо ещё не сканировали.
    if (!id.sku) {
      closeOpen();
      state.key = null; state.spoken = null;
      draw({ status: '—', why: 'ждём скан' });
      return;
    }

    // Ячейку, выбранную оператором, запоминаем сразу: после размещения
    // экран очистится, и спросить будет уже не у кого.
    const chosen = chosenCell();
    if (chosen && state.open && state.open.sku === id.sku && state.open.cell !== chosen) {
      state.open.cell = chosen;
      persist();
    }

    // Раньше, чем появилась кнопка размещения, советовать нечего: оператор
    // всё равно не может положить товар, а число на экране уже устареет.
    if (!placementReady()) { draw({ status: '…', why: 'форма грузится' }); return; }

    const key = `${id.gm || ''}|${id.sku}`;
    if (key === state.key) return;                 // тот же товар — не пересчитываем

    // Пришёл ДРУГОЙ товар, а прошлый не был закрыт: значит его разместили.
    if (state.open && state.open.sku !== id.sku) closeOpen();
    if (!state.open || state.open.sku !== id.sku) {
      state.open = { sku: id.sku, gm: id.gm || null, cell: null, at: Date.now() };
      persist();
    }

    state.key = key;
    ask(id.sku, id.gm, id.card || readCard());
  }

  /**
   * Товар ушёл с экрана — считаем, что его разместили.
   *
   * Открытая позиция лежит в ХРАНИЛИЩЕ, а не в памяти вкладки: страницу
   * перезагружают (F5, переход по меню, обрыв сессии), и без этого каждый
   * такой случай молча терял бы одно размещение из счёта темпа.
   */
  function closeOpen() {
    const open = state.open;
    if (!open || !open.sku) return;
    state.open = null;
    state.placements.push({
      barcode: open.sku,
      gm: open.gm || null,
      cell: open.cell || null,
      suggested: state.cell || null,
      at: Date.now()
    });
    if (state.placements.length > 2000) state.placements = state.placements.slice(-2000);
    persist();
    drawSpeed();
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try { tick(); } catch (e) { console.warn(LOG, e); }
    });
  }

  function start() {
    restore(() => {
      new MutationObserver(schedule).observe(document.documentElement,
        { childList: true, subtree: true, characterData: true });
      // Адрес меняется без перезагрузки — router у WMS свой.
      for (const name of ['pushState', 'replaceState']) {
        const orig = history[name];
        history[name] = function () { const r = orig.apply(this, arguments); schedule(); return r; };
      }
      window.addEventListener('popstate', schedule);
      window.addEventListener('focus', schedule);
      setInterval(schedule, 1200);      // страховка от изменений без мутаций
      schedule();
      console.log(`${LOG} готов`);
    });
  }

  /** Самопроверка: что расширение видит на этом экране (для консоли). */
  window.__ucorePlacement = () => {
    const rec = recBlock();
    return {
      id: identity(),
      card: readCard(),
      wms: rec ? rec.values : null,
      rowFound: !!(rec && rec.row),
      fallbackUsed: !!(rec && rec.fallback),
      ready: placementReady(),
      chosen: chosenCell(),
      mounted: !!document.getElementById(ID + '-cell'),
      ours: state.cell
    };
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
