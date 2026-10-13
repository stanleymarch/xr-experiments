/**
 * Silent AudioContext stand-in for engines without WebAudio.
 *
 * The framework registers its always-on AudioSystem during World.create, and
 * that system's init unconditionally constructs a three.js AudioListener —
 * which calls `new (window.AudioContext || window.webkitAudioContext)`. On
 * engines that ship no audio stack (some embedded WebKit builds, in-app
 * browsers) both constructors are undefined and the throw aborted the whole
 * boot: no HUD, no weather, just the startup-error overlay. There is no
 * config opt-out, so before the world exists we install a silent context
 * with the surface three.js AudioListener, the SDK AudioSystem and the app's
 * own weather audio touch at construction/graph-build time. Everything stays
 * muted by definition — the host has no audio to unmute.
 */

class SilentAudioParam {
  value = 1;
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
  setTargetAtTime(): void {}
  cancelScheduledValues(): void {}
}

class SilentAudioNode {
  readonly gain = new SilentAudioParam();
  readonly frequency = new SilentAudioParam();
  readonly Q = new SilentAudioParam();
  readonly playbackRate = new SilentAudioParam();
  readonly detune = new SilentAudioParam();
  connect(): null {
    return null;
  }
  disconnect(): void {}
  start(): void {}
  stop(): void {}
}

class SilentAudioContext {
  readonly state: AudioContextState = 'suspended';
  readonly sampleRate = 48000;
  readonly currentTime = 0;
  readonly destination = new SilentAudioNode();
  /** three's AudioListener ramps listener.upX/Y/Z and position/forward. */
  readonly listener: Record<string, SilentAudioParam | (() => void)> = {
    upX: new SilentAudioParam(),
    upY: new SilentAudioParam(),
    upZ: new SilentAudioParam(),
    forwardX: new SilentAudioParam(),
    forwardY: new SilentAudioParam(),
    forwardZ: new SilentAudioParam(),
    positionX: new SilentAudioParam(),
    positionY: new SilentAudioParam(),
    positionZ: new SilentAudioParam(),
    setPosition: () => {},
    setOrientation: () => {},
  };
  createGain(): SilentAudioNode {
    return new SilentAudioNode();
  }
  createBufferSource(): SilentAudioNode {
    return new SilentAudioNode();
  }
  createBiquadFilter(): SilentAudioNode {
    return new SilentAudioNode();
  }
  createStereoPanner(): SilentAudioNode {
    return new SilentAudioNode();
  }
  createPanner(): SilentAudioNode {
    return new SilentAudioNode();
  }
  createOscillator(): SilentAudioNode {
    return new SilentAudioNode();
  }
  createDynamicsCompressor(): SilentAudioNode {
    return new SilentAudioNode();
  }
  createBuffer(_channels: number, length: number): AudioBuffer {
    const data = new Float32Array(length);
    return {
      getChannelData: () => data,
      duration: 0,
      length,
      numberOfChannels: 1,
      sampleRate: this.sampleRate,
    } as unknown as AudioBuffer;
  }
  decodeAudioData(): Promise<AudioBuffer> {
    return Promise.reject(new Error('no audio stack: decode rejected'));
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
/** True when the host exposes no usable WebAudio constructor. */
function needsSilentContext(): boolean {
  if (typeof window === 'undefined') return false;
  const scope = window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown };
  const ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (typeof ctor !== 'function') return true;
  try {
    // A constructor that throws (policy-locked embedded builds) is as dead.
    new (ctor as new () => unknown)();
  } catch {
    return true;
  }
  return false;
}


/**
 * Link audio nodes without chaining `connect()` calls: some engines return
 * `undefined` from `AudioNode.connect()`, so `a.connect(b).connect(c)` throws
 * there — and a throw inside a UI handler silently kills the button.
 */
export function connectAudio(
  ...nodes: Array<AudioNode | AudioParam>
): void {
  for (let i = 1; i < nodes.length; i += 1) {
    (nodes[i - 1] as AudioNode).connect(nodes[i] as AudioNode);
  }
}

/**
 * Install the silent context when (and only when) the host has no WebAudio.
 * Must run before World.create: the always-on AudioSystem inits with it.
 */
export function ensureAudioContextAvailable(): void {
  if (!needsSilentContext()) return;
  (window as unknown as { AudioContext?: unknown }).AudioContext = SilentAudioContext;
}
