# XR Blocks 0.21.1 — справочник проекта

Единая точка правды вместо угадывания. Всё ниже проверено по локальным
первоисточникам пакета `xrblocks@0.21.1` и официальному сайту документации.
Версия закреплена в import-map всех пяти опытов; при апгрейде — перечитать
раздел «Источники» и сверить diff.

## Источники (в порядке авторитетности)
| Что | Где |
|---|---|
| **Скиллы (установлены)** | `.agents/skills/xb-*` — 8 штук, подхватываются OMP-провайдером; sync: `npm run skills:sync` (= postinstall) |
| Полный исходник SDK | `node_modules/xrblocks/src/` (npm-пакет несёт `build/ skills/ src/`) |
| Мануалы онлайн | <https://xrblocks.github.io/docs/manual/>: Interaction, Placement, UI, World, Depth, Simulator и др. |
| Правила для агентов | `AGENTS.md` в корне (читается харнессом автоматически) |
| Типы API | `node_modules/xrblocks/build/xrblocks.d.ts` |

Правило скиллов перед любым изменением: сначала сверить каждый планируемый
символ с исходником/типами, потом смотреть живой шаблон/сэмпл, и только потом
писать код. Скилл `xb-add-world-sensing` прямо требует это для всех
`world.*` веток.

## Контракты, о которые мы уже споткнулись

### Premultiplied-alpha и аддитивное свечение (главный AR-контракт)

Рендерер создаётся с `alpha: true` (Core.ts), канвас — premultiplied.
Обычный `THREE.AdditiveBlending` копит не только RGB, но и альфу канваса:
комозитор браузера в `alpha-blend`-сессии гасит камеру под каждым «свечением»
— вместо света грязное пятно, визуал «бедный». Все светящиеся материалы
проекта идут через `glowBlending()` (`common/fx.js`): раздельный blend — RGB
аддитивно, альфа канваса не растёт (`out = glow + camera`). В opaque-VR и на
тёмном превью поведение идентично старому, поэтому применяется статически,
без переключения по сессиям. Новые светящиеся материалы — только через
`glowBlending(...)`, не `blending: AdditiveBlending`.

### Одна interaction-pipeline, никаких вторых рейкастеров

- Все источники ввода (мышь, взгляд, лучи, direct touch, симулятор) дают
  **одно разрешённое попадание** через события. В колбэке использовать
  `event.target / surface / intersection / currentTarget` — свой `Raycaster`
  внутри колбэка видит другой кадр и может выбрать другую поверхность.
- Вне события: `xb.user.getRayIntersection(0)`, `getIntersectionAt(obj, 0)`,
  `isPointingAt`, `isSelectingAt`, `isManipulating`.
- **Reticle — только презентация попадания.** Размер по умолчанию 3.8 см,
  pressed-состояние — заливка белым. Не владелец данных, не отдельный API.
- `stopPropagation()` ≠ `preventDefault()`: первый режет бабблинг, второй
  подавляет дефолтное действие (доступен на touch start и manipulation).
- `onSelectEnd`: `completed` true только при валидном завершении; `reason`:
  `released | released-outside | source-lost | pointer-cancel | removed |
  hidden | disabled`.
- Манипуляция: состояние на объекте-владельце, не в глобальном слоте.
  Два источника на одном scale-владельце = two-source scale.

### Spatial UI: корень выбирается по системе координат

| Корень | Пространство | Для чего |
|---|---|---|
| `UICard` | мир, метры | меню, инструменты, передвигаемые панели |
| `UIOverlay` | view-space, layout в приватном viewport-контейнере | HUD, статус, вью-фиксированные контролы |
| `UIPanel` | внутри card/overlay, UIKit-единицы | вложенные ряды/секции |

- `UICard.size.width` — метры, фиксировать; `height: 'auto'` — по контенту.
  Все числовые размеры детей — UIKit-единицы, НЕ метры. `lineHeight` числом =
  множитель fontSize.
- `manipulation: true` — стандартное перемещение+скейл; `edge: true` — полоса
  перетаскивания по краю (требует translate).
- **Для телефонного AR-интерфейса канон — `UIOverlay`** (прибит к вьюпорту),
  а не world-lock карточка. Наш `hud.js` сейчас делает кастомный follow —
  см. «Отклонения от канона».

### Placement scripts — не писать свои follow-лупы

SDK даёт готовые скрипты-дети, которые двигают родителя (`card.add(...)`):

| Скрипт | Управляет | Заметки |
|---|---|---|
| `FollowHead` | position | `offset` — camera-space в метрах, −Z перед глазами; `smoothing` (умолч. 0.1, больше = быстрее) |
| `FaceCamera` | rotation | режимы `capsule` (умолч., `capsuleHalfHeight` 0.25), `cylindrical`, `spherical` |
| `FollowObject` | pos/rot/pose | `mode: 'position' | 'rotation' | 'pose'`; не совмещать `pose` с `FaceCamera` |
| `Orbit`, `VisibilityTransition` | position / visibility | отдельные случаи |

`FollowHead` + `FaceCamera` управляют разными частями трансформа и не
конфликтуют. Один раз разместить объект на поверхности — не placement script,
а `xb.world.placeOnHorizontalSurface(obj, {seconds})` → boolean.

### Anchors (`options.world.enableAnchors()`)

- Фича запрашивается **optional**: браузер без якорей всё равно входит в
  сессию, подсистема рапортует `unsupported`.
- `anchors.capability`: `persistent | session-only | simulated | unsupported`.
  `create()` возвращает `null` вместо throw; `getPose(id, refSpace)` — `null`
  вне своего кадра (читать только в frame loop).
- **Бюджет персистентных якорей общий на все origin браузера** и мал: на
  Quest 3 (авг 2026) шестой якорь отклонён. `persist() == false` — норма,
  показывать `anchors.lastError`. Освобождение: `delete(id)` — один;
  `forgetAll()` — все записи приложения; `releaseAllPlatformHandles()` — все
  хэндлы origin (деструктивно, только по явному действию пользователя).
- Десктоп-разработка: `options.world.anchors.simulatorFallback = true`
  (умолч. выкл; `capability === 'simulated'` — доказывает проводку, не
  релокацию).
- Хранение: `localStorage`, ключ `options.world.anchors.storageKey`, лимит
  `maxStoredAnchors` (старые вытесняются).

### World sensing: пустой результат — норма

- **Planes (`enablePlaneDetection()`) — грубые семантические поверхности,
  могут быть пусты всегда** (телефонный Chrome без флага
  `openxr-spatial-entities` — наш случай). Код обязан переживать пустой
  список без деградации.
- Scene meshes (`world.enableMeshDetection()`) — экспериментальная
  платформенная геометрия; карта `xrMeshToThreeMesh` может быть пуста.
- Depth (`enableDepth()`): `xb.depth.depthMesh` — живой меш (на Quest);
  `getDepth(u,v)`; для рейкастов по умолчанию **даунсемпленная** геометрия
  (`useDownsampledGeometry`), full-res — дороже. Ретикл на глубину:
  `options.reticles.projectOnDepthMesh = true`. Владение через
  `core.depth.resumeDepth(script)/pauseDepth(script)` — SDK сам ставит сенсор
  на паузу, когда никто не слушает.
- Depth ≠ физика: Rapier подключается отдельно (`options.physics.RAPIER`),
  `xrDepthMeshPhysicsOptions` — НЕ переключатель физики.
- Детекторы (объекты/люди/лица/сегментация): пустые массивы на прогреве —
  норма; непрерывный режим — строго парой `start(client)`/`stop(client)` с
  одним и тем же клиентом. На десктопе людям-детекция нужен
  `options.enableCamera('user')` ПОСЛЕ хелпера.

### Simulator (десктоп без WebXR)

- **Не эмулирует браузерный WebXR API** — свой рантайм с теми же скриптами,
  таргетингом и world-API. Значит: поведение «настоящего» immersive-ar
  телефона (например `environmentBlendMode: 'alpha-blend'`) в симуляторе не
  воспроизводится и должно проверяться на устройстве.
- Старт: `options.xrButton.showEnterSimulatorButton = true` (у нас включён
  везде), автостарт — `options.formFactor = 'desktop'` или
  `?formFactor=desktop`; из кода `await xb.core.startSimulator()`.
- Режимы: `USER / POSE / CONTROLLER / POINTER_LOCK / EDITOR`
  (`options.simulator.defaultMode`, `modeToggle.enabled`).
- **Отладка: `?debug=1` открывает `window.xb` и промис `window.xbReady`** —
  прямой доступ к сцене/камере/опциям из консоли и автотестов. Ещё
  `?xrAutomation=1` — пресет automation-режима.
- О_envы: JSON-манифесты (glb + planes + navmesh + детектируемые объекты);
  `simulatorOverride = true` у детекторов даёт детерминированный ground
  truth.

## Наш стек: где мы отклоняемся от канона (сознательно)

| Место | Канон | У нас | Почему / что учесть |
|---|---|---|---|
| Телефонный HUD | `UIOverlay` (view-space) | `common/hud.js`: `UICard` + свой follow-демпфер в `alpha-blend`, world-lock+якорь после ручного перетаскивания; DOM-фолбэк `.phone-controls` до/вне сессии | Нужен «следуй, пока не закрепил» — placement-скрипты такого не дают в лоб. Кандидат на рефактор: `UIOverlay` или `FollowHead`+`FaceCamera` + наш флаг закрепления |
| Превью до сессии | нет такого состояния | `previewFromEyeHeight()` в `common/boot.js` | Телефон с WebXR не запускает симулятор → камера в полу |
| Даунгрейд фич сессии | — | `installXrGuards()` в `boot.js`: повторный `requestSession` без `depth-sensing/hand-tracking/local-floor` | Телефонный Chrome отклоняет сессию с этими required-фичами; SDK помечает их required |
| Passthrough-детект | — | `isPassthrough()` в `boot.js` (`environmentBlendMode === 'alpha-blend'` = телефон; Quest отдаёт `additive`) | Частицы/кольца аддитивные, VR-декорации (пол/палуба/дымка) в AR прячутся через `hideInPassthrough` |

## Карта «опыт → API SDK»

| Опыт | Включает | Особенности |
|---|---|---|
| REALITY//FIELD | `enableHands`, `enableGestures`, `enableDepth`, `enableReticles`, rays/hands visualization | depth-mesh как цель импульса + fallback-комната; жесты `pinch/open-palm/fist/spread` через `gestureRecognition` |
| WEATHER//ROOM | `enableReticles`, `enablePlaneDetection`, `world.enableAnchors` | planes → splash-поверхности (пустые на телефоне → всплески выключены в passthrough); якорь HUD |
| CITY//ORBIT | geolocation + Overpass, ручной/авто масштаб | unlit-голограмма (MeshBasicMaterial) — палитра тёмная, в AR читается как тёмная масса |
| SOUND//SPACE | Web Audio FFT + mic | скульптуры freeze по тапу (`onSelectEnd` → `freeze()`) |
| ECHO//ROOM | ring buffer следов | временные слои по клику на след |

## Как проверять, не гадая

1. **Десктоп-симулятор**: открыть опыт, `?debug=1`, в консоли `window.xb` —
   сцена, `xb.core.camera`, опции. Симулятор стартует автоматически (кнопка
   Enter Simulator).
2. **Automation-режим** (`?test=1` у нас / `?xrAutomation=1` у SDK) для
   headless-прогонов: спрятанный UI, детерминированный режим.
3. **Телефон**: только реальное устройство — `alpha-blend`, тач-пути Chrome и
   пустые planes в симуляторе не воспроизводятся. Чек-лист скиллов: для
   каждого действия — simulator-шаги, XR-ввод, ожидаемый фидбек, отмена,
   device-only проверки.
4. **Quest**: якоря/depth/жесты — проверять бюджет якорей до демонстрации
   (шестой может быть отклонён).

## Долги

- ~~hud.js follow → FollowHead/FaceCamera~~ — сделано (v22): телефонный AR до
  перетаскивания ведут placement-скрипты SDK, после — world-lock + якорь.
- ~~`projectOnDepthMesh` не включён~~ — включён в reality-field (прицел
  проецируется на реальную геометрию на Quest).
- ~~premultiplied-alpha~~ — закрыто контрактом `glowBlending` (см. выше);
  яркостный запас в AR: weather ×1.3/×1.5, reality-линии ×1.8.
- `samples/xr_realism/reticle` и `templates/03_spatial_placement` — образцы
  для splash-поверхностей weather и размещения city.
