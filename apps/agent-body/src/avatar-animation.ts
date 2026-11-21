import {
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  type AnimationAction,
  type Object3D,
} from '@iwsdk/core';
import { VRMHumanBoneList, VRMUtils, type VRM } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AvatarCue } from './agent/contracts.js';

/** Names describe the source motions, not a promise of exact gesture coverage.
 * See public/animations/ATTRIBUTION.txt for pinned sources and original licenses.
 */
export const AVATAR_ANIMATIONS = {
  idle: { file: 'idle-01.vrma', name: 'Sachi / Idle 01' },
  speaking: { file: 'speaking-01.vrma', name: 'Sachi / Speaking 01' },
  nod: { file: 'companion-listening.vrma', name: 'Companion / Listening (small nod)' },
  think: { file: 'companion-thinking.vrma', name: 'Companion / Thinking' },
  bow: { file: 'failed-apology.vrma', name: 'rerofumi / Dogeza (kneeling apology)' },
  happy: { file: 'success-cheer.vrma', name: 'rerofumi / Encouragement' },
  surprised: { file: 'reaction-startle.vrma', name: 'rerofumi / Startled reaction' },
} as const;

type AnimationId = keyof typeof AVATAR_ANIMATIONS;
/** Clips whose limb tracks must not drive this avatar's arms/legs. */
const TORSO_ONLY: ReadonlySet<AnimationId> = new Set<AnimationId>(['nod', 'think']);
const TORSO_BONES = /(?:Hips|Spine|Chest|Neck|Head)/u;
type RestBone = {
  node: Object3D;
  position: Object3D['position'];
  quaternion: Object3D['quaternion'];
  scale: Object3D['scale'];
};

/** Parsed motion data is reusable across avatar replacements; actions are not. */
export class AvatarAnimationLibrary {
  private readonly motions = new Map<AnimationId, VRMAnimation>();
  private loading: Promise<void> | null = null;

  load(): Promise<void> {
    if (this.loading != null) return this.loading;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    this.loading = Promise.all(
      (Object.keys(AVATAR_ANIMATIONS) as AnimationId[]).map(async (id) => {
        const asset = AVATAR_ANIMATIONS[id];
        const url = `${import.meta.env.BASE_URL}animations/${asset.file}`;
        try {
          const gltf = await loader.loadAsync(url);
          const animation = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined)?.[0];
          // These files contain motion rigs, not a second avatar. Dispose the
          // loader scene; the parsed VRMA tracks own their numeric keyframe data.
          VRMUtils.deepDispose(gltf.scene);
          if (animation == null || animation.duration <= 0) {
            throw new Error(`No playable VRM animation in ${asset.file}`);
          }
          this.motions.set(id, animation);
        } catch (error) {
          console.error('[avatar] VRMA unavailable; using procedural motion', asset.file, error);
        }
      }),
    ).then(() => undefined);
    return this.loading;
  }

  bind(vrm: VRM): AvatarAnimationPlayer {
    return new AvatarAnimationPlayer(vrm, this.motions);
  }
}

/** One mixer per avatar; one exclusive body action at a time. Face, blink,
 * visemes and gaze remain owned by AvatarSystem, never by the motion files.
 */
export class AvatarAnimationPlayer {
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<AnimationId, AnimationAction>();
  private readonly rest: RestBone[] = [];
  private active: AnimationAction | null = null;
  private activeId: AnimationId | null = null;
  private gesture = false;
  private elapsed = 0;

  constructor(private readonly vrm: VRM, motions: ReadonlyMap<AnimationId, VRMAnimation>) {
    this.mixer = new AnimationMixer(vrm.scene);
    const bodyBindings = new Set<string>();
    for (const bone of VRMHumanBoneList) {
      const node = vrm.humanoid.getNormalizedBoneNode(bone);
      if (node == null) continue;
      this.rest.push({
        node,
        position: node.position.clone(),
        quaternion: node.quaternion.clone(),
        scale: node.scale.clone(),
      });
      bodyBindings.add(`${node.name}.quaternion`);
      bodyBindings.add(`${node.name}.position`);
    }
    if (vrm.lookAt != null && !vrm.scene.children.some((node) => node instanceof VRMLookAtQuaternionProxy)) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = 'VRMLookAtQuaternionProxy';
      vrm.scene.add(proxy);
    }
    for (const [id, motion] of motions) {
      const clip = createVRMAnimationClip(motion, vrm);
      clip.name = AVATAR_ANIMATIONS[id].name;
      clip.tracks = clip.tracks.filter((track) => {
        if (!bodyBindings.has(track.name)) return false;
        // The Companion Space clips carry raw arm/leg tracks that do not
        // retarget to this VRM: nod and think raised both arms above the head.
        // Keep their head/torso motion and leave the limbs at the rest pose.
        return !TORSO_ONLY.has(id) || TORSO_BONES.test(track.name.split('.')[0]!);
      });
      if (clip.tracks.length === 0) continue;
      this.actions.set(id, this.mixer.clipAction(clip));
    }
    if (import.meta.env.DEV) {
      console.debug('[avatar] VRMA bound', Array.from(this.actions, ([id, action]) => ({
        id, name: action.getClip().name, duration: action.getClip().duration,
        bones: action.getClip().tracks.map((track) => track.name),
      })));
    }
  }

  /** Returns the real clip duration, or zero for procedural-only gestures.
   * Explicit gestures take precedence over optional emotional body clips.
   */
  playCue(cue: AvatarCue): number {
    const gesture = cue.gesture;
    const id = gesture === 'nod' || gesture === 'think' || gesture === 'bow'
      ? gesture
      : gesture === 'none' && (cue.emotion === 'happy' || cue.emotion === 'surprised')
        ? cue.emotion
        : null;
    if (id == null) return 0;
    const action = this.actions.get(id);
    if (action == null) return 0;
    this.start(id, action, true);
    return action.getClip().duration;
  }

  private start(id: AnimationId, action: AnimationAction, gesture: boolean): void {
    this.stop();
    this.active = action;
    this.activeId = id;
    if (import.meta.env.DEV) {
      console.debug('[avatar] VRMA playing', id, action.getClip().name, action.getClip().duration);
    }
    this.gesture = gesture;
    this.elapsed = 0;
    action.reset().setLoop(gesture ? LoopOnce : LoopRepeat, gesture ? 1 : Infinity);
    action.clampWhenFinished = false;
    action.setEffectiveWeight(gesture ? 0 : 1);
    action.play();
  }

  /** Body clips are exclusive: idle/speaking never overwrite a cue's bones.
   * Call once per frame before vrm.update(). No app-owned frame allocations.
   */
  update(delta: number, idle: boolean, talking: boolean, proceduralGesture: boolean): void {
    if (!this.gesture) {
      const id = talking ? 'speaking' : 'idle';
      const action = idle && !proceduralGesture ? this.actions.get(id) : undefined;
      if (action == null) {
        if (this.active != null) this.stop();
      } else if (this.activeId !== id) {
        this.start(id, action, false);
      }
    }
    if (this.active == null) return;
    this.elapsed += delta;
    if (this.gesture) {
      const duration = this.active.getClip().duration;
      if (this.elapsed >= duration) {
        this.stop();
        return;
      }
      // Blend against captured rest at both ends, including clips with hard
      // authored boundaries. Completion restores exact transforms, not an ease.
      const blend = Math.min(0.25, duration * 0.2);
      this.active.setEffectiveWeight(Math.min(1, this.elapsed / blend, (duration - this.elapsed) / blend));
    }
    this.mixer.update(delta);
  }

  get playing(): boolean {
    return this.active != null;
  }

  stop(): void {
    if (import.meta.env.DEV && this.activeId != null) {
      console.debug('[avatar] VRMA stopped', this.activeId, this.elapsed);
    }
    this.mixer.stopAllAction();
    this.active = null;
    this.activeId = null;
    this.gesture = false;
    this.elapsed = 0;
    this.restoreRest();
  }

  /** Full normalized skeleton (including fingers and hips translation), not
   * merely the handful of bones used by the procedural fallback gestures.
   */
  restoreRest(): void {
    for (let i = 0; i < this.rest.length; i++) {
      const bone = this.rest[i];
      bone.node.position.copy(bone.position);
      bone.node.quaternion.copy(bone.quaternion);
      bone.node.scale.copy(bone.scale);
    }
  }

  dispose(): void {
    this.stop();
    this.mixer.uncacheRoot(this.vrm.scene);
    this.actions.clear();
    this.rest.length = 0;
  }
}
