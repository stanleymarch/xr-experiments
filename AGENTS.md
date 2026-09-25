# AGENTS.md — правила работы в этом репо

Стек: пять WebXR-опытов на XR Blocks 0.21.1 (Three.js), без сборки —
import-map + CDN; деплой push'ем в main → GitHub Actions → Pages.
XR Blocks — SDK от Google, исходники и доки см. ниже. Часть `8thwall/` —
отдельный стек, сюда не смотреть.

## Перед любой правкой XR-кода — не гадать

1. Прочитать `XR-BLOCKS.md` в корне: контракты SDK, структура «один опыт =
   один файл», карта «опыт → суть», процедура проверки.
2. Скиллы SDK установлены в `.agents/skills/xb-*` (ресинк —
   `npm run skills:sync`, он же postinstall). Перед задачей читать профильный
   скилл: `xb-add-interactions` (ввод/события/манипуляция),
   `xb-add-spatial-ui` (карточки/оверлеи/контролы), `xb-add-world-sensing`
   (планы/depth/детекция), `xb-anchors`, `xb-debug-app`, `xb-add-ai`,
   `xb-build-app`.
3. Источник правды по символам: `node_modules/xrblocks/src/`, типы —
   `node_modules/xrblocks/build/xrblocks.d.ts`, мануалы —
   <https://xrblocks.github.io/docs/manual/>. Каждый `xb.*` символ сверять с
   d.ts перед использованием; #1 причина поломок — выдуманные API.
4. Официальные образцы: `../xrblocks-reference/` (вне git) — templates/

## Структура и конвенции

- Один опыт = один файл `xrblocks/<name>/index.html` (+ `exp.json` для
  галереи, опциональные `textures/`). Общего кода между опытами нет:
  пять device-контрактов (`glowBlending`, `installXrGuards`, `isPassthrough`,
  `hideInPassthrough`, `watchXrButton`) инлайнятся дословно из пилота
  `xrblocks/weather-room/index.html`.
- HUD — нативный `xb.UIOverlay`; никаких кастомных follow-лупов и DOM-панелей.
- Каждый опыт обязан переживать: flat-браузер без WebXR, `?formFactor=desktop`
  (симулятор), XR-вход, `?xrAutomation=1` (детерминированная демо-ветка без
  сети и разрешений).
- В git — только готовый код; референсы и клоны официальных репо — вне git.
- HUD — нативный `xb.UIOverlay`; никаких кастомных follow-лупов и DOM-панелей.
- **Реакция мира на данные**: каждое поле внешних данных обязано иметь видимую
  причину в мире, а не только цифру в телеметрии; телеметрия начинается с
  префикса источника (`LIVE · …` / `DEMO · причина`). Подробности и эталон —
  в `XR-BLOCKS.md`.


## Проверка

- Синтаксис модуля: `awk '/<script type="module">/{flag=1;next}/<\/script>/{flag=0}flag'
  <файл> > /tmp/m.mjs && node --check /tmp/m.mjs` — перед каждой сдачей.
- Десктоп: плоский запуск + симулятор (`?formFactor=desktop`). Отладка:
  `?debug=1` открывает `window.xb` и `window.xbReady`.
- Headless: `?xrAutomation=1` — консоль должна быть чистой, детерминизм
  обязателен. Планка — официальные сэмплы в том же браузере чистые.
- Телефон (alpha-blend, тач-пути Chrome) и Quest (якоря, depth, жесты,
  физика, two-source scale) — только реальное устройство.
- Сборка сайта: `npm run build` → `_site/` (копия статичных опытов + 8thwall
  + manifest.json из exp.json-ов).

## Деплой и кеш

Правка опыта — это правка его единственного index.html (и `exp.json`, если
меняется описание). Кеш-басты `?v=` не нужны: нет импортов между файлами.
