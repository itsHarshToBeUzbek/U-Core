// Крошечная обвязка для тестов под Node. Ничего, кроме счёта и внятного
// сообщения при падении: тест, который падает словами «expected true to be
// false», стоит дороже, чем стоит.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Загрузить классический скрипт (`wms-parse.js`, `sku-name.js`) так же, как
 * его грузит браузер тегом <script>: он вешает себя на globalThis.
 */
export function loadClassic(file) {
  const code = readFileSync(join(ROOT, file), 'utf8');
  vm.runInThisContext(code, { filename: file });
}

let passed = 0;
const failures = [];
let group = '';

export function suite(name) { group = name; }

export function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name: `${group ? group + ' / ' : ''}${name}`, err });
  }
}

const show = (v) => {
  if (typeof v === 'string') return JSON.stringify(v);
  try { return JSON.stringify(v); } catch (e) { return String(v); }
};

export function eq(actual, expected, note) {
  if (actual !== expected) {
    throw new Error(`${note ? note + ': ' : ''}ждали ${show(expected)}, пришло ${show(actual)}`);
  }
}

export function deep(actual, expected, note) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${note ? note + ': ' : ''}ждали ${b}, пришло ${a}`);
}

export function ok(value, note) {
  if (!value) throw new Error(note || `ждали правду, пришло ${show(value)}`);
}

export function no(value, note) {
  if (value) throw new Error(note || `ждали ложь, пришло ${show(value)}`);
}

export function throws(fn, note) {
  try { fn(); } catch (e) { return; }
  throw new Error(note || 'ждали исключение, его не было');
}

export function report(title) {
  if (!failures.length) {
    console.log(`${title}: ${passed} проверок, все прошли`);
    return 0;
  }
  console.log(`${title}: ${passed} прошли, ${failures.length} УПАЛИ\n`);
  for (const f of failures) console.log(`  ✗ ${f.name}\n    ${f.err.message}`);
  return 1;
}
