import * as THREE from 'three';
import * as xb from 'xrblocks';

// Пространственная панель управления опытом. Она ставится в мир один раз
// перед пользователем и остаётся там: HUD не должен ехать за головой ни в VR,
// ни в phone AR. UICard сохраняет native hit-targets XR Blocks для луча,
// pinch, тапа и мыши.


function makePhoneControls({title, stat, buttons, slider}) {
  const coarsePointer =
    globalThis.matchMedia?.('(pointer: coarse)').matches ||
    globalThis.navigator?.maxTouchPoints > 0;
  if (typeof document === 'undefined' || !coarsePointer) return null;

  const root = document.createElement('section');
  root.className = 'phone-controls';
  root.setAttribute('aria-label', `${title} controls`);
  const heading = document.createElement('strong');
  heading.textContent = title;
  const status = document.createElement('span');
  status.textContent = stat;
  status.className = 'phone-controls__status';
  root.append(heading, status);

  let input = null;
  let value = null;
  if (slider) {
    const row = document.createElement('label');
    row.className = 'phone-controls__slider';
    input = document.createElement('input');
    input.type = 'range';
    input.min = slider.min;
    input.max = slider.max;
    input.step = slider.step;
    input.value = slider.value;
    input.setAttribute('aria-label', slider.ariaLabel || 'slider');
    value = document.createElement('output');
    input.addEventListener('input', (event) => {
      event.stopPropagation();
      slider.onInput(Number(input.value));
    });
    row.append(input, value);
    root.append(row);
  }

  const controls = new Map();
  if (buttons.length) {
    const row = document.createElement('div');
    row.className = 'phone-controls__buttons';
    for (const button of buttons) {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = button.label;
      element.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.onTap();
      });
      controls.set(button.id, element);
      row.append(element);
    }
    root.append(row);
  }
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  document.body.append(root);

  return {
    root,
    setStat(text) { status.textContent = text; },
    setLabel(id, text) { controls.get(id)?.replaceChildren(text); },
    setSliderValue(number) { if (input) input.value = number; },
    setSliderLabel(text) { if (value) value.textContent = text; },
  };
}

export function makeHud({
  title,
  stat = '',
  buttons = [], // {id, label, icon?, onTap}
  slider = null, // {min, max, step, value, ariaLabel, onInput}
  offset = [0, -0.32, -0.85],
  width = 0.6,
}) {
  const children = [
    new xb.UIText({
      text: title,
      style: {
        fontSize: 30,
        fontWeight: 'bold',
        textAlign: 'center',
      },
    }),
  ];

  const statText = new xb.UIText({
    text: stat,
    style: {
      fontSize: 17,
      opacity: 0.82,
      textAlign: 'center',
      lineHeight: 1.25,
    },
  });
  children.push(statText);

  let sliderEl = null;
  let sliderLabel = null;
  if (slider) {
    sliderLabel = new xb.UIText({
      text: '',
      style: {fontSize: 16, flexShrink: 0},
    });
    sliderEl = new xb.UISlider({
      ariaLabel: slider.ariaLabel || 'slider',
      min: slider.min,
      max: slider.max,
      step: slider.step,
      value: slider.value,
      style: {flexGrow: 1, height: 40},
      onInput: (v) => slider.onInput(v),
    });
    children.push(
      new xb.UIPanel({
        style: {
          width: '100%',
          flexDirection: 'row',
          gap: 10,
          alignItems: 'center',
        },
        children: [sliderEl, sliderLabel],
      })
    );
  }

  const byId = new Map();
  if (buttons.length) {
    children.push(
      new xb.UIPanel({
        style: {width: '100%', flexDirection: 'row', gap: 10},
        children: buttons.map((button) => {
          const element = new xb.UIButton({
            label: button.label,
            icon: button.icon,
            style: {flexGrow: 1, fontSize: 17, padding: 14},
            onClick: () => button.onTap(),
          });
          byId.set(button.id, element);
          return element;
        }),
      })
    );
  }

  const card = new xb.UICard({
    size: {width, height: 'auto'},
    // SDK template: a card is world-space by default; its edge is the
    // explicit drag target, so a control press never becomes a scene action.
    manipulation: {
      actions: {translate: {faceCamera: true}},
      handle: {action: 'translate'},
    },
    edge: true,
    style: {
      flexDirection: 'column',
      gap: 12,
      padding: 18,
      backgroundColor: '#101726',
    },
    children,
  });
  card.name = `${title.toLowerCase().replaceAll('/', '-')}-hud`;
  // Android Chrome's canvas touch path does not always resolve UIKit hit
  // surfaces. The SDK samples use a DOM action for that route; keep the same
  // domain callbacks and hide this deterministic fallback inside XR sessions.
  const phoneControls = makePhoneControls({title, stat, buttons, slider});
  // In handheld canvas mode the DOM panel is the only input surface. Keeping
  // the spatial copy visible would invite taps that Chrome reports globally.
  if (phoneControls) card.visible = false;

  // World-locked placement. В VR (Quest) карточка встаёт в мир один раз на
  // старте сессии и стоит: голова носится — интерфейс остаётся на месте.
  // В телефонном AR world-lock с первого кадра означает «повернул телефон —
  // интерфейса нет»: там карточка следует за взглядом с демпфированием, пока
  // пользователь не перетащит её сам — с этого момента она якорится в мире.
  const UP = new THREE.Vector3(0, 1, 0);
  const cameraPosition = new THREE.Vector3();
  const cardPosition = new THREE.Vector3();
  const cardQuaternion = new THREE.Quaternion();
  const localOffset = new THREE.Vector3(...offset);
  const matrix = new THREE.Matrix4();
  let anchorId = null;
  let anchorPending = false;
  let manipulating = false;
  let userPinned = false;
  // Placement-скрипты SDK для телефонного AR (Placement manual: «FollowHead —
  // view-relative HUD», FaceCamera — читаемость). Управляет только фазой
  // «следует за взглядом»; после ручного перетаскивания снимаются.
  let followHead = null;
  let faceCamera = null;

  const place = () => {
    const camera = xb.core?.camera;
    if (!camera) return;
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(cameraPosition);
    card.position.copy(localOffset).applyQuaternion(camera.quaternion).add(cameraPosition);
    matrix.lookAt(cameraPosition, card.position, UP);
    card.quaternion.setFromRotationMatrix(matrix);
  };


  const pin = async (replace = false) => {
    const anchors = xb.core?.world?.anchors;
    const session = xb.core?.renderer?.xr?.getSession?.();
    if (
      !anchors ||
      !session ||
      anchorPending ||
      (!replace && anchorId) ||
      anchors.capability === 'unsupported' ||
      typeof XRRigidTransform !== 'function'
    ) return;

    anchorPending = true;
    card.getWorldPosition(cardPosition);
    card.getWorldQuaternion(cardQuaternion);
    const previousId = replace ? anchorId : null;
    const tracked = await anchors.create(
      new XRRigidTransform(
        {x: cardPosition.x, y: cardPosition.y, z: cardPosition.z},
        {
          x: cardQuaternion.x, y: cardQuaternion.y,
          z: cardQuaternion.z, w: cardQuaternion.w,
        }
      ),
      card.name
    );
    anchorPending = false;
    if (!tracked) return;
    if (previousId && previousId !== tracked.id) anchors.delete(previousId);
    anchorId = tracked.id;
  };

  const attachFollowScripts = () => {
    if (userPinned || followHead) return;
    followHead = new xb.FollowHead({offset: localOffset.clone(), smoothing: 0.1});
    faceCamera = new xb.FaceCamera({mode: 'spherical', smoothing: 0.1});
    card.add(followHead, faceCamera);
  };
  const detachFollowScripts = () => {
    if (!followHead) return;
    card.remove(followHead, faceCamera);
    followHead = faceCamera = null;
  };

  card.onObjectManipulate = (event) => {
    manipulating = event.phase === 'start' || event.phase === 'update';
    if (event.phase === 'end' || event.phase === 'cancel') {
      manipulating = false;
      // Перетаскивание — явное «оставь тут»: placement-скрипты снимаются,
      // карточка живёт в мире (якорь), а не следует за взглядом. Во время
      // перетаскивания SDK сам ставит их на паузу (suspendTransformScripts).
      userPinned = true;
      detachFollowScripts();
      void pin(true);
    }
  };

  requestAnimationFrame(place);
  const setPhoneControlsVisibility = () => {
    const inSession = Boolean(xb.core?.renderer?.xr?.getSession?.());
    if (phoneControls) {
      phoneControls.root.hidden = inSession;
      card.visible = inSession;
    }
  };
  // В VR карточка world-lock'ится один раз на стартовую позу (два кадра —
  // ждём валидную XR-позу камеры). В телефонном AR до закрепления её ведут
  // FollowHead+FaceCamera; после выхода из сессии скрипты снимаются.
  xb.core?.renderer?.xr?.addEventListener('sessionstart', () => {
    setPhoneControlsVisibility();
    const session = xb.core?.renderer?.xr?.getSession?.();
    if (session?.environmentBlendMode === 'alpha-blend') {
      attachFollowScripts();
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(place));
  });
  xb.core?.renderer?.xr?.addEventListener('sessionend', detachFollowScripts);
  let lastStat = null;
  return {
    card,
    owns(target) {
      // Global Script hooks still receive select events after a semantic UI
      // control handled them. Experiences use this guard so a phone tap on a
      // slider/button does not also fire the scene action underneath.
      for (let node = target; node; node = node.parent) {
        if (node === card) return true;
      }
      return false;
    },
    control(id) {
      return id === 'slider' ? sliderEl : byId.get(id);
    },
    setStat(value) {
      if (value === lastStat) return;
      lastStat = value;
      statText.text = value;
      phoneControls?.setStat(value);
    },
    setLabel(id, text) {
      const element = byId.get(id);
      if (element && element.label !== text) element.label = text;
      phoneControls?.setLabel(id, text);
    },
    setSliderValue(value) {
      if (sliderEl && sliderEl.value !== value) sliderEl.value = value;
      phoneControls?.setSliderValue(value);
    },
    setSliderLabel(value) {
      if (sliderLabel && sliderLabel.text !== value) sliderLabel.text = value;
      phoneControls?.setSliderLabel(value);
    },
    update() {
      // Телефонный AR до закрепления: позу ведут FollowHead+FaceCamera,
      // якорить нечего — мир не транслируется вслед за карточкой.
      if (followHead) return;
      if (!anchorId) void pin();
      if (manipulating || !anchorId) return;
      const referenceSpace = xb.core?.renderer?.xr?.getReferenceSpace?.();
      const pose = xb.core?.world?.anchors?.getPose(anchorId, referenceSpace);
      if (!pose) return;
      const {position, orientation} = pose.transform;
      card.position.set(position.x, position.y, position.z);
      card.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
    },
  };
}
