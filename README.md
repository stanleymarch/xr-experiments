# xr-experiments

Коллекция WebXR-опытов, в которых реальная комната перестаёт быть фоном и становится материалом произведения. Основная платформа — **Meta Quest 3** (mixed reality); каждый опыт остаётся осмысленным на Android WebXR и на десктопе в эмуляторе.

Общий принцип: не приносить в XR готовую 3D-сцену, а проявлять то, что уже окружает человека, но обычно невидимо — геометрию комнаты и погоду за окном. Эти данные становятся материей: по комнате можно ударить, и она ответит волной; погоду можно взять и развернуть вокруг себя во времени.

**Живой каталог:** <https://stanleymarch.github.io/xr-experiments/>  
**Автор:** <https://staniverse.xyz>

- **[`apps/`](apps/)** — MR-опыты на Meta Immersive Web SDK (IWSDK): Quest 3 и Android WebXR. Собираются независимо.
- **[`8thwall/`](8thwall/)** — самостоятельные 8th Wall / A-Frame camera-AR опыты со своей webpack-сборкой.
- **[`docs/ideas/`](docs/ideas/)** — замыслы, которые не входят в текущий каталог и не имеют кода.
- Следующий движок можно добавить соседней папкой, не смешивая его зависимости и жизненный цикл с остальными.

GitHub Actions собирает активные 8th Wall и IWSDK-приложения в единый `_site/` и публикует каталог на GitHub Pages. Исходники и служебные настройки в `_site/` не копируются.

Ниже — два законченных опыта: о чём они, как играются и как устроены. Художественные принципы, устройство эффектов и границы sensing разобраны в [«Комната как материал»](docs/room-as-medium.md).

## Каталог

Два MR-опыта на Meta Immersive Web SDK. Оба работают с одной идеей: измеренная
комната — не подложка для 3D-объектов, а сама материя произведения. Но материал
разный: в REALITY//FIELD это геометрия, в WEATHER//ROOM — погода.

### REALITY//FIELD — комната как упругое поле

**О чём.** Ты входишь в XR, и обычная комната перестаёт быть декорацией.
Стены, стол, пол и мебель, которые headset уже измерил, становятся единой
натянутой мембраной. Ты не ставишь в комнату виртуальные предметы — ты
касаешься самой комнаты, и она отвечает.

**Как играется.** Наводишь луч на реальную поверхность — в точке контакта
появляется мягкая искра, она растёт, пока держишь pinch или курок. Отпускаешь —
импульс бьёт в это место: тонкий светящийся фронт бежит по геометрии,
продавливает её и уходит дальше по полу, стене и мебели. Две руки в pinch
растягивают поле: чем шире размах, тем сильнее и быстрее следующий удар.
Открытая ладонь раздвигает пыль в воздухе, кулак собирает её к себе.

**Два лица.** DREAM REALITY — поэтический слой: в покое комната не тронута,
её освещает только собственная волна, в воздухе висят пылинки. DEBUG REALITY —
техническая изнанка: прямоугольники найденных плоскостей, границы mesh-комнат,
луч указателя, точка контакта, нормаль и счётчики того, что комната знает.

**Как устроено.** IWSDK-сессия с plane/mesh detection собирает измеренные
поверхности в одну world-space «кожу» (до 60 000 вершин, обновление с
задержкой 0.4 с). Удар ищется аналитически: луч пересекается с
прямоугольниками плоскостей и bounds мешей, без raycast по тяжёлой геометрии.
Восемь импульсов живут в uniform-массиве: вершинный шейдер продавливает кожу,
фрагментный считает свет по пикселям, поэтому фронт остаётся тонким контуром,
а не размазанной заливкой. Симуляции на CPU нет; сеть, разрешения и микрофон
не нужны.

**С чем связано.** Это развитие идеи «комната как материал» из
[docs/room-as-medium.md](docs/room-as-medium.md): тот же принцип, что в
WEATHER//ROOM, но материалом становится не погода, а сама геометрия.
Подробности, замеры и честный список непроверенного — в
[README приложения](apps/reality-field/README.md); бриф — в
[docs/tasks/reality-field.md](docs/tasks/reality-field.md).

**Статус.** Проверено в IWER (эмуляция Quest 3, `immersive-ar`): удар
контроллером и рукой, волна по полу/столу/софе/стенам, DEBUG-слой, панель,
натяжение двумя руками, корректный выход из сессии. Физический Quest 3 и
Android пока не проверялись — `adb devices` пуст.

**Открыть:** <https://stanleymarch.github.io/xr-experiments/iwsdk/reality-field/>

### WEATHER//ROOM — погода за окном как материал комнаты

**О чём.** Комната становится физическим воплощением погоды за окном. Если
с юго-запада дует ветер 8 м/с, поток частиц действительно проходит через
пространство с этого направления. Дождь падает на горизонтальные поверхности.
Облачность гасит виртуальный свет. Температура меняет цвет, плотность и
подвижность воздуха. Давление поднимает или опускает условный потолок
атмосферы.

**Как играется.** Время здесь тоже становится предметом. Шкала
**−24h ← NOW → +24h** позволяет рукой проматывать вчерашний дождь, нынешний
ветер и завтрашнее прояснение, не делая новый сетевой запрос на каждом кадре.
Панель показывает источник данных и координаты, с которыми работает опыт.

**Как устроено.** Источник — [Open-Meteo](https://open-meteo.com/): API не
требует ключа или регистрации. Один запрос при открытии приносит почасовой
ряд, после чего визуализация и перемотка работают локально. Если провайдер
недоступен, включаются MET Norway, затем wttr.in, затем явно помеченный
синтетический сценарий; геолокацию можно заменить ручной точкой.

**С чем связано.** Та же идея, что в REALITY//FIELD, но материал — не
геометрия, а состояние атмосферы. Погодные mappings, провайдеры и результаты
runtime-приёмки — в [README WEATHER//ROOM](apps/weather-room/README.md).

**Статус.** Работает как нативное IWSDK-приложение; runtime-проверка в IWER
описана в README приложения. Физический Quest 3 и Android — по той же
оговорке, что выше.

**Открыть:** <https://stanleymarch.github.io/xr-experiments/iwsdk/weather-room/>

### Идеи, которые пока не в работе

Нереализованные замыслы собраны в [`docs/ideas/`](docs/ideas/) — вне каталога
и вне сборки. Они сохранены как концепции, а не как обещания.

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
apps/                     MR-опыты на Meta IWSDK (Quest 3 / Android WebXR)
8thwall/                  8th Wall / A-Frame приложения
docs/room-as-medium.md    творческая и техническая механика опытов
docs/ideas/               замыслы вне текущего каталога
scripts/build-all.js      сборка активных 8th Wall и IWSDK в _site/
index.html                двуязычный каталог
_site/                    генерируемый Pages artifact
```

### Добавить новый опыт

- **8th Wall:** создай `8thwall/<name>/` с `config/webpack.config.js`, который выпускает `dist/`, и добавь npm scripts по образцу существующих приложений.
- **Другой движок:** создай `apps/<name>/` и собери его независимо; не складывай его зависимости в `8thwall/`.

Локальные `.omp/` и `.agents/` (включая копии внутри приложений) исключены из
Git: настройки моделей, сессии, промпты и генерируемые skills не являются
исходниками опыта. Они сохраняются на рабочей машине; `npm run skills:sync`
восстанавливает официальные skills для чистого клона. Удаление из текущего
дерева Git не переписывает уже опубликованную историю.

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
1. full official `iwsdk-*` skill sync from the ignored local
   `apps/weather-room/.agents/skills` into `.agents/skills/` and `.omp/skills/`.
   On a clean clone, the helper first generates the matching official
   `@iwsdk/create` skills in a temporary app, without installing dependencies
   or overwriting application source; no OMP model/routing changes;
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

## Данные, лицензии и приватность

- Собственный код репозитория — MIT.
- Open-Meteo вызывается для почасовой выборки WEATHER//ROOM; ключ не нужен. Резервные источники — MET Norway и wttr.in.
- Геолокация запрашивается браузером только для погодного запроса; её можно заменить ручной точкой. Позиция не сохраняется на сервере.
- 8th Wall-опытам нужна камера; без разрешения они не запускаются.

## English summary

Adaptive WebXR art experiments, designed for Meta Quest 3 first and kept meaningful on phone AR and desktop. Two Meta IWSDK mixed-reality experiences live under `apps/`: **REALITY//FIELD** turns the measured room into an elastic membrane that answers a strike with a travelling wave, and **WEATHER//ROOM** manifests local weather around you on a −24h/NOW/+24h timeline. Three 8th Wall camera-AR experiments live under `8thwall/`. The room itself is the medium; unrealised concepts are archived in `docs/ideas/` rather than promised in the catalog.
