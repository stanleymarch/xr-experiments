import * as THREE from 'three';
import * as xb from 'xrblocks';

// Пространственная панель управления опытом — компоненты XR Blocks из
// официального UI kit. FollowHead держит панель в поле зрения, FaceCamera
// разворачивает её к пользователю. Один UI работает с лучом/пинчем на Quest,
// тапом в AR и мышью в симуляторе.


export function makeHud({
  title,
  stat = '',
  buttons = [], // {id, label, icon?, onTap}
  slider = null, // {min, max, step, value, ariaLabel, onInput}
  offset = [0, -0.28, -1.05],
  width = 0.62,
}) {
  const children = [
    new xb.UIText({
      text: title,
      style: {
        fontSize: 24,
        fontWeight: 'bold',
        textAlign: 'center',
      },
    }),
  ];

  const statText = new xb.UIText({
    text: stat,
    style: {
      fontSize: 15,
      opacity: 0.78,
      textAlign: 'center',
      lineHeight: 1.35,
    },
  });
  children.push(statText);

  let sliderEl = null;
  let sliderLabel = null;
  if (slider) {
    sliderLabel = new xb.UIText({
      text: '',
      style: {fontSize: 15, flexShrink: 0},
    });
    sliderEl = new xb.UISlider({
      ariaLabel: slider.ariaLabel || 'slider',
      min: slider.min,
      max: slider.max,
      step: slider.step,
      value: slider.value,
      style: {flexGrow: 1, height: 36},
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
            style: {flexGrow: 1},
            onClick: () => button.onTap(),
          });
          byId.set(button.id, element);
          return element;
        }),
      })
    );
  }

  const card = new xb.UICard({size: {width, height: 'auto'}, children});
  const anchor = new THREE.Group();
  anchor.add(
    card,
    new xb.FollowHead({offset: new THREE.Vector3(...offset), smoothing: 0.1}),
    new xb.FaceCamera({mode: 'spherical', smoothing: 0.1})
  );

  let lastStat = null;
  return {
    card: anchor,
    setStat(value) {
      if (value === lastStat) return;
      lastStat = value;
      statText.text = value;
    },
    setLabel(id, text) {
      const element = byId.get(id);
      if (element && element.label !== text) element.label = text;
    },
    setSliderValue(value) {
      if (sliderEl && sliderEl.value !== value) sliderEl.value = value;
    },
    setSliderLabel(value) {
      if (sliderLabel && sliderLabel.text !== value) sliderLabel.text = value;
    },
  };
}
