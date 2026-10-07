# xr-experiments

Коллекция небольших WebXR-опытов, где реальная комната становится частью произведения. Главная целевая платформа — **Meta Quest 3**; каждый опыт при этом обязан оставаться осмысленным на смартфоне и на десктопе.

Общий принцип: не приносить в XR очередную сцену с готовыми 3D-моделями, а проявлять то, что уже окружает человека, но обычно невидимо — геометрию комнаты, погоду снаружи, городские данные, звук и недавнее прошлое. Эти данные становятся материей: их можно толкнуть, растянуть, заморозить или отмотать.

**Живой каталог:** <https://stanleymarch.github.io/xr-experiments/>  
**Автор:** <https://staniverse.xyz>

- **[`apps/`](apps/)** — новые опыты на Meta Immersive Web SDK (IWSDK): Quest 3 и Android WebXR. Greenfield-проекты, собираются независимо.
- **[`8thwall/`](8thwall/)** — самостоятельные 8th Wall / A-Frame camera-AR опыты со своей webpack-сборкой.
- Следующий движок можно добавить соседней папкой, не смешивая его зависимости и жизненный цикл с остальными.

GitHub Actions собирает полку 8th Wall в единый `_site/` и публикует каталог на GitHub Pages.

Концепции опытов ниже (REALITY//FIELD, CITY//ORBIT, SOUND//SPACE, ECHO//ROOM) сохранены как замыслы для greenfield-пересборки на IWSDK — см. MIGRATION.md. WEATHER//ROOM уже существует как нативное IWSDK-приложение в `apps/weather-room`, но нативное приёмка-тестирование на Quest 3 ещё идёт.

## Permanent Meta skills, MCP and Quest debugging setup

One-time (or after re-scaffolding the IWSDK app) from the repo root:

```powershell
npm run setup
```

This runs `scripts/setup-iwsdk-debug.ps1` (shared by `npm run setup` and the
full `scripts/bootstrap-iwsdk-omp.ps1`, which keeps its old behavior of also
refreshing the OMP model catalog and rewriting `.omp/config.yml` model roles
for people who invoke bootstrap explicitly). Side effects of `npm run setup`,
and nothing else:
1. full official `iwsdk-*` skill sync from `apps/weather-room/.agents/skills`
   (installed `@iwsdk/cli` 1.0.1 + `@iwsdk/create` output) into both
   `.agents/skills/` and `.omp/skills/` — no OMP model/routing changes,
   no model catalog refresh, no app/source rewrites;
2. official CLI adapter-state inspection:
   `node node_modules/@iwsdk/cli/dist/cli.js adapter status` with cwd
   `apps/weather-room` (read-only probe, fails the script on nonzero exit);
3. official Android platform-tools install/version check: downloads
   `platform-tools-latest-windows.zip` from `dl.google.com` into the ignored
   local cache `tools/` only when `tools/platform-tools/adb.exe` is absent,
   then runs `adb --version` (fails the script on nonzero exit).

Re-sync skills alone any time with `npm run skills:sync`.

OMP loads the skills automatically: it walks up `.agents/skills` and resolves
`.omp/agents/*.md` `autoloadSkills` against the same registry; no extra OMP
skills config is needed. OMP loads the IWSDK MCP servers from `mcp.json` in the
project root when OMP starts there (`mcp.enableProjectConfig` defaults to true;
schema `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`):

- `iwsdk-runtime` — `node apps/weather-room/node_modules/@iwsdk/cli/dist/cli.js mcp stdio`,
  cwd `apps/weather-room` (the runtime bridge; must run with the workspace as cwd
  so `findNearestIwsdkAppRoot` resolves the app);
- `iwsdk-reference` — `node apps/weather-room/node_modules/@iwsdk/reference/dist/cli.js`;
- `metavr` — `node apps/weather-room/node_modules/@meta-quest/metavr/bin.js mcp server`.
All three entries use `cwd: ./apps/weather-room`.

These are the exact stdio entries the official
`node node_modules/@iwsdk/cli/dist/cli.js adapter sync` would write, adapted to
the OMP-compatible shape. OMP stdio entries require `type` plus a bare binary or
`./`-relative `command`; `node` is on PATH here, and entrypoint paths are
passed as `apps/weather-room`-relative `args` with `cwd: ./apps/weather-room`.
Do not invent a fake MCP wrapper: the CLI stdio command above is authoritative
and sufficient.

Quest debugging needs official `adb`, absent from PATH on this machine and now
installed as an ignored local cache at `tools/platform-tools/adb.exe`
(`npm run adb -- devices -l`). One authorized Quest 3 was observed there;
re-query with `npm run adb -- devices -l` before any native session and pass
`-s <serial>` to every ADB command. Native testing itself follows the official
`iwsdk-native-xr-test` skill: `adb -s <serial> reverse`, `runtime pair-headset`
with that serial as `headsetId`, exact `runtimeTarget` copied from
`runtime targets` on every headset command, loopback only.


---

## 1. REALITY//FIELD

Ты входишь в XR — и обычная комната перестаёт быть фоном. Стены, стол, пол и окружающая геометрия проявляются как единое интерактивное физическое поле.

Проводишь рукой — из пальцев вылетает импульс. Он встречает реальную поверхность, вспыхивает в точке удара, расходится по ней светящейся волной, падает на пол и отражается от границ комнаты. Ты не расставляешь виртуальные предметы поверх реальности: сама реальность становится инструментом.

- **pinch** накапливает заряд и отпускает усиленный импульс;
- **открытая ладонь** отталкивает частицы;
- **кулак** притягивает их;
- **обе руки в pinch** растягивают локальное поле, сила растёт с размахом.

У опыта два лица. **DEBUG REALITY** снимает красивую оболочку и показывает то, чем XR видит комнату: depth mesh, найденные плоскости, скелет рук, луч, нормаль последнего удара и FPS. **DREAM REALITY** возвращает поэзию — техническая реконструкция растворяется в тысячах светящихся частиц и силовых линий.

*Концепт сохранён для greenfield-пересборки на IWSDK — см. MIGRATION.md.*

## 2. WEATHER//ROOM

Комната становится физическим воплощением погоды за окном.

Если с юго-запада дует ветер 8 м/с, поток частиц действительно проходит через пространство с этого направления. Дождь падает на горизонтальные поверхности. Облачность гасит виртуальный свет. Температура меняет цвет, плотность и подвижность воздуха. Давление поднимает или опускает условный потолок атмосферы.

Время здесь тоже становится предметом. Шкала **−24h ← NOW → +24h** позволяет рукой проматывать вчерашний дождь, нынешний ветер и завтрашнее прояснение, не делая новый сетевой запрос на каждом кадре.

Источник — [Open-Meteo](https://open-meteo.com/): API не требует ключа или регистрации. Один запрос при открытии приносит почасовой ряд, после чего визуализация и перемотка работают локально. Если сеть недоступна, включается явно помеченный синтетический погодный сценарий.

*Концепт сохранён для greenfield-пересборки на IWSDK — см. MIGRATION.md. Первая цель — apps/weather-room.*

## 3. CITY//ORBIT

Сайт получает координаты пользователя и загружает ближайшие места из OpenStreetMap. Но вместо плоской карты появляется маленькая пространственная система:

```text
             museum
               ●

 café ●      YOU      ● ITMO

          ● monument
```

Она может лежать на столе как голографический макет или развернуться вокруг человека на 360°. Наводишь руку на точку — видишь «Кунсткамера · 430 м». Вытягиваешь её вверх — появляется пространственная карточка места.

Самая важная механика — масштабирование мира двумя руками. Разводишь ладони: **200 м → 1 км → 5 км**. Чем больше реального жеста, тем меньше становится город между руками. Никаких скачанных 3D-моделей: только координаты, типы и названия, превращённые в свет, высоту и расстояние.

Данные приходят через Overpass. Первым используется российский узел **VK Maps / Mail.ru** — `https://maps.mail.ru/osm/tools/overpass/api/interpreter`; дальше идут публичные международные зеркала. Запросы короткие и кэшируются, гонка зеркал берёт первый ответ. Публичные серверы отвечают то за секунду, то за десятки секунд, поэтому опыт не ждёт сеть: сразу появляется художественный квартал-заглушка, который заменяется живыми данными, как только они придут. Если не ответил никто — остаётся явно помеченный офлайн-квартал у Эрмитажа.

*Концепт сохранён для greenfield-пересборки на IWSDK — см. MIGRATION.md.*

## 4. SOUND//SPACE

Звук превращается в пространство.

Открываешь страницу, разрешаешь микрофон — и окружающий звук начинает строить перед тобой живую светящуюся структуру. Речь оставляет нервный рельеф, музыка собирается в плавные спектральные волны, хлопок выпускает мощное кольцо.

Самое красивое действие — остановить момент. Скажи «Staniverse», нажми или сделай pinch и получи физическую 3D-скульптуру этой фразы. Затем заморозь следующую, и ещё одну. Постепенно вокруг появляется пространственная история последних минут: на Quest через неё можно пройти, на телефоне — осмотреть камерой и гироскопом, на десктопе — обойти мышью.

Единый язык управления:

- **tap / click / pinch** — заморозить текущий звук;
- **drag** — повернуть или переставить скульптуру;
- **hold / squeeze** — удалить выбранный слой.

Внутри только Web Audio API, FFT и шейдеры. Никакого сервера, AI и внешнего API — **0 ₽**. Микрофон не записывается и никуда не отправляется.

*Концепт сохранён для greenfield-пересборки на IWSDK — см. MIGRATION.md.*

## 5. ECHO//ROOM

Каждое действие оставляет временной след.

Перемещаешь указатель — его траектория ещё несколько секунд висит в воздухе полупрозрачной линией. Делаешь tap — в точке возникает импульс ✦. Постепенно пространство начинает помнить последние 60 секунд твоего присутствия.

Но это не просто следы. Нажми на старый импульс — и время отмотается **локально**, только вокруг выбранной точки. Рядом раскроются прозрачные состояния пространства:

```text
NOW
−1 sec
−2 sec
−3 sec
−4 sec
```

Получается трёхмерный temporal debugger реальности: не видео всей комнаты, а её пространственная память, которую можно исследовать одной рукой.

*Концепт сохранён для greenfield-пересборки на IWSDK — см. MIGRATION.md.*

---

## 8th Wall: отдельные AR-опыты

- **[Knockdown](8thwall/knockdown/)** — физическая диорама на реальной поверхности: снарядами разбиваешь архитектурную башню.
- **[Portal](8thwall/portal/)** — ставишь на стену портал и смотришь сквозь него в другой объём.
- **[Sea Battle](8thwall/sea-battle/)** — переосмысление советского перископного автомата 1974 года: акватория разворачивается на безопасной дистанции перед игроком, корабли идут по цепным линиям, торпеды требуют упреждения, 10/10 открывает призовую игру.

У этой полки свой визуальный язык, но тот же принцип: AR не закрывает комнату, а аккуратно занимает найденную поверхность; HUD учитывает safe-area, узкие и горизонтальные экраны.

## Локальный запуск каталога

```bash
npm ci
npm run build
npx http-server _site -c-1 -p 8090
```

## Структура репозитория

```text
apps/                     новые опыты на Meta IWSDK (Quest 3 / Android WebXR)
8thwall/                  8th Wall / A-Frame приложения
scripts/build-all.js      сборка 8th Wall в _site/
index.html                двуязычный каталог
_site/                    генерируемый Pages artifact
```

### Добавить новый опыт

- **8th Wall:** создай `8thwall/<name>/` с `config/webpack.config.js`, который выпускает `dist/`, и добавь npm scripts по образцу существующих приложений.
- **Другой движок:** создай `apps/<name>/` и собери его независимо; не складывай его зависимости в `8thwall/`.

## Данные, лицензии и приватность

- Собственный код репозитория — MIT.
- OpenStreetMap — © OpenStreetMap contributors, ODbL; публичные Overpass-серверы используются умеренно, с ограничениями и кэшем.
- Open-Meteo вызывается для почасовой выборки концепта WEATHER//ROOM (первая цель — apps/weather-room); ключ не нужен.
- Overpass API — источник данных концепта CITY//ORBIT.
- Микрофон SOUND//SPACE анализируется локально через Web Audio API. Аудио не сохраняется и не отправляется.
- Геолокация используется только для погодного и городского запросов после разрешения браузера.

## English summary

Adaptive WebXR art experiments, designed for Meta Quest 3 first and kept meaningful on phone AR and desktop. New Meta IWSDK experiences live under `apps/`; 8th Wall camera-AR experiments live under `8thwall/`. The room itself is the medium: geometry becomes a force field, weather becomes atmosphere, OSM becomes a hand-scaled city, sound becomes sculpture, and the last minute becomes a spatial time debugger. The five concepts are retained as greenfield IWSDK rebuild targets (see MIGRATION.md); 8th Wall apps keep working unchanged.
