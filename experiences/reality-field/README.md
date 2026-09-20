# REALITY//FIELD

Живое демо — на GitHub Pages репозитория, путь `/experiences/reality-field/`.

## Управление

| Платформа | Импульс | Заряд | Оттолкнуть | Притянуть | Растянуть поле |
|---|---|---|---|---|---|
| Quest 3 | pinch / луч | pinch-hold | открытая ладонь | кулак | две руки врозь (spread) |
| Смартфон AR | тап | долгий тап | — | — | — |
| Десктоп | клик | — | клавиши? нет: только просмотр волн | — | — |

Кнопки HUD: **DEBUG REALITY** — wireframe комнаты, скелет рук, лучи, FPS, состояние depth-mesh. **DREAM REALITY** — крупные аддитивные частицы, медленные волны.

## Как это работает (XB API)

- `options.enableDepth()` — на Quest даёт живой `xb.depth.depthMesh`; импульс рейкастится в него через `THREE.Raycaster`, нормаль берётся из `hit.face.normal`.
- Вне XR depth-mesh нет — fallback: невидимые пол и сфера-комната радиусом 3.4 м. Те же рейкасты, те же волны.
- Жесты: `options.enableGestures()` + `xb.core.gestureRecognition` события `gesturestart`/`gestureend` (`pinch`, `open-palm`, `fist`, `spread` — последний включается отдельно).
- Эмиттер: `xb.user.getControllerPosition(0)` + `xb.user.getRay(0)`, fallback — камера. Один код для мыши, контроллеров и рук.
- Частицы: один `THREE.Points` на 1400 точек, физика на CPU (пружина + затухание + фронты волн + пол/сфера). Пул из 10 колец `RingGeometry` для ударов.

## План

- **v0 (этот прототип):** импульсы, волны, 4 жеста, DEBUG/DREAM, fallback-комната. Готово.
- **v1:** настоящий `depthMesh` как коллайдер для частиц (сейчас — только для точки удара), `updateVertexNormals` для честных отражений; следы волн, стекающие по столу.
- **v2:** Rapier (`xrDepthMeshPhysicsOptions`, см. `templates/10_environment_physics`) — шары с рикошетом от реальной геометрии; gravity wells двумя руками через дистанцию между контроллерами.
