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
