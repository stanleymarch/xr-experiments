// REALITY//FIELD — комната как физическое поле.
//
// Референс (концепт): тонкий циановый импульс из кончика пальца бьёт в
// реальную стену, вспыхивает в точке удара, расходится компактным кольцом
// по отсканированному мешу и осыпается частицами на пол. Метки интерфейса:
// «DEBUG REALITY», «DREAM REALITY», «CHARGE 68%», «FPS 72».
//
// Платформы: Quest 3 / Android XR (жесты и лучи), смартфон AR (тап =
// импульс, удержание = заряд), десктоп (клик), универсальный тест — ?test=1.
//
// Правки после мобильного прогона (реальность вместо чёрного экрана):
//  * depth-sensing и hand-tracking — фичи гарнитур. Раньше они требовались
//    всегда: на телефоне запрос сессии отвергается, а без выданной
//    depth-фичи кадровый вызов SDK падает и кадр вообще не рисуется.
//    Теперь фичи запрашиваются только там, где платформа их даёт, а
//    отсутствие depth честно показано в статусе («depth НЕТ») — импульс
//    бьётся о виртуальную плоскость пола и сферу-каркас, без заявки на
//    сканирование комнаты.
//  * Начальная композиция: поле ставится перед камерой, а не вокруг начала
//    координат — иначе на телефоне в кадре пустота.
//  * Ошибка инициализации/сессии показывается на экране, а не тонет в
//    консоли: чёрный экран без объяснения — баг.
//  * Bloom в прозрачном AR не подключаем: пост-обработка выжигает passthrough.

import * as THREE from 'three';
import * as xb from 'xrblocks';
import {
  COLORS, baseOptions, createHud, watchSession, spatialControls,
  anchorRoot, fpsMeter,
} from '../common/shell.js';
import {
  glowBlending, softParticlesMaterial, particleAttributes, ringShockMaterial,
  beamMaterial, tickMaterials,
} from '../common/shaders.js';
import { glowTexture, spritePool } from '../common/sprites.js';

const COUNT = 1400;
const ROOM_R = 3.4;
const ROOM_C = new THREE.Vector3(0, 1.6, 0);
const RING_DUR = 0.9;
const RING_MAX = 0.32;   // компактные кольца: ≤32 см, не «огромные белые круги»
const BEAM_DUR = 1.05;
const FIRE_DEDUPE = 0.15;
// Центр спирали по вертикали (локальные координаты поля). По нему считаем
// начальную композицию, чтобы поле целиком попадало в кадр телефона.
const FIELD_MID_Y = 1.4;
const DOCK_DIST = 2.4;    // дистанция начальной композиции, метры
const DREAM_SCALE = 0.45; // замедление времени в DREAM
const HEADSET_UA = /OculusBrowser|Quest|Pico|Vive|Wolvic|Helio|Android XR|XREAL|Lynx|Vision ?Pro/i;

window.__RF_VER = 4; document.documentElement.dataset.rfVer = '4';

/* ---------- видимость ошибок ---------- */

/** Ошибка должна быть видна: чёрный экран без текста чинить нечем. */
function showFatal(message) {
  let el = document.getElementById('rf-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rf-error';
    el.setAttribute('role', 'alert');
    el.style.cssText = 'position:fixed;z-index:40;left:10px;right:10px;' +
      'top:calc(env(safe-area-inset-top, 0px) + 62px);padding:10px 12px;' +
      'border:1px solid #ff6b5e;border-radius:10px;background:rgba(42,12,14,.92);' +
      'color:#ffd9d4;font:600 12px/1.45 ui-monospace,Menlo,Consolas,monospace';
    document.body.appendChild(el);
  }
  el.textContent = message;
}

function hideFatal() {
  document.getElementById('rf-error')?.remove();
}

/** Приводит к тексту что угодно: SDK умеет бросать объекты-события. */
function describeError(e) {
  if (!e) return 'неизвестная ошибка';
  if (typeof e === 'string') return e;
  const named = [e.name, e.message].filter((v) => typeof v === 'string' && v);
  if (named.length) return named.join(': ');
  if (e.type) return `событие ${e.type}${e.target?.src ? ` (${e.target.src})` : ''}`;
  try { return JSON.stringify(e).slice(0, 200); } catch { return String(e); }
}

/** true/false — если браузер отдал список выданных фич сессии; иначе undefined. */
function sessionFeature(session, name) {
  const list = session?.enabledFeatures;
  if (!Array.isArray(list)) return undefined;
  return list.some((f) => f === name || f?.feature === name);
}

/**
 * Что реально доступно на этом устройстве. depth-sensing и hand-tracking в
 * WebXR есть только на гарнитурах; требовать невыданную фичу нельзя —
 * requestSession отвергается целиком, и опыт не стартует вообще.
 * Гарнитуру определяем по UA и по поддержке immersive-vr (телефоны её не дают).
 */
async function detectCapabilities() {
  const caps = { headset: HEADSET_UA.test(navigator.userAgent || ''), ar: false, hands: false, depth: false };
  const xr = navigator.xr;
  if (!xr?.isSessionSupported) return caps;
  const supports = async (mode) => {
    try { return !!(await xr.isSessionSupported(mode)); } catch { return false; }
  };
  caps.ar = await supports('immersive-ar');
  caps.headset = caps.headset || await supports('immersive-vr');
  caps.hands = caps.headset;
  caps.depth = caps.headset;
  return caps;
}

const caps = await detectCapabilities();

class RealityField extends xb.Script {
  init() {
    try { this._init(); }
    catch (e) {
      const msg = describeError(e);
      console.error('[RF] INIT FAIL', e);
      document.documentElement.dataset.rfInitErr = msg;
      try { this.hud?.setStatus(`ОШИБКА инициализации: ${msg}`); } catch { /* HUD ещё не создан */ }
      showFatal(`REALITY//FIELD не запустился: ${msg}`);
      throw e;
    }
  }

  _init() {
    // --- состояние (нужно раньше UI: обработчики читают эти поля) ---
    this.debug = false;
    this.dream = false;
    this.fx = new Set();
    this.waves = [];
    this.charge = 0;
    this.pinchHeld = false;
    this.touchHeld = false;
    this.lastFire = -1;
    this.fired = 0;
    this.fps = 0;
    this._timeScale = 1;
    this._composed = false;
    this._depthWanted = !!caps.depth;   // просили ли мы depth-sensing
    this._session = null;
    this._err = '';
    this._notes = [];
    this._anchorTries = 0;

    // --- UI: DOM-HUD вне сессии + пространственная панель внутри XR ---
    // Создаём первым: если сцена упадёт ниже, ошибку будет куда показать.
    const toggleDebug = () => this.setDebug(!this.debug);
    const toggleDream = () => this.setDream(!this.dream);
    this.hud = createHud({
      title: 'REALITY//FIELD',
      controls: [
        { id: 'debug', label: 'DEBUG REALITY', onClick: toggleDebug },
        { id: 'dream', label: 'DREAM REALITY', onClick: toggleDream },
      ],
      hint: 'тап — импульс · удержание — заряд · жесты: pinch/open-palm/fist/spread',
    });
    try {
      this.spatial = spatialControls({
        title: 'REALITY//FIELD',
        status: 'CHARGE 0% / 0 FPS',
        controls: [
          { id: 'debug', label: 'DEBUG REALITY', onClick: toggleDebug },
          { id: 'dream', label: 'DREAM REALITY', onClick: toggleDream },
        ], width: 0.68,
      });
      // Основное поле и точка удара должны оставаться открыты: панель уводим
      // вверх вправо, как приборную вставку из референса.
      this.spatial.card.position.set(0.78, 1.72, -1.25);
      this.add(this.spatial.card);
    } catch (e) {
      this.spatial = null;
      this.note(`пространственная панель недоступна: ${(e && e.message) || e}`);
    }

    this.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.4));
    const sun = new THREE.DirectionalLight(0x88ccff, 1.4);
    sun.position.set(1, 3, 2);
    this.add(sun);

    // Всё содержимое — в anchored root: платформа уточняет карту комнаты,
    // якорь удерживает поле на месте (лечит «улетание» трекинга).
    this.root = new THREE.Group();
    this.root.name = 'reality-field-root';
    this.add(this.root);
    this.anchor = anchorRoot();

    // --- поле частиц ---
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    this.vel = new Float32Array(COUNT * 3);
    this.home = new Float32Array(COUNT * 3);
    this.homeCol = new Float32Array(COUNT * 3);
    const c = new THREE.Color();
    // Не «пыль на стенах», а 18 медленно переплетённых силовых линий.
    // Спирали дают читаемую структуру с любого направления и сохраняют
    // свободный центр для импульса/impact.
    const strands = 18;
    const rows = Math.ceil(COUNT / strands);
    for (let i = 0; i < COUNT; i++) {
      const strand = i % strands;
      const u = Math.floor(i / strands) / Math.max(1, rows - 1);
      const radius = 0.48 + (strand / (strands - 1)) * 2.45;
      const a = strand / strands * Math.PI * 2 + u * Math.PI * 3.4;
      const jitter = () => (Math.random() - 0.5) * 0.055;
      const x = Math.sin(a) * radius + jitter();
      const y = 0.12 + u * 2.55 + Math.sin(a * 1.7) * 0.07 + jitter();
      const z = Math.cos(a) * radius * 0.78 + jitter();
      pos.set([x, y, z], i * 3);
      this.home.set([x, y, z], i * 3);
      c.setHSL(0.52 + 0.16 * (strand / strands), 0.92, 0.56);
      col.set([c.r, c.g, c.b], i * 3);
      this.homeCol.set([c.r, c.g, c.b], i * 3);
    }
    this.pgeo = new THREE.BufferGeometry();
    this.pgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.pgeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    particleAttributes(this.pgeo, { scaleRandom: 0.4 });
    this.pmat = softParticlesMaterial({
      size: 0.04, color: COLORS.accent, twinkle: 0.9,
      map: glowTexture({ core: 0.1 }),
    });
    this.points = new THREE.Points(this.pgeo, this.pmat);
    this.points.frustumCulled = false;
    this.root.add(this.points);

    // Непрерывные splines связывают точки в читаемые силовые траектории.
    // Это намеренно не wireframe комнаты: линии принадлежат только полю.
    this.fieldLines = new THREE.Group();
    this.flowMaterials = [];
    this.flowBase = [];
    for (let strand = 0; strand < strands; strand++) {
      const path = [];
      const radius = 0.48 + (strand / (strands - 1)) * 2.45;
      for (let row = 0; row < rows; row++) {
        const u = row / Math.max(1, rows - 1);
        const a = strand / strands * Math.PI * 2 + u * Math.PI * 3.4;
        path.push(new THREE.Vector3(
          Math.sin(a) * radius,
          0.12 + u * 2.55 + Math.sin(a * 1.7) * 0.07,
          Math.cos(a) * radius * 0.78,
        ));
      }
      c.setHSL(0.52 + 0.16 * (strand / strands), 0.92, 0.6);
      const material = glowBlending(new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0.3,
        depthWrite: false,
      }));
      const curve = new THREE.CatmullRomCurve3(path, false, 'centripetal');
      const strandMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, 0.0045, 5, false), material);
      this.fieldLines.add(strandMesh);
      this.flowMaterials.push(material);
      this.flowBase.push(material.color.clone());
    }
    this.root.add(this.fieldLines);

    // --- fallback-комната (пол + сфера), видна только в DEBUG,
    //     используется как коллайдер только когда depth-меш недоступен ---
    // В AR с reference space local-floor плоскость y=0 совпадает с реальным
    // полом: это не «отсканированная комната», но и не выдумка.
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      glowBlending(new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.25, color: COLORS.accent }))
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.visible = false;
    this.roomMesh = new THREE.Mesh(
      new THREE.SphereGeometry(ROOM_R, 24, 16),
      glowBlending(new THREE.MeshBasicMaterial({ wireframe: true, side: THREE.BackSide, transparent: true, opacity: 0.16, color: COLORS.accent }))
    );
    // Шоквейв-кольца: единичный диск, uProgress 0→1, ориентация нормалью.
    this.rings = [];
    const rgeo = new THREE.CircleGeometry(1, 48);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(rgeo, ringShockMaterial({ color: COLORS.accent }));
      m.visible = false;
      this.root.add(m);
      this.rings.push({ mesh: m, t: 1e9 });
    }
    // Спрайт-вспышки удара: компактное цветное глоу, без белых звёзд на
    // весь экран (см. правило «никаких огромных белых вспышек» в AGENTS.md).
    this.glints = spritePool(glowTexture({ core: 0.24 }), { count: 10, dur: 1.05, grow: 2.2, color: 0x9fe8ff });
    this.bursts = spritePool(glowTexture({ core: 0.18 }), { count: 10, dur: 1.05, grow: 2.8, color: 0x54d6ff });
    this.root.add(this.glints.group, this.bursts.group);
    // Лучи-импульсы: две скрещенные плоскости (видны с любого угла,
    // в отличие от цилиндра с торца), uLife 0→1.
    this.beams = [];
    const pgeo = new THREE.PlaneGeometry(0.045, 1);
    pgeo.translate(0, 0.5, 0); // основание в точке эмиттера
    this._up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 4; i++) {
      // Отдельный material на импульс: перекрывающиеся выстрелы не делят uLife.
      const material = beamMaterial({ color: COLORS.accent });
      const group = new THREE.Group();
      const a = new THREE.Mesh(pgeo, material);
      const b = new THREE.Mesh(pgeo, material);
      b.rotation.y = Math.PI / 2;
      group.add(a, b);
      group.visible = false;
      this.root.add(group);
      this.beams.push({ mesh: group, material, t: 1e9 });
    }
    // Маркеры удара и прицела — только DEBUG: показывают, во что бьётся
    // импульс, когда комнату не сканировали (виртуальный пол/сфера).
    this.normalMark = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.18, 0xff6b5e);
    this.normalMark.visible = false;
    this.rayMark = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 1, 0x54d6ff);
    this.rayMark.visible = false;
    this.root.add(this.normalMark, this.rayMark);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 9;
    // Рабочие векторы. Эффекты живут в root, поэтому мир→root переводим
    // матрицей (_inv): якорь двигает root, и мировые координаты «плывут».
    this._o = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._h = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._e = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._nLocal = new THREE.Vector3();
    this._dLocal = new THREE.Vector3();
    this._k1 = new THREE.Vector3();
    this._k2 = new THREE.Vector3();
    this._b1 = new THREE.Vector3();
    this._b2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._inv = new THREE.Matrix4();
    this._zAxis = new THREE.Vector3(0, 0, 1); // нормаль диска CircleGeometry
    this._ray = new THREE.Ray(); // скретч для getRay: без аллокаций в кадре

    // --- события ---
    // gestureRecognition существует только при включённом hand-tracking.
    // На телефоне его нет: прежнее обращение к нему роняло init целиком
    // (чёрный экран вместо опыта).
    const g = xb.core?.gestureRecognition;
    this._gs = null;
    this._ge = null;
    if (typeof g?.addEventListener === 'function') {
      this._gs = (e) => this.onGesture(e.detail, true);
      this._ge = (e) => this.onGesture(e.detail, false);
      g.addEventListener('gesturestart', this._gs);
      g.addEventListener('gestureend', this._ge);
    }
    this._watchSession();
    this._watchSessionRequest();

    this.fpsTick = fpsMeter((fps) => { this.fps = fps; });
    window.__realityField = this; // для универсальных тестов (?test=1)
    this.stat();
  }

  /* ---------- глубина ---------- */

  /** Живые данные глубины этого кадра (не «обещание» подсистемы). */
  depthLive() {
    if (!this._depthWanted) return false;
    const d = xb.core?.depth;
    return !!(d?.options?.enabled && d.depthArray?.[0]?.length);
  }

  /** Меш глубины как цель для луча — только когда в нём есть данные. */
  get depthMesh() {
    if (!this.depthLive()) return null;
    try { return xb.core?.depth?.depthMesh ?? null; } catch { return null; }
  }

  /**
   * Гасит подсистему глубины. Нужно, когда сессия не выдала depth-sensing:
   * тогда кадровый вызов SDK (frame.getDepthInformation) бросает исключение
   * до отрисовки, и в AR это выглядит как чёрный экран.
   */
  _dropDepth(reason) {
    this._depthWanted = false;
    try {
      const d = xb.core?.depth;
      if (d?.options) d.options.enabled = false; // depth.update() выходит сразу
      if (d) d.enabled = false;
    } catch { /* noop */ }
    this.note(`depth отключён: ${reason}`);
  }

  /* ---------- сессия ---------- */

  _watchSession() {
    const xr = xb.core?.renderer?.xr;
    if (typeof xr?.addEventListener !== 'function') return;
    this._onSessionStart = (event) => this._sessionStarted(event?.session ?? xr.getSession?.() ?? null);
    this._onSessionEnd = () => { this._session = null; this.stat(); };
    xr.addEventListener('sessionstart', this._onSessionStart);
    xr.addEventListener('sessionend', this._onSessionEnd);
  }

  _sessionStarted(session) {
    this._session = session || null;
    hideFatal();
    // Повторный вход может выдать depth там, где его не было: восстанавливаем
    // желание и глушим только если фичи снова нет. has() вместо === false —
    // depth'а не было и в запросе, глушить нечего.
    if (sessionFeature(session, 'depth-sensing')) {
      this._depthWanted = true;
      try {
        const d = xb.core?.depth;
        if (d?.options) d.options.enabled = true;
        if (d) d.enabled = true;
      } catch { /* noop */ }
    } else if (this._depthWanted && sessionFeature(session, 'depth-sensing') === false) {
      this._dropDepth('сессия без depth-sensing');
    }
    this.stat();
  }

  /**
   * XR Blocks сообщает о провале requestSession только в консоль: снаружи это
   * выглядит как «нажал и ничего» либо как чёрный экран. Показываем причину.
   */
  _watchSessionRequest() {
    const xr = navigator.xr;
    if (!xr || typeof xr.requestSession !== 'function' || xr.requestSession.__rfWrapped) return;
    const original = xr.requestSession.bind(xr);
    const wrapped = (mode, init) => original(mode, init).catch((err) => {
      const name = (err && err.name) || 'Error';
      const hint = /NotSupported|InvalidState/.test(name)
        ? ' — устройство не поддержало запрошенные возможности сессии'
        : '';
      this.reportError(`вход в XR не удался: ${name}${hint}`);
      throw err;
    });
    wrapped.__rfWrapped = true;
    try { xr.requestSession = wrapped; } catch { /* платформа не разрешила */ }
  }

  /* ---------- начальная композиция ---------- */

  /**
   * Ставит поле перед камерой. Без depth-поверхностей поле, построенное
   * вокруг начала координат, на телефоне оказывается вокруг камеры — в кадре
   * пусто. Ось Y оставляем по полу: низ поля (0.12 м) стоит на полу комнаты,
   * а центр спирали поднимаем на уровень глаз.
   */
  compose(camPos, camDir) {
    if (!Number.isFinite(camPos.x) || !Number.isFinite(camPos.z)) return false;
    const fwd = this._p.copy(camDir);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const y = Math.max(0.02, Math.min(camPos.y - FIELD_MID_Y, 0.6));
    // root лежит прямо в сцене (скрипт не трансформирован), поэтому его
    // позиция — мировая.
    this.root.position.set(camPos.x + fwd.x * DOCK_DIST, y, camPos.z + fwd.z * DOCK_DIST);
    this.root.updateMatrixWorld(true);
    this._inv.copy(this.root.matrixWorld).invert();
    this._composed = true;
    return true;
  }

  /* ---------- режимы и статус ---------- */

  setDebug(on) {
    this.debug = !!on;
    this.hud.setToggle('debug', this.debug);
    this.spatial?.setToggle('debug', this.debug);
    if (this.floor) this.floor.visible = this.debug;
    if (this.roomMesh) this.roomMesh.visible = this.debug;
    if (this.rayMark) this.rayMark.visible = this.debug;
    if (this.normalMark) this.normalMark.visible = this.debug && !!this.normalMark.userData.hasHit;
    this.stat();
  }

  /**
   * DREAM — не «крупнее частицы», а другое состояние поля: время идёт 0.45×,
   * силовые линии и частицы уходят в фиолет, свечение мягче, поле медленнее
   * возвращается в исходную форму. Видно и на телефоне, и в шлеме.
   */
  setDream(on) {
    this.dream = !!on;
    this.hud.setToggle('dream', this.dream);
    this.spatial?.setToggle('dream', this.dream);
    this._timeScale = this.dream ? DREAM_SCALE : 1;
    if (this.pmat) {
      this.pmat.uniforms.uSize.value = this.dream ? 0.062 : 0.04;
      this.pmat.uniforms.uOpacity.value = this.dream ? 0.55 : 0.9;
      this.pmat.uniforms.uTwinkle.value = this.dream ? 1.5 : 0.9;
      this.pmat.uniforms.uTint.value.set(this.dream ? COLORS.violet : COLORS.accent);
    }
    if (this.flowMaterials) {
      const violet = new THREE.Color(COLORS.violet);
      for (let i = 0; i < this.flowMaterials.length; i++) {
        this.flowMaterials[i].color.copy(this.flowBase[i]);
        if (this.dream) this.flowMaterials[i].color.lerp(violet, 0.7);
      }
    }
    this.stat();
  }

  stat() {
    const depthState = !this._depthWanted
      ? 'depth НЕТ · виртуальная поверхность'
      : this.depthLive() ? 'depth LIVE' : 'depth ждёт данных';
    const chargePct = Math.round(Math.min(this.charge, 2.5) / 2.5 * 100);
    const field = [...this.fx].join('+');
    const mode = this.dream ? 'DREAM' : this.debug ? 'DEBUG' : (field || 'PULSE');
    const err = this._err ? ` / ОШИБКА: ${this._err}` : '';
    const s = `CHARGE ${chargePct}% / ${this.fps || 0} FPS / ${depthState} / ${mode}${err}`;
    this.hud.setStatus(s);
    // В шлеме DOM не виден: фатальная ошибка обязана быть и на панели.
    this.spatial?.setStatus(`CHARGE ${chargePct}% / ${this.fps || 0} FPS\n${depthState}` +
      (mode === 'PULSE' ? '' : `\nMODE ${mode}`) +
      (this._notes.length ? `\n${this._notes.at(-1)}` : '') +
      (this._err ? `\nОШИБКА: ${this._err}` : ''));
    // Канал состояния для универсальных тестов (?test=1) и отладки:
    // DOM общий для всех миров, в отличие от window.
    document.documentElement.dataset.rfState = JSON.stringify({
      fps: this.fps, charge: chargePct, depth: depthState, mode,
      depthLive: this.depthLive(), depthWanted: this._depthWanted,
      composed: this._composed, err: this._err,
      platform: caps, notes: this._notes,
      fired: this.fired, anchor: this.anchor?.capability,
      kids: this.children?.length ?? -1,
      pts: this.points?.visible ?? null,
      ptsMat: this.pmat?.type ?? null,
      card: this.spatial?.card?.visible ?? null,
      cardParent: !!this.spatial?.card?.parent,
      bloom: false, selN: this._selN || 0, selEnd: this._selEnd || 0, selUI: !!this._selUI,
    });
  }

  /** Не-фатальная заметка: попадёт в статус и консоль. */
  note(msg) {
    this._notes.push(msg);
    if (this._notes.length > 3) this._notes.shift();
    console.warn('[RF]', msg);
    this.stat();
  }

  /** Фатальная/пользовательская ошибка: видно и в статусе, и в баннере. */
  reportError(msg) {
    this._err = msg;
    console.error('[RF]', msg);
    document.documentElement.dataset.rfErr = msg;
    try { this.hud.setStatus(`ОШИБКА: ${msg}`); } catch { /* нет HUD */ }
    showFatal(msg);
    this.stat();
  }

  /* ---------- ввод ---------- */

  onGesture(detail, start) {
    const n = detail?.name;
    if (n === 'pinch') {
      if (start) { this.pinchHeld = true; this.charge = Math.max(this.charge, 0.2); }
      else { this.pinchHeld = false; this.fire(1 + this.charge); this.charge = 0; }
    } else if (n === 'open-palm') {
      start ? this.fx.add('repel') : this.fx.delete('repel');
    } else if (n === 'fist') {
      start ? this.fx.add('attract') : this.fx.delete('attract');
    } else if (n === 'spread') {
      start ? this.fx.add('stretch') : this.fx.delete('stretch');
    }
  }

  /** Тап по UI (кнопки панели в шлеме) не должен стрелять по сцене. */
  isUiTarget(event) {
    const target = event?.target;
    if (!target) return false;
    if (target.isUI) return true;
    for (let o = target; o; o = o.parent) if (o === this.spatial?.card) return true;
    return false;
  }

  onSelectStart(event) {
    this._selN = (this._selN || 0) + 1;
    this._selUI = this.isUiTarget(event);
    if (this._selUI) return;
    this.touchHeld = true;
    this.charge = Math.max(this.charge, 0.2);
  }

  onSelectEnd(event) {
    this._selEnd = (this._selEnd || 0) + 1;
    if (this.isUiTarget(event)) { this.touchHeld = false; return; }
    this.touchHeld = false;
    if (this.pinchHeld) return; // отпустит gestureend, не дублируем
    this.fire(1 + this.charge);
    this.charge = 0;
  }

  emitter() {
    this._fromController = false;
    try {
      xb.user.getControllerPosition(0, this._o);
      const r = xb.user.getRay(0, this._ray);
      if (r && r.direction.lengthSq() > 0.5) {
        this._d.copy(r.direction).normalize();
        this._fromController = true;
        return true;
      }
    } catch { /* fallback ниже */ }
    xb.core.camera.getWorldPosition(this._o);
    xb.core.camera.getWorldDirection(this._d).normalize();
    return true;
  }

  /** Визуальное «дуло»: чуть вправо-вниз от камеры, иначе луч из глаза
   *  вырождается на экране в точку (камера смотрит вдоль него). */
  muzzleOrigin(o, d) {
    if (this._fromController) return o.clone();
    // Скретч-векторы вместо аллокаций в горячем цикле.
    const right = this._k1.crossVectors(d, this._up).normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    return o.clone().addScaledVector(right, 0.14).add(this._k2.set(0, -0.1, 0));
  }

  /* ---------- мир ↔ локальные координаты root ---------- */

  _toLocal(v, out) {
    return out.copy(v).applyMatrix4(this._inv);
  }

  _dirToLocal(v, out) {
    this.root.getWorldQuaternion(this._q);
    return out.copy(v).applyQuaternion(this._q.invert()).normalize();
  }

  /** Цели луча: реальный depth-меш, иначе виртуальный пол и сфера-каркас. */
  _targets() {
    const dm = this.depthMesh;
    return dm ? [dm] : [this.floor, this.roomMesh];
  }

  /* ---------- импульс ---------- */

  fire(power = 1) {
    const now = performance.now() / 1000;
    if (now - this.lastFire < FIRE_DEDUPE) return;
    this.lastFire = now;
    this.fired++;

    this.emitter();
    // Эффекты — дети root, а точки попадания приходят в мировых координатах:
    // обновляем матрицы и переводим всё в локальные.
    this.root.updateMatrixWorld(true);
    this._inv.copy(this.root.matrixWorld).invert();

    const o = this._o.clone();
    const d = this._d.clone().normalize();
    const targets = this._targets();
    this.raycaster.set(o, d);
    const hit = this.raycaster.intersectObjects(targets, false)[0] ?? null;
    const missPoint = o.clone().addScaledVector(d, 3.2);
    const kickOrigin = o.clone().addScaledVector(d, 0.4);

    const point = hit ? hit.point : missPoint;
    if (hit?.face?.normal) this._n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    else this._n.copy(d).negate();

    const localPoint = this._toLocal(point, this._h);
    const localNormal = this._dirToLocal(this._n, this._nLocal);
    this.spawnRing(localPoint, localNormal);
    this.spawnFlash(localPoint);
    this.waves.push({ x: localPoint.x, y: localPoint.y, z: localPoint.z, r: 0.05, speed: this.dream ? 1.1 : 1.6 });
    if (this.waves.length > 6) this.waves.shift();
    if (hit && this.debug) {
      this.normalMark.position.copy(localPoint);
      this.normalMark.setDirection(localNormal);
      this.normalMark.userData.hasHit = true;
      this.normalMark.visible = true;
    }
    this.spawnBeam(this.muzzleOrigin(o, d), point);
    this.kick(kickOrigin, d, power, hit ? hit.point : null);
    this.stat();
  }

  kick(origin, dir, power, stopAt) {
    const p = this.pgeo.attributes.position.array;
    const o = this._toLocal(origin, this._k1);
    const d = this._dirToLocal(dir, this._dLocal);
    const maxD = stopAt ? o.distanceTo(this._toLocal(stopAt, this._k2)) : 4;
    for (let i = 0; i < COUNT; i++) {
      const ix = i * 3;
      const px = p[ix] - o.x;
      const py = p[ix + 1] - o.y;
      const pz = p[ix + 2] - o.z;
      const along = px * d.x + py * d.y + pz * d.z;
      if (along < 0 || along > maxD) continue;
      const rx = px - d.x * along, ry = py - d.y * along, rz = pz - d.z * along;
      const rad2 = rx * rx + ry * ry + rz * rz;
      if (rad2 > 0.09) continue;
      const f = power * 2.2 * (1 - Math.sqrt(rad2) / 0.3) * (1 - along / (maxD + 0.5));
      this.vel[ix] += d.x * f; this.vel[ix + 1] += d.y * f + 0.4 * f; this.vel[ix + 2] += d.z * f;
    }
  }

  spawnRing(point, normal) {
    const ring = this.rings.find((r) => r.t >= RING_DUR) || this.rings[0];
    ring.t = 0;
    ring.mesh.visible = true;
    ring.mesh.position.copy(point).addScaledVector(normal, 0.006); // чуть над поверхностью
    // lookAt здесь нельзя: point/normal — локальные координаты root, а lookAt
    // работает в мировых (смещение root на 2.4 м разворачивало кольцо ребром).
    ring.mesh.quaternion.setFromUnitVectors(this._zAxis, normal);
    ring.mesh.scale.setScalar(0.12);
  }

  spawnFlash(point) {
    this.glints.spawn(point, 0.24);
    this.bursts.spawn(point, 0.3);
  }

  spawnBeam(from, to) {
    const beam = this.beams.find((b) => b.t >= BEAM_DUR) || this.beams[0];
    if (!beam) return;
    beam.t = 0;
    beam.material.uniforms.uLife.value = 0;
    beam.mesh.visible = true;
    const a = this._toLocal(from, this._b1);
    const b = this._toLocal(to, this._b2);
    beam.mesh.position.copy(a);
    const dir = this._v.copy(b).sub(a);
    const len = dir.length() || 0.01;
    beam.mesh.quaternion.setFromUnitVectors(this._up, dir.normalize());
    beam.mesh.scale.set(1, len, 1);
  }

  /** DEBUG: показывает, куда уйдёт импульс (в том числе по виртуальному полу). */
  _updateRayMark() {
    this.raycaster.set(this._o, this._d);
    const hit = this.raycaster.intersectObjects(this._targets(), false)[0];
    const end = hit ? hit.point : this._o.clone().addScaledVector(this._d, 3.2);
    const from = this._toLocal(this._o, this._k1);
    const to = this._toLocal(end, this._k2);
    const dir = this._v.copy(to).sub(from);
    const len = dir.length() || 0.01;
    this.rayMark.position.copy(from);
    this.rayMark.setDirection(dir.normalize());
    this.rayMark.setLength(len, Math.min(0.1, len * 0.2), 0.03);
  }

  update() {
    const raw = Math.min(xb.getDeltaTime(), 0.05);
    this.fpsTick(raw);
    const dt = raw * this._timeScale; // DREAM замедляет поле, но не FPS-метр

    // Командный канал для ?test=1 / внешних harness'ов: DOM общий для всех
    // миров изолированных контекстов. Пример: dataset.rfCmd='fire'.
    const cmd = document.documentElement.dataset.rfCmd;
    if (cmd) {
      delete document.documentElement.dataset.rfCmd;
      try {
        if (cmd === 'fire') { this.emitter(); this.fire(1.4); }
        else if (cmd === 'debug') this.setDebug(!this.debug);
        else if (cmd === 'dream') this.setDream(!this.dream);
        else if (cmd === 'probe') {
          const b = this.beams[0];
          const wp = new THREE.Vector3();
          b.mesh.getWorldPosition(wp);
          document.documentElement.dataset.rfFx = JSON.stringify({
            beamVis: b.mesh.visible,
            beamPos: wp.toArray(),
            beamScale: b.mesh.scale.toArray(),
            beamLife: b.material.uniforms.uLife.value,
            glintVis: this.glints.group.children.map((c) => c.visible),
            drawCalls: xb.core.renderer.info.render.calls,
            triangles: xb.core.renderer.info.render.triangles,
          });
        }
        delete document.documentElement.dataset.rfCmdErr;
      } catch (e) {
        document.documentElement.dataset.rfCmdErr = (e && e.message) || String(e);
      }
    }

    this.emitter();
    // Начальная композиция — один раз, по первой реальной позе камеры:
    // и в 2D-превью на телефоне, и в AR поле уже стоит в кадре.
    if (!this._composed) this.compose(this._o, this._d);

    // Якорь: создаём только после композиции, иначе follow() утащит поле
    // к старой точке, и кадр снова опустеет.
    if (this._composed && !this.anchor.active && !this.anchor._pending &&
        this.anchor.capability !== 'unsupported' && this._anchorTries < 3) {
      this._anchorTries++;
      const pending = this.anchor.create(this.root);
      if (pending?.catch) pending.catch((e) => this.note(`anchor: ${(e && e.message) || e}`));
    }
    this.anchor.follow(this.root);

    if (this.pinchHeld || this.touchHeld) this.charge = Math.min(2.5, this.charge + raw * 1.5);

    // матрицы root — для перевода мира в локальные координаты эффектов
    this.root.updateMatrixWorld(true);
    this._inv.copy(this.root.matrixWorld).invert();
    const e = this._toLocal(this._o, this._e);
    const lx = e.x, ly = e.y, lz = e.z;

    const p = this.pgeo.attributes.position.array;
    const colA = this.pgeo.attributes.aColor.array;
    const dreamK = this.dream ? 0.4 : 1.0;

    for (const w of this.waves) w.r += w.speed * dt;
    this.waves = this.waves.filter((w) => w.r < 4);

    const repel = this.fx.has('repel') ? 1 : 0;
    const attract = this.fx.has('attract') ? 1 : 0;
    const stretch = this.fx.has('stretch') ? 1 : 0;

    for (let i = 0; i < COUNT; i++) {
      const ix = i * 3;
      let x = p[ix], y = p[ix + 1], z = p[ix + 2];
      let vx = this.vel[ix], vy = this.vel[ix + 1], vz = this.vel[ix + 2];

      vx += (this.home[ix] - x) * 0.6 * dt * dreamK;
      vy += (this.home[ix + 1] - y) * 0.6 * dt * dreamK;
      vz += (this.home[ix + 2] - z) * 0.6 * dt * dreamK;
      vx *= 1 - 1.6 * dt; vy *= 1 - 1.6 * dt; vz *= 1 - 1.6 * dt;

      for (const w of this.waves) {
        const dx = x - w.x, dy = y - w.y, dz = z - w.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-4;
        const band = Math.abs(dist - w.r);
        if (band < 0.18) {
          const f = (1 - band / 0.18) * 3.2 * dt;
          vx += (dx / dist) * f; vy += (dy / dist) * f; vz += (dz / dist) * f;
        }
      }

      if (repel || attract) {
        const dx = x - lx, dy = y - ly, dz = z - lz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 2.25 && d2 > 1e-6) {
          const dist = Math.sqrt(d2);
          const f = (repel - attract) * 2.4 * dt / (dist + 0.2);
          vx += (dx / dist) * f * 2; vy += (dy / dist) * f * 2; vz += (dz / dist) * f * 2;
        }
      }
      if (stretch) { vx += (x - ROOM_C.x) * 0.8 * dt; vz += (z - ROOM_C.z) * 0.8 * dt; }

      x += vx * dt * 8; y += vy * dt * 8; z += vz * dt * 8;

      if (y < 0.02) { y = 0.02; vy = Math.abs(vy) * 0.4; }
      const bx = x - ROOM_C.x, by = y - ROOM_C.y, bz = z - ROOM_C.z;
      const bl = Math.sqrt(bx * bx + by * by + bz * bz);
      if (bl > ROOM_R) {
        const s = ROOM_R / bl;
        x = ROOM_C.x + bx * s; y = ROOM_C.y + by * s; z = ROOM_C.z + bz * s;
        vx *= -0.3; vy *= -0.3; vz *= -0.3;
      }

      p[ix] = x; p[ix + 1] = y; p[ix + 2] = z;
      this.vel[ix] = vx; this.vel[ix + 1] = vy; this.vel[ix + 2] = vz;

      let glow = 0;
      for (const w of this.waves) {
        const dx = x - w.x, dy = y - w.y, dz = z - w.z;
        if (Math.abs(Math.sqrt(dx * dx + dy * dy + dz * dz) - w.r) < 0.12) { glow = 1; break; }
      }
      colA[ix] = this.homeCol[ix] + glow * 0.6;
      colA[ix + 1] = this.homeCol[ix + 1] + glow * 0.6;
      colA[ix + 2] = this.homeCol[ix + 2] + glow * 0.6;
    }
    this.pgeo.attributes.position.needsUpdate = true;
    this.pgeo.attributes.aColor.needsUpdate = true;

    const t = xb.getElapsedTime?.() ?? performance.now() / 1000;
    tickMaterials(t, [this.pmat, ...this.rings.map((r) => r.mesh.material), ...this.beams.map((b) => b.material)]);
    for (let i = 0; i < this.flowMaterials.length; i++) {
      this.flowMaterials[i].opacity = 0.22 + 0.14 * (0.5 + 0.5 * Math.sin(t * 0.7 + i * 0.46));
    }
    this.glints.update(dt);
    this.bursts.update(dt);
    for (const r of this.rings) {
      if (r.t >= RING_DUR) { r.mesh.visible = false; continue; }
      r.t += dt;
      const k = Math.min(r.t / RING_DUR, 1);
      r.mesh.material.uniforms.uProgress.value = k;
      // Компактное кольцо референса: радиус 0.06 → 0.38 (диаметр ≤ 0.76 м).
      r.mesh.scale.setScalar(0.06 + k * RING_MAX);
    }
    for (const b of this.beams) {
      if (b.t >= BEAM_DUR) { b.mesh.visible = false; continue; }
      b.t += dt;
      b.material.uniforms.uLife.value = Math.min(b.t / BEAM_DUR, 1);
    }
    if (this.debug) this._updateRayMark();

    this._statT = (this._statT || 0) + raw;
    if (this._statT >= 0.5) { this._statT = 0; this.stat(); }
  }

  dispose() {
    const g = xb.core?.gestureRecognition;
    if (typeof g?.removeEventListener === 'function' && this._gs) {
      g.removeEventListener('gesturestart', this._gs);
      g.removeEventListener('gestureend', this._ge);
    }
    const xr = xb.core?.renderer?.xr;
    if (typeof xr?.removeEventListener === 'function') {
      xr.removeEventListener('sessionstart', this._onSessionStart);
      xr.removeEventListener('sessionend', this._onSessionEnd);
    }
    this.anchor?.dispose();
    this.glints?.dispose();
    this.bursts?.dispose();
    this.pgeo?.dispose();
    this.pmat?.dispose();
    for (const line of this.fieldLines?.children ?? []) {
      line.geometry.dispose();
      line.material.dispose();
    }
    delete window.__realityField;
  }
}

// depth-sensing и hand-tracking просим только на устройствах, которые их дают
// (см. detectCapabilities): невыданная required-фича роняет запрос сессии.
const options = baseOptions({
  title: 'REALITY//FIELD',
  description: 'Комната как физическое поле. Тап — импульс, удержание — заряд, жесты — поле.',
  depth: caps.depth,
  bloom: false,   // в прозрачном AR пост-обработка выжигает passthrough
});
options.controllers.visualizeRays = false;
if (caps.hands) {
  options.enableHands();
  options.enableGestures();
  options.gestures.setGestureEnabled('spread', true);
}

async function boot() {
  const script = new RealityField();
  try {
    xb.add(script);
    await xb.init(options);
    watchSession();
  } catch (e) {
    const msg = describeError(e);
    console.error('[RF] BOOT FAIL', e);
    document.documentElement.dataset.rfInitErr = msg;
    showFatal(`REALITY//FIELD не запустился: ${msg}`);
    // Инициализация могла упасть уже после сборки сцены (например, не
    // догрузился ассет симулятора XR Blocks). Кадровый цикл тогда не
    // запущен, и пользователь видит пустой чёрный экран — поднимаем его
    // сами, чтобы поле всё равно было видно (ошибка остаётся на экране).
    try {
      const core = xb.core;
      if (script.root && typeof core?.update === 'function' && core.renderer?.setAnimationLoop) {
        let broken = false;
        core.renderer.setAnimationLoop((time, frame) => {
          if (broken) return;
          try { core.update(time, frame); }
          catch (err) {
            broken = true;
            core.renderer.setAnimationLoop(null);
            script.reportError(`кадровый цикл не поднялся: ${describeError(err)}`);
          }
        });
        script.note('кадровый цикл поднят вручную после сбоя инициализации');
      }
    } catch { /* останется хотя бы баннер с причиной */ }
  }
}

// Модуль ждёт результат проверки возможностей, поэтому к моменту входа сюда
// DOMContentLoaded уже мог отработать — тогда запускаемся сразу.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
