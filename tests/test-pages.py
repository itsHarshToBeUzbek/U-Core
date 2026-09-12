"""Сквозная проверка: расширение поднимается в настоящем Chromium.

Ловит то, чего не видит ни один тест под Node: страница, у которой не
загрузился модуль, выглядит целой — разметка на месте, — а JS к ней не
подключён. Наружу это выходит не ошибкой, а тем, что ничего не нажимается.
Восемнадцать тестов однажды упали именно так, и час ушёл на поиск причины.

Здесь же проверяется главное обещание расширения: до включения перевода
названий оно не обращается ни к одному сервису. Обещание уже один раз
оказывалось неправдой — три страницы тянули шрифты с fonts.googleapis.com
при каждом открытии (CHANGELOG 2.16.1).

Запуск:
    xvfb-run -a python3 tests/test-pages.py

Нужен playwright и Chromium. Если браузер лежит не там, где его ищет
playwright, путь передаётся через CHROME_PATH.
"""

import os
import sys
import pathlib

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("playwright не установлен: pip install playwright")
    sys.exit(2)

ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
PROFILE = os.path.join(ROOT, ".test-profile")
CHROME = os.environ.get("CHROME_PATH")

PAGES = [
    "popup.html",
    "priemka.html",
    "inventory.html",
    "layout.html",
    "encash.html",
    "infolist.html",
    "app.html",
    "diag.html",
]

passed = 0
failures = []


def check(name, condition, detail=""):
    global passed
    if condition:
        passed += 1
    else:
        failures.append(f"{name}\n    {detail}")


def main():
    with sync_playwright() as p:
        launch = dict(
            headless=False,  # расширения в headless-режиме не грузятся
            args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"],
        )
        if CHROME:
            launch["executable_path"] = CHROME
        ctx = p.chromium.launch_persistent_context(PROFILE, **launch)

        # Service worker обязан подняться. Без модуля он не стартует вовсе,
        # и тогда у теста нет даже id расширения.
        if not ctx.service_workers:
            ctx.wait_for_event("serviceworker", timeout=15000)
        check("service worker поднялся", bool(ctx.service_workers),
              "background.js не стартовал — скорее всего не грузится импорт")
        if not ctx.service_workers:
            ctx.close()
            return

        ext_id = ctx.service_workers[0].url.split("/")[2]
        page = ctx.new_page()

        outbound, failed, errors = [], [], []
        page.on("request", lambda r: outbound.append(r.url)
                if not r.url.startswith(("chrome-extension://", "data:", "blob:")) else None)
        page.on("requestfailed", lambda r: failed.append(r.url))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        for name in PAGES:
            outbound.clear()
            failed.clear()
            errors.clear()
            page.goto(f"chrome-extension://{ext_id}/{name}")
            page.wait_for_timeout(1200)
            check(f"{name}: открывается без ошибок", not errors, "; ".join(errors[:3]))
            check(f"{name}: все ресурсы на месте", not failed, "; ".join(failed[:3]))
            # ГЛАВНОЕ. Ни одна страница не имеет права ходить наружу, пока
            # человек не включил перевод названий.
            check(f"{name}: ни одного запроса наружу", not outbound,
                  "; ".join(outbound[:3]))

        # Попап: вкладки на месте и переключаются. Вкладка, у которой не
        # подключён JS, выглядит точно так же, как рабочая.
        page.goto(f"chrome-extension://{ext_id}/popup.html")
        page.wait_for_timeout(1000)
        tabs = page.eval_on_selector_all(".tab-btn", "els => els.map(e => e.dataset.tab)")
        check("попап: вкладки на месте", len(tabs) >= 7, f"нашлось {len(tabs)}")
        for tab in tabs:
            errors.clear()
            page.click(f'[data-tab="{tab}"]')
            page.wait_for_timeout(250)
            shown = page.eval_on_selector(f"#{tab}", "el => !el.hidden && el.offsetParent !== null")
            check(f"попап: вкладка {tab} открывается", shown and not errors,
                  "; ".join(errors[:2]) or "содержимое не показалось")

        # Шрифты лежат рядом, а не у Google, и действительно применяются.
        state = page.evaluate("document.fonts.status")
        check("шрифты загрузились из расширения", state == "loaded", f"document.fonts.status={state}")
        family = page.evaluate("getComputedStyle(document.body).fontFamily")
        check("шрифт интерфейса применился", "Manrope" in family, family)

        ctx.close()


main()

if failures:
    print(f"Страницы расширения: {passed} прошли, {len(failures)} УПАЛИ\n")
    for f in failures:
        print(f"  ✗ {f}")
    sys.exit(1)

print(f"Страницы расширения: {passed} проверок, все прошли")
