// Замер словаря названий на живой выгрузке.
//
// ЧТО ИМЕННО МЕРИТСЯ. Не «нравится ли перевод», а доля названий, у которых
// словарь узнал главное слово, и доля позиций, для которых удалось назвать
// вес. Число «54 из 55» из CHANGELOG 2.15.0 получено на том же срезе, по
// которому словарь и составлялся, — оно ничего не говорит о новой поставке.
//
// Запуск:
//     node tests/measure-names.mjs <файл>
//
// Файл — либо выгрузка приёмки (CSV с колонками «Товар», «Единица»,
// «Габариты мм»), либо JSON-массив { name, unit, dim }.
//
// Выгрузка приёмки содержит клиентов и телефоны. Скрипт читает из неё
// ТОЛЬКО три товарные колонки и ничего никуда не отправляет.

import { readFileSync } from 'node:fs';
import { loadClassic } from './harness.mjs';

loadClassic('sku-name.js');
const S = globalThis.UCoreSkuName;

const path = process.argv[2];
if (!path) {
  console.error('Укажите файл: node tests/measure-names.mjs priemka-2026-09-12.csv');
  process.exit(2);
}

function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ';') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

function load(file) {
  const raw = readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (raw.trim().startsWith('[')) return JSON.parse(raw);
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  const head = splitCsvLine(lines[0]);
  const at = (title) => head.indexOf(title);
  const iName = at('Товар');
  const iUnit = at('Единица');
  const iDim = at('Габариты мм');
  if (iName < 0) throw new Error('в файле нет колонки «Товар»');
  const seen = new Map();
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const name = (cells[iName] || '').trim();
    if (!name || seen.has(name)) continue;
    seen.set(name, {
      name,
      unit: iUnit >= 0 ? (cells[iUnit] || '').trim() : '',
      dim: iDim >= 0 ? (cells[iDim] || '').trim() : ''
    });
  }
  return [...seen.values()];
}

const dims = (text) => {
  const m = /^(\d+)\s*[x×]\s*(\d+)\s*[x×]\s*(\d+)$/i.exec(String(text || '').trim());
  return m ? { length: +m[1], width: +m[2], height: +m[3] } : null;
};

const items = load(path);
const russian = [];
const known = [];
const unknown = [];
const simplified = [];
let lenBefore = 0;
let lenAfter = 0;

for (const item of items) {
  const short = S.shortName(item.name);
  lenBefore += item.name.length;
  lenAfter += short.text.length;
  if (short.russian) russian.push({ ...item, short: short.text });
  else if (short.known) known.push({ ...item, short: short.text });
  else if (short.simplified) simplified.push({ ...item, short: short.text });
  else unknown.push({ ...item, short: short.text });
}

const weighed = { name: 0, guess: 0, none: 0 };
const noWeight = [];
for (const item of items) {
  const w = S.weightKg(dims(item.dim), item.name);
  if (w.kg === null) { weighed.none++; noWeight.push(item); }
  else if (w.exact) weighed.name++;
  else weighed.guess++;
}

const pc = (n) => `${(n / items.length * 100).toFixed(1)}%`;

console.log(`Выгрузка: ${path}`);
console.log(`Уникальных названий: ${items.length}\n`);

console.log('УПРОЩЕНИЕ');
console.log(`  узнано словарём     ${String(known.length).padStart(4)}  ${pc(known.length)}`);
console.log(`  уже по-русски       ${String(russian.length).padStart(4)}  ${pc(russian.length)}`);
console.log(`  срезан хвост витрины ${String(simplified.length).padStart(4)}  ${pc(simplified.length)}`);
console.log(`  осталось как было   ${String(unknown.length).padStart(4)}  ${pc(unknown.length)}`);
console.log(`  средняя длина       ${Math.round(lenBefore / items.length)} знаков -> ${Math.round(lenAfter / items.length)}\n`);

console.log('ВЕС');
console.log(`  из названия         ${String(weighed.name).padStart(4)}  ${pc(weighed.name)}`);
console.log(`  оценка по габаритам ${String(weighed.guess).padStart(4)}  ${pc(weighed.guess)}`);
console.log(`  НЕЧЕМ СЧИТАТЬ       ${String(weighed.none).padStart(4)}  ${pc(weighed.none)}\n`);

const top = Number(process.env.SHOW || 15);
if (top > 0 && unknown.length) {
  console.log(`НЕ УЗНАНО — первые ${Math.min(top, unknown.length)}:`);
  for (const item of unknown.slice(0, top)) {
    console.log(`  ${item.name.slice(0, 100)}`);
  }
}
