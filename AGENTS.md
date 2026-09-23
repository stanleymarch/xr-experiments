# AGENTS.md — правила работы в этом репо

Стек: пять WebXR-опытов на XR Blocks 0.21.1 (Three.js), без сборки —
import-map + CDN; деплой push'ем в main → GitHub Actions → Pages.
XR Blocks — SDK от Google, исходники и доки см. ниже. Часть `8thwall/` —
отдельный стек, сюда не смотреть.

## Перед любой правкой XR-кода — не гадать

1. Прочитать `XR-BLOCKS.md` в корне: контракты SDK, места где мы осознанно
   отклоняемся от канона, карта «опыт → API», процедура проверки.
2. Скиллы SDK установлены в `.agents/skills/xb-*` (скопированы из
   `node_modules/xrblocks/skills`; ресинк — `npm run skills:sync`, он же
   postinstall). Перед задачей читать профильный скилл:
   `xb-add-interactions` (ввод/события/манипуляция), `xb-add-spatial-ui`
   (карточки/оверлеи/контролы), `xb-add-world-sensing` (планы/depth/детекция),
   `xb-anchors`, `xb-debug-app`, `xb-add-ai`, `xb-build-app`.
3. Источник правды по символам: `node_modules/xrblocks/src/`, типы —
   `node_modules/xrblocks/build/xrblocks.d.ts`. Живые шаблоны/сэмплы/доки —
   зеркало апстрима в `../xrblocks-reference/` (sparse clone google/xrblocks:
   `templates/`, `samples/`, `demos/`, `docs/`).
4. Порядок из скиллов: сверить каждый планируемый символ с исходником →
   посмотреть шаблон/сэмпл → только потом писать код.

## Проверка

- Десктоп: симулятор (кнопка Enter Simulator; автостарт `?formFactor=desktop`).
  Отладка: `?debug=1` открывает `window.xb` и `window.xbReady`.
- Headless-прогоны: `?test=1` (наш automation-пресет, `common/boot.js`).
- Телефон (`alpha-blend`, тач-пути Chrome, всегда пустые planes) и Quest
  (якоря, depth, жесты) — только реальное устройство: симулятор WebXR API
  не эмулирует. Бюджет персистентных якорей общего пользования — проверять
  до демо.

## Деплой и кеш

Правки `common/boot.js|hud.js|fx.js` или `main.js` опыта требуют поднять
суффикс `?v=mobile-ux-N` в импортах этого опыта и entry в его `index.html`
(иначе телефоны тянут старое из кеша). Сборка: `npm run build` → `_site/`.
