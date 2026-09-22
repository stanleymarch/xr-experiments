// @vitest-environment jsdom
// Native-stack regression for the shared phone-style HUD in xrblocks/common/hud.js.
// Run: npx vitest run scripts/phone-hud-native.test.mjs --config scripts/native-vitest.config.mjs
// Dependencies are installed ephemerally (node_modules is gitignored):
// npm install --no-save --package-lock=false --legacy-peer-deps \
//   xrblocks three vitest jsdom @pmndrs/uikit @preact/signals-core lit \
//   three-pathfinding openai @google/genai @mediapipe/tasks-vision \
//   @mediapipe/tasks-audio three-mesh-bvh @sparkjsdev/spark
// Drives the real XR Blocks Interaction engine with synthetic ray frames, the
// same pattern the SDK's own interaction tests use. Verifies the contract the
// experiences rely on: semantic UISlider/UIButton controls consume input via
// their callbacks, and the global onSelectEnd hook can tell UI hits from scene
// hits through hud.owns() so a phone tap never fires the scene action.
import {beforeEach, describe, expect, it} from 'vitest';

const audioParam = {value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {}};
class FakeAudioContext {
  constructor() {
    this.destination = {};
    this.listener = {
      positionX: audioParam, positionY: audioParam, positionZ: audioParam,
      forwardX: audioParam, forwardY: audioParam, forwardZ: audioParam,
      upX: audioParam, upY: audioParam, upZ: audioParam,
      setPosition() {}, setOrientation() {},
    };
  }
  createGain() { return {connect() {}}; }
}
window.AudioContext = FakeAudioContext;
globalThis.AudioContext = FakeAudioContext;

await import('xrblocks/addons/testing/setup.js');
const {Interaction, Script, ScriptsManager} = await import('xrblocks');
const THREE = await import('three');
const {makeHud} = await import('../xrblocks/common/hud.js');

class PhoneHudHarness extends Script {
  constructor() {
    super();
    this.offset = 10;
    this.buttonClicks = 0;
    this.sceneSelects = 0;
    // The SDK test harness never invokes Script.init, so build eagerly.
    this.hud = makeHud({
      title: 'PHONE HUD',
      slider: {
        min: -24,
        max: 24,
        step: 1,
        value: 10,
        ariaLabel: 'time',
        onInput: (value) => {
          this.offset = value;
        },
      },
      buttons: [
        {
          id: 'locate',
          label: 'LOCATE',
          onTap: () => {
            this.buttonClicks++;
          },
        },
      ],
    });
    this.add(this.hud.card);
  }

  // Global hook, as the experiences register it. UI hits must be filtered out.
  onSelectEnd(event) {
    if (this.hud.owns(event?.target)) return;
    this.sceneSelects++;
  }
}

const hit = (object, distance = 1, u = 0.5, v = 0.5) => ({
  distance,
  object,
  point: new THREE.Vector3(0, 0, -distance),
  uv: new THREE.Vector2(u, v),
});

const frameWith = (interaction, controller, intersection, selected) => {
  controller.userData.selected = selected;
  interaction.update(
    {
      raySources: [
        {
          controller,
          sourceType: 'controller-ray',
          selected,
          ray: new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 0, -1)),
          intersections: [intersection],
          position: new THREE.Vector3(),
          orientation: new THREE.Quaternion(),
        },
      ],
      directTouches: [],
    },
    0
  );
};

describe('phone-style HUD semantic input (native XR Blocks stack)', () => {
  let callbacks;
  let interaction;
  let harness;

  beforeEach(async () => {
    callbacks = new ScriptsManager(async () => {});
    interaction = new Interaction({callbacks});
    harness = new PhoneHudHarness();
    await callbacks.initScript(harness);
    await Promise.all(
      [harness.hud.card, harness.hud.control('slider'), harness.hud.control('locate')].map(
        (script) => callbacks.initScript(script)
      )
    );
  });

  it('drags the slider through onInput and commits once on release', async () => {
    const slider = harness.hud.control('slider');
    const controller = new THREE.Object3D();
    controller.userData = {id: 1, connected: true, selected: false};

    frameWith(interaction, controller, hit(slider, 1, 0.5, 0.5), false);
    frameWith(interaction, controller, hit(slider, 1, 0.5, 0.5), true);
    // Center of the -24..24 track snaps the value from 10 to 0.
    expect(harness.offset).toBe(0);

    frameWith(interaction, controller, hit(slider, 1, 0.75, 0.5), true);
    expect(harness.offset).toBe(12);

    frameWith(interaction, controller, hit(slider, 1, 0.75, 0.5), false);
    expect(harness.offset).toBe(12);
    expect(slider.value).toBe(12);

    // The semantic capture owns the whole gesture: the scene hook stays quiet.
    expect(harness.sceneSelects).toBe(0);
  });

  it('taps the button once without firing the scene action underneath', async () => {
    const button = harness.hud.control('locate');
    const controller = new THREE.Object3D();
    controller.userData = {id: 1, connected: true, selected: false};

    frameWith(interaction, controller, hit(button, 1, 0.5, 0.5), false);
    frameWith(interaction, controller, hit(button, 1, 0.5, 0.5), true);
    frameWith(interaction, controller, hit(button, 1, 0.5, 0.5), false);

    expect(harness.buttonClicks).toBe(1);
    expect(harness.sceneSelects).toBe(0);
  });

  it('reports scene hits to the global hook when the pointer misses the card', async () => {
    const sceneCube = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5));
    const controller = new THREE.Object3D();
    controller.userData = {id: 1, connected: true, selected: false};

    frameWith(interaction, controller, hit(sceneCube, 2, 0.5, 0.5), false);
    frameWith(interaction, controller, hit(sceneCube, 2, 0.5, 0.5), true);
    frameWith(interaction, controller, hit(sceneCube, 2, 0.5, 0.5), false);

    expect(harness.sceneSelects).toBe(1);
  });
});
