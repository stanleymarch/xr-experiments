// Общий загрузочный слой опытов XR Blocks.
//
// 1. Телефонный guard. XR Blocks помечает depth-sensing / local-floor /
//    hand-tracking как requiredFeatures, когда опыт их включил. Телефонный
//    Chrome такие сессии не даёт: requestSession отклоняется, а кнопка
//    ENTER XR молча ничего не делает. Здесь requestSession получает вторую
//    попытку без непосильных фич — опытам остаются их fallback-геометрия
//    (пол, плоскости, границы комнаты) и жесты контроллера/тапы.
// 2. Оверлей входа. XR Blocks бросает #XRButtonWrapper в конец body без
//    единого стиля: на телефоне это крошечная системная кнопка ниже экрана.
//    Стили в common/style.css превращают его в крупную кнопку у нижнего
//    края, а этот модуль вешает класс in-session, когда кнопка становится
//    END XR, — и она ужимается в компактную пилюлю поверх сессии.

import * as xb from 'xrblocks';

export const isAutomation = () =>
  new URLSearchParams(window.location.search).has('test');

export function enableAutomation(options) {
  if (!isAutomation()) return false;
  document.body.classList.add('automation');
  options.reticles.enabled = false;
  options.enableAutomationMode({
    defaultMode: 'User',
    enableHands: false,
    enableCamera: true,
  });
  return true;
}

export const xrDropped = [];

export function installXrGuards() {
  const xr = navigator.xr;
  if (!xr || xr.__downgradeGuard) return;
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
      xrDropped.push(...heavy);
      init.requiredFeatures = required.filter((f) => !heavy.includes(f));
      return orig(mode, init);
    });
}

export function watchXrButton() {
  const sync = (w) => {
    const btn = w.querySelector('button');
    if (btn) w.classList.toggle('in-session', /end/i.test(btn.textContent));
  };
  const attach = () => {
    const w = document.getElementById('XRButtonWrapper');
    if (!w) return false;
    sync(w);
    new MutationObserver(() => sync(w)).observe(w, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return true;
  };
  if (attach()) return;
  // Wrapper появляется позже: Core строит его внутри xb.init().
  const io = new MutationObserver(() => {
    if (attach()) io.disconnect();
  });
  io.observe(document.body, { childList: true, subtree: false });
}

// Превью до входа в XR. На десктопе без WebXR симулятор сам ставит камеру
// на 1.5 м (SimulatorOptions.initialCameraPosition). Телефон WebXR
// поддерживает — симулятор не стартует, камера остаётся в (0,0,0), то есть
// в полу: превью показывает срез сцены у ног. Ставим глаз-хайт вручную;
// в сессии рендерер XR подменит позу камеры своей, это безвредно.
export function previewFromEyeHeight(height = 1.5) {
  if (isAutomation()) return;
  if (!globalThis.navigator?.xr) return; // симулятор знает высоту сам
  const camera = xb.core?.camera;
  if (camera) camera.position.set(0, height, 0);
}

// Стартовый экран опыта. До входа в XR телефон видит тёмный канвас и
// единственную кнопку — без контекста «куда я попал». Shell даёт название,
// описание и подсказки управления, а в сессии прячется тем же классом
// in-session, что и #back.
export function installLaunchShell(options, hints = []) {
  if (typeof document === 'undefined' || isAutomation()) return null;
  const shell = document.createElement('section');
  shell.className = 'launch-shell';
  const title = document.createElement('h2');
  title.textContent = options.xrButton.appTitle || document.title;
  const desc = document.createElement('p');
  desc.textContent = options.xrButton.appDescription || '';
  shell.append(title, desc);
  if (hints.length) {
    const list = document.createElement('ul');
    for (const hint of hints) {
      const item = document.createElement('li');
      item.textContent = hint;
      list.append(item);
    }
    shell.append(list);
  }
  const cta = document.createElement('p');
  cta.className = 'launch-shell__cta';
  cta.textContent = '↓ кнопка входа внизу экрана';
  shell.append(cta);
  document.body.append(shell);
  return shell;
}

// Купол и дымка — атмосфера для VR/симулятора. В AR-passthrough
// (environmentBlendMode 'alpha-blend') BackSide-сфера закрашивает весь
// вид камеры телефона: контент остаётся, обёртка комнаты прячется.
export function hideInPassthrough(objects) {
  const xr = xb.core?.renderer?.xr;
  if (!xr) return;
  const sync = () => {
    const session = xr.getSession?.();
    const ar = Boolean(session) && session.environmentBlendMode === 'alpha-blend';
    for (const object of objects) if (object) object.visible = !ar;
  };
  xr.addEventListener('sessionstart', sync);
  xr.addEventListener('sessionend', sync);
}

// Телефонный AR-passthrough. Quest отдаёт 'additive', телефоны —
// 'alpha-blend'; проверяем только его, чтобы не задевать гарнитуры.
export function isPassthrough() {
  const session = xb.core?.renderer?.xr?.getSession?.();
  return Boolean(session) && session.environmentBlendMode === 'alpha-blend';
}
