// XR TESTBED — общий app shell для всех опытов.
//
// Решает три проблемы, найденные в аудите:
//  1. XR Blocks не запрашивает dom-overlay → после Enter XR DOM-HUD исчезает.
//     Поэтому каждый опыт получает ПРОСТРАНСТВЕННУЮ UICard (xb.UICard),
//     доступную и в шлеме, и на телефоне, и в симуляторе.
//  2. Контент без якорей дрейфует, когда платформа уточняет карту комнаты.
//     baseOptions() включает world anchors (+ simulatorFallback) и даёт
//     anchorRoot(), чтобы привязать контент к реальному месту.
//  3. Универсальные тесты: открой опыт с ?test=1 — включится
//     enableAutomationMode(): автостарт десктоп-симулятора со скрытым UI
//     (стандартный setup для внешних test harness'ов из документации XR Blocks).

import * as THREE from 'three';
import * as xb from 'xrblocks';

export const COLORS = {
  accent: 0x54d6ff,
  violet: 0x8a7bff,
  coral: 0xff6b5e,
  panel: '#12141f',
  panelLight: '#1c2030',
};

/** true, если опыт открыт в тестовом режиме (?test / ?test=1). */
export function isTestMode() {
  return new URLSearchParams(location.search).has('test');
}

/**
 * Базовые Options для опыта: якоря, ретиклы по depth-мешу, симулятор.
 * @param {{title: string, description: string, depth?: boolean}} cfg
 */
/**
 * Телефонный guard (канон соседнего проекта xrblocks/common/boot.js:
 * installXrGuards). XR Blocks помечает depth-sensing / local-floor /
 * hand-tracking как requiredFeatures, когда опыт их включил. Телефонный
 * Chrome такие сессии отклоняет целиком, а кнопка ENTER XR молча ничего
 * не делает. Перехватываем requestSession: при отказе из-за тяжёлых фич
 * повторяем запрос без них — опытам остаются fallback-геометрия и тапы.
 * Вызывать один раз до xb.init() — baseOptions() делает это сам.
 * Отброшенные фичи видны в installXrGuards.dropped.
 */
export function installXrGuards() {
  const xr = navigator.xr;
  if (!xr || xr.__downgradeGuard) return installXrGuards;
  xr.__downgradeGuard = true;
  const orig = xr.requestSession.bind(xr);
  xr.requestSession = (mode, init) =>
    orig(mode, init).catch((err) => {
      const required = (init && init.requiredFeatures) || [];
      const heavy = required.filter(
        (f) => f === 'depth-sensing' || f === 'hand-tracking' || f === 'local-floor'
      );
      // Причина отказа не в тяжёлых фичах — пробрасываем как есть.
      if (!heavy.length) throw err;
      installXrGuards.dropped.push(...heavy);
      init.requiredFeatures = required.filter((f) => !heavy.includes(f));
      return orig(mode, init);
    });
  return installXrGuards;
}
installXrGuards.dropped = [];

export function baseOptions({ title, description, depth = false, bloom = false }) {
  installXrGuards();
  const options = new xb.Options();
  if (depth) options.enableDepth();
  if (bloom) options.usePostprocessing = true; // стерео-совместимый XREffects
  options.enableReticles();
  // Флаг читается только при включённом depth (Core ставит его на depthMesh).
  if (depth) options.reticles.projectOnDepthMesh = true;
  options.reticles.defaultRenderDistance = 0; // промах → ретикл скрыт, не парит
  // Телефон: тап прямой, ретикл не нужен — плавающий белый круг здесь
  // только мешает попаданию. Десктоп/симулятор ретикл сохраняет.
  if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
    options.reticles.enabled = false;
  }
  // Контент привязывается к реальным поверхностям и не «улетает».
  options.world.enableAnchors();
  options.world.anchors.simulatorFallback = true;
  options.xrButton.showEnterSimulatorButton = true;
  options.setAppTitle(title);
  options.setAppDescription(description);
  if (isTestMode()) {
    document.body.classList.add('automation');
    // USER-mode убирает огромные simulator-hand meshes/ретиклы из эталонных
    // кадров; команды dataset остаются доступным универсальным вводом.
    options.reticles.enabled = false;
    options.enableAutomationMode({
      defaultMode: xb.SimulatorMode.USER,
      enableHands: false,
      enableCamera: true,
    });
  }
  return options;
}

/**
 * DOM-HUD вне XR-сессии: верхний чип (title + статус), нижний sheet (кнопки).
 * @param {{title: string, controls?: Array<{id: string, label: string, toggle?: boolean, onClick: ()=>void}>, hint?: string, backHref?: string}} cfg
 * @returns {{setStatus(s:string):void, setToggle(id:string,on:boolean):void, el: HTMLElement}}
 */
export function createHud({ title, controls = [], hint = '', backHref = '../' }) {
  const top = document.createElement('div');
  top.id = 'hud-top';
  const h2 = document.createElement('h2');
  h2.textContent = title;
  const stat = document.createElement('span');
  stat.className = 'stat';
  stat.textContent = 'loading…';
  top.append(h2, stat);

  const bottom = document.createElement('div');
  bottom.id = 'hud-controls';
  const row = document.createElement('div');
  row.className = 'row';
  const buttons = new Map();
  for (const c of controls) {
    const b = document.createElement('button');
    b.id = `hud-btn-${c.id}`;
    b.type = 'button';
    b.textContent = c.label;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', c.onClick);
    row.appendChild(b);
    buttons.set(c.id, b);
  }
  bottom.appendChild(row);
  const back = document.createElement('a');
  back.className = 'back';
  back.href = backHref;
  back.textContent = '← все опыты';
  bottom.appendChild(back);
  if (hint) {
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = hint;
    bottom.appendChild(h);
  }

  const frag = document.createDocumentFragment();
  frag.append(top, bottom);
  document.body.appendChild(frag);

  return {
    el: top,
    setStatus(s) { stat.textContent = s; },
    setLabel(id, text) {
      const b = buttons.get(id);
      if (!b) return;
      b.textContent = text;
    },
     setToggle(id, on) {
       const b = buttons.get(id);
       if (!b) return;
       b.classList.toggle('on', on);
       b.setAttribute('aria-pressed', String(on));
     },
   };
 }
 
/** Панели, для которых watchSession переключает world-карту и screen-overlay. */
const PHONE_PANELS = new Set();

/** true, если активная XR-сессия управляется с экрана телефона. */
function isPhoneSession() {
  const session = xb.core?.renderer?.xr?.getSession?.();
  if (!session) return false;
  // MDN: на телефоне в immersive-ar interactionMode === 'screen-space'.
  // targetRayMode === 'screen' — второй официальный признак.
  if (session.interactionMode === 'screen-space') return true;
  try {
    for (const src of session.inputSources) {
      if (src.targetRayMode === 'screen') return true;
    }
  } catch { /* inputSources может быть недоступен */ }
  return false;
}

/** Вешает/снимает класс in-xr на body и переключает панели по типу сессии. */
 export function watchSession() {
   const xr = xb.core?.renderer?.xr;
   if (!xr) return;
  xr.addEventListener('sessionstart', () => {
    document.body.classList.add('in-xr');
    // Телефон в immersive-ar: world-панель вращается вместе с миром при
    // движении телефона, и по её кнопкам невозможно попасть. Вместо неё
    // показываем экранную UIOverlay того же опыта (см. spatialControls).
    const phone = isPhoneSession();
    document.body.classList.toggle('phone-xr', phone);
    for (const p of PHONE_PANELS) {
      p.overlay.visible = phone;
      p.card.visible = !phone;
    }
  });
  xr.addEventListener('sessionend', () => {
    document.body.classList.remove('in-xr', 'phone-xr');
    for (const p of PHONE_PANELS) {
      p.overlay.visible = false;
      p.card.visible = true;
    }
  });
 }


/**
 * Пространственная панель управления для XR-сессии. Строится в двух видах
 * с одинаковым содержимым и API:
 *  - card (xb.UICard): world-панель для шлема и десктопа; ставится перед
 *    пользователем, опыт может двигать её через card.position.
 *  - overlay (xb.UIOverlay): экранная панель для телефона в immersive-ar.
 *    XR Blocks не запрашивает dom-overlay, а world-панель на телефоне
 *    вращается вместе с миром при движении устройства — по кнопкам нельзя
 *    попасть. UIOverlay привязана к камере и стоит на месте.
 * Переключение делает watchSession() по признаку screen-сессии.
 * @param {{title: string, status?: string, controls: Array<{id: string, label: string, icon?: string, toggle?: boolean, onClick: ()=>void}>, width?: number}} cfg
 * @returns {{card: xb.UICard, overlay: xb.UIOverlay, setStatus(s:string):void, setToggle(id:string,on:boolean):void, setLabel(id:string,text:string):void}}
 */
export function spatialControls({ title, status = '…', controls, width = 0.72 }) {
  const make = () => {
    const statusText = new xb.UIText({
      text: status,
      style: {
        fontSize: 26, lineHeight: 1.3, color: '#8ea0c2',
        textAlign: 'center', flexGrow: 1, whiteSpace: 'pre-line',
      },
    });
    const buttons = new Map();
    const row = new xb.UIPanel({
      style: { width: '100%', flexDirection: 'row', gap: 14 },
      children: controls.map((c) => {
        const btn = new xb.UIButton({
          label: c.label,
          icon: c.icon,
          onClick: c.onClick,
          style: {
            flexGrow: 1, fontSize: 24, padding: 18,
            backgroundColor: COLORS.panelLight,
          },
        });
        buttons.set(c.id, btn);
        return btn;
      }),
    });
    return { statusText, buttons, row };
  };

  const world = make();
  const card = new xb.UICard({
    size: { width, height: 'auto' },
    manipulation: true,
    edge: { translateFromSurface: true },
    style: {
      flexDirection: 'column', gap: 22, padding: 30,
      backgroundColor: COLORS.panel,
    },
    children: [
      new xb.UIText({
        text: title,
        style: {
          fontSize: 40, fontWeight: 'bold',
          color: '#54d6ff', textAlign: 'center',
        },
      }),
      world.statusText,
      world.row,
    ],
  });
  card.position.set(0, xb.user.height, -xb.user.panelDistance);

  const screen = make();
  const overlay = new xb.UIOverlay({
    // Компоновка — как в официальном spatial_ui_lab: абсолютное позиционирование
    // в приватном full-viewport контейнере, world-трансформы игнорируются SDK.
    style: {
      width: '94%',
      maxWidth: 640,
      position: 'absolute',
      left: '50%',
      bottom: 48,
      transform: { translateX: '-50%' },
    },
    children: [
      new xb.UIPanel({
        style: {
          flexDirection: 'column', gap: 16, padding: 26,
          backgroundColor: COLORS.panel,
        },
        children: [
          new xb.UIText({
            text: title,
            style: {
              fontSize: 34, fontWeight: 'bold',
              color: '#54d6ff', textAlign: 'center',
            },
          }),
          screen.statusText,
          screen.row,
        ],
      }),
    ],
  });
  overlay.visible = false;
  xb.scene.add(overlay);
  PHONE_PANELS.add({ card, overlay });

  const both = (fn) => { fn(world); fn(screen); };
  return {
    card,
    overlay,
    setStatus(s) { both((p) => { p.statusText.text = s; }); },
    setToggle(id, on) {
      both((p) => {
        const b = p.buttons.get(id);
        if (b) b.style.backgroundColor = on ? '#1d3a52' : COLORS.panelLight;
      });
    },
    setLabel(id, text) {
      both((p) => {
        const b = p.buttons.get(id);
        if (b) b.label = text;
      });
    },
  };
}

/**
 * Привязывает Object3D к якорю: создаёт якорь в текущей мировой позиции
 * объекта и в update() синхронизирует позицию с уточняющимся трекингом.
 * Вызывать createAnchor() один раз (асинхронно), затем follow() каждый кадр.
 */
export function anchorRoot() {
  const anchors = () => xb.core?.world?.anchors;
  const scratch = new THREE.Vector3();
  return {
    get capability() { return anchors()?.capability ?? 'unsupported'; },
    /** @returns {boolean} true, когда якорь создан и следует за трекингом */
    get active() { return !!this._id; },
    async create(object, label = 'app-root') {
      const mgr = anchors();
      if (!mgr || this._id || this._pending) return;
      this._pending = true;
      try {
        object.getWorldPosition(scratch);
        const pose = new XRRigidTransform(
          { x: scratch.x, y: scratch.y, z: scratch.z },
          { x: 0, y: 0, z: 0, w: 1 }
        );
        const tracked = await mgr.create(pose, label);
        if (tracked) this._id = tracked.id;
      } finally {
        this._pending = false;
      }
    },
    follow(object) {
      if (!this._id) return;
      const pose = anchors()?.getPose(this._id);
      if (!pose) return;
      const p = pose.transform.position;
      // Плавно догоняем уточнённый якорь, чтобы не было рывков.
      object.position.lerp(scratch.set(p.x, p.y, p.z), 0.15);
    },
    dispose() {
      if (this._id) anchors()?.delete(this._id);
      this._id = null;
    },
    _id: null,
    _pending: false,
  };
}

/** Простой FPS-метр: вызывает cb(fps) раз в полсекунды. */
export function fpsMeter(cb) {
  let n = 0, t = 0;
  return (dt) => {
    n++; t += dt;
    if (t >= 0.5) {
      cb(Math.round(n / t));
      n = 0; t = 0;
    }
  };
}
