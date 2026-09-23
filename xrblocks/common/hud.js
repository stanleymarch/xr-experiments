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
  offset = [0.82, 0.42, -1.15],
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
    style: {
      flexDirection: 'column',
      gap: 12,
      padding: 18,
      backgroundColor: '#101726',
    },
    children,
  });
  const anchor = new THREE.Group();
  anchor.add(
    card,
    new xb.FollowHead({offset: new THREE.Vector3(...offset), smoothing: 0.1}),
    new xb.FaceCamera({mode: 'spherical', smoothing: 0.1})
  );

  let lastStat = null;
  return {
    card: anchor,
    owns(target) {
      // Global Script hooks still receive select events after a semantic UI
      // control handled them. Experiences use this guard so a phone tap on a
      // slider/button does not also fire the scene action underneath.
      for (let node = target; node; node = node.parent) {
        if (node === anchor) return true;
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
