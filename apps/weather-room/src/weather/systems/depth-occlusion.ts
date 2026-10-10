/**
 * WEATHER//ROOM depth occlusion runtime: owns the depth image the custom
 * weather shaders sample (`depthOcclusionUniforms` in `../depth-occlusion.ts`)
 * and calibrates its decoding against the live data.
 *
 * The framework's `DepthSensingSystem` uploads its own copy of the depth image
 * for `DepthOccludable` entities, but that object is private to the system, so
 * this system drives a second, public `DepthTextures` instance from the same XR
 * frame. GPU depth costs one wrapper per session with no per-frame copy; CPU
 * depth copies the small per-eye depth image, the same work the framework does.
 *
 * No entity is tagged `DepthOccludable`, on purpose. The app has no virtual
 * room geometry at all — the walls, floor, couch and tables are real
 * passthrough — so the only virtual 3D content is the weather volume plus the
 * UI. Occluding the weather layers is the point of this system; occluding the
 * panel or the timeline rail is not: Meta's own Horizon OS windows and controls
 * are never hidden by real geometry, because a control that can be occluded
 * stops being reachable.
 *
 * What the depth texture holds, and why the decoding is calibrated rather than
 * hard-coded — confirmed on Quest 3 hardware: Meta's gpu-optimized
 * `unsigned-short` is delivered as a *normalized* GL_DEPTH_COMPONENT16 texture
 * (the spec's R16UI table entry describes the CPU shape of 16-bit data, not the
 * GPU texture), so every sample is a depth-buffer value in [0,1] that has to be
 * linearized with the session's near and far planes. The emulator instead packs
 * a unitless inverse depth into R32F, and CPU data is raw units times
 * `rawValueToMeters`. This system therefore probes the live image, decides
 * whether the samples are normalized, scores the candidate interpretations
 * against a room-sized range and logs everything — format, the texture's actual
 * internal format, the chosen decoding and the decoded center depth — so a
 * headset run can be judged from the console without looking at the screen.
 *
 * Degradation: outside XR the uniforms stay disabled and nothing is logged;
 * inside XR without the `depth-sensing` grant (denied Spatial permission, or a
 * runtime that cannot supply depth) one warning is logged per session and the
 * room renders exactly as it did before depth occlusion existed.
 */

import { createSystem, DepthTextures } from '@iwsdk/core';
import type { ReadonlySignal } from '@iwsdk/core';
import { capabilityProfile } from '../capabilities.js';
import type { CapabilityProfile } from '../capabilities.js';
import { depthOcclusionUniforms, isIdentityMatrix, setDepthTextureKind } from '../depth-occlusion.js';
import type { DepthTextureKind } from '../depth-occlusion.js';

/**
 * Interpretations of a raw depth sample. Which one is live is a runtime uniform,
 * chosen by the probe below; the default per format is the semantics the
 * hardware and the emulator were actually observed to use.
 */
const DepthDecodeMode = {
  /** Spec: raw units multiplied by `rawValueToMeters` (CPU data, float32). */
  SpecRaw: 0,
  /** Normalized session depth buffer, 0 at the near plane (Quest unsigned-short). */
  WindowDepth: 1,
  /** Same buffer with the near plane at 1 (reversed depth). */
  WindowDepthReversed: 2,
  /** Unitless inverse depth already in [0,1): near / (1 - raw) (emulator R32F). */
  InverseUnit: 3,
  /** Raw value in millimeters while `rawValueToMeters` reports 1. */
  Millimeters: 4,
} as const;

const DECODE_NAMES: Record<number, string> = {
  [DepthDecodeMode.SpecRaw]: 'spec-raw',
  [DepthDecodeMode.WindowDepth]: 'window-depth',
  [DepthDecodeMode.WindowDepthReversed]: 'window-depth-reversed',
  [DepthDecodeMode.InverseUnit]: 'inverse-unit',
  [DepthDecodeMode.Millimeters]: 'millimeters',
};

/** Texture shapes the probe can distinguish, named for the diagnostic line. */
const TEXTURE_SHAPES: Record<string, string> = {
  colorFloat: 'r32f',
  depthNormalized: 'depth16',
};

/** A decoded depth is plausible if it lands inside a room-sized range. */
const PLAUSIBLE_MIN_M = 0.3;
const PLAUSIBLE_MAX_M = 12;
/** A candidate only wins calibration when this share of samples is plausible. */
const PLAUSIBLE_SHARE = 0.6;
/** Probe (readback + log) cadence in frames, ~5 s at 60 Hz. */
const PROBE_INTERVAL_FRAMES = 300;
/** Probe sample positions in normalized image coordinates. */
const PROBE_COLUMNS: readonly number[] = [0.5, 0.5, 0.5, 0.25, 0.75, 0.25, 0.75, 0.1, 0.9];
const PROBE_ROWS: readonly number[] = [0.5, 0.25, 0.75, 0.5, 0.5, 0.25, 0.75, 0.5, 0.5];
/** Fallback far plane when the runtime does not report one. */
const FALLBACK_DEPTH_FAR = 1000;

/**
 * Read an optional numeric field off a runtime object whose typings lag behind
 * the shipped runtime (Meta exposes `depthNear`/`depthFar` on GPU depth info;
 * the installed `@types/webxr` has neither).
 */
function readOptionalNumber(source: object, field: string): number {
  const candidate: unknown = source;
  if (typeof candidate === 'object' && candidate != null && field in candidate) {
    const value: unknown = candidate[field as keyof typeof candidate];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

/** Decode one raw sample under a candidate interpretation, in meters. */
function decodeSample(
  mode: number,
  raw: number,
  rawToMeters: number,
  depthNear: number,
  depthFar: number,
): number {
  const range = Math.max(depthFar - depthNear, 0.001);
  if (mode === DepthDecodeMode.WindowDepth) {
    return (2 * depthNear * depthFar) / Math.max(depthFar + depthNear - raw * range, 0.001);
  }
  if (mode === DepthDecodeMode.WindowDepthReversed) {
    return (2 * depthNear * depthFar) / Math.max(depthFar + depthNear - (1 - raw) * range, 0.001);
  }
  if (mode === DepthDecodeMode.InverseUnit) {
    return (rawToMeters * depthNear) / Math.max(1 - raw, 0.001);
  }
  if (mode === DepthDecodeMode.Millimeters) return raw * 0.001;
  return raw * rawToMeters;
}

/** Integer probe coordinates for an image of this size, clamped in range. */
function probeCoordinates(width: number, height: number): number[][] {
  const coordinates: number[][] = [];
  for (let index = 0; index < PROBE_COLUMNS.length; index += 1) {
    coordinates.push([
      Math.min(width - 1, Math.max(0, Math.floor(PROBE_COLUMNS[index] * width))),
      Math.min(height - 1, Math.max(0, Math.floor(PROBE_ROWS[index] * height))),
    ]);
  }
  return coordinates;
}

export class DepthOcclusionSystem extends createSystem({}) {
  private textures: DepthTextures | null = null;
  private texturesFloat32 = false;
  private session: XRSession | null = null;
  /** Session-scoped availability, so each state is logged exactly once. */
  private reported: 'active' | 'unavailable' | null = null;
  private profile!: ReadonlySignal<CapabilityProfile>;
  /** Frames since the last depth probe (readback + control-value log). */
  private framesSinceProbe = PROBE_INTERVAL_FRAMES;
  /** Interpretation currently published to the shaders. */
  private probeMode: number = DepthDecodeMode.SpecRaw;
  /** Shape of the live depth texture as the probe observed it. */
  private probeTextureShape = 'unknown';

  init(): void {
    this.profile = capabilityProfile(this.world);
  }

  update(): void {
    const session = this.world.xrSession ?? null;
    if (session !== this.session) {
      this.session = session;
      this.reported = null;
      this.framesSinceProbe = PROBE_INTERVAL_FRAMES;
      this.probeMode = DepthDecodeMode.SpecRaw;
      this.probeTextureShape = 'unknown';
      this.releaseTextures();
      // Capabilities are session-scoped: recompute at the session edge rather
      // than trusting the value captured at init.
      this.profile = capabilityProfile(this.world);
    }

    const { uWrEnabled } = depthOcclusionUniforms;
    if (session == null) {
      // Desktop/editor preview: no session to judge, no warning.
      uWrEnabled.value = false;
      return;
    }
    if (!this.profile.peek().depth) {
      uWrEnabled.value = false;
      if (this.reported !== 'unavailable') {
        this.reported = 'unavailable';
        console.warn(
          '[weather-room] depth-sensing was not granted for this session (Spatial permission denied, ' +
            'or the runtime cannot supply depth); weather effects render without real-world occlusion',
        );
      }
      return;
    }

    const detail = this.uploadDepth(session);
    // The texel accessor kind must change in lockstep with `uWrEnabled`: a
    // packed16 accessor against no depth texture at all would make three bind
    // its empty array texture into a shader that then reads garbage. The kind
    // only follows a frame that really published a depth image.
    if (detail != null) setDepthTextureKind(this.textureKind(session));
    uWrEnabled.value = detail != null;
    if (detail != null && this.reported !== 'active') {
      this.reported = 'active';
      console.info(`[weather-room] real-world depth occlusion active (${detail})`);
    }
    this.maybeProbe(session);
  }

  /**
   * Refresh the app's depth image from the current XR frame and publish the
   * depth-image transform. Returns the one-line diagnostics of the accepted
   * frame, or `null` when this frame cannot occlude (no frame yet, no viewer
   * pose, no depth image, or a GPU depth image without the `depthNear` the
   * normalized encodings need).
   */
  private uploadDepth(session: XRSession): string | null {
    const uniforms = depthOcclusionUniforms;
    const frame = this.world.xrFrame;
    const referenceSpace = this.world.xrReferenceSpace;
    if (frame == null || referenceSpace == null) return null;
    const pose = frame.getViewerPose(referenceSpace);
    if (pose == null || pose.views.length === 0) return null;

    this.ensureTextures(session);

    if (session.depthUsage === 'gpu-optimized') {
      const binding = this.renderer.xr.getBinding();
      const view = pose.views[0];
      const info = binding != null && view != null ? binding.getDepthInformation(view) : null;
      if (info == null) return null;
      // The normalized encodings are near/far relative: without depthNear the
      // conversion is undefined. Skip the frame instead of occluding everything.
      const depthNear = readOptionalNumber(info, 'depthNear');
      if (!(depthNear > 0)) return null;
      const textures = this.textures;
      if (textures == null) return null;
      textures.updateNativeTexture(info, this.renderer);
      const texture = textures.getNativeTexture();
      if (texture == null) return null;
      this.publishTransform(info);
      uniforms.uWrDepthArray.value = texture;
      uniforms.uWrRawToMeters.value = info.rawValueToMeters;
      uniforms.uWrDepthNear.value = depthNear;
      uniforms.uWrDepthFar.value = this.depthFarFor(session, info, depthNear);
      uniforms.uWrFlipV.value = false;
      if (this.probeMode === DepthDecodeMode.SpecRaw) this.probeMode = this.defaultDecode(session);
      return `usage=gpu-optimized format=${session.depthDataFormat ?? 'unknown'} ${info.width}x${info.height} ` +
        `rawValueToMeters=${info.rawValueToMeters} depthNear=${depthNear} ` +
        `depthFar=${uniforms.uWrDepthFar.value} eyes=${pose.views.length} ` +
        `kind=${this.textureKind(session)} decode=${DECODE_NAMES[this.probeMode] ?? this.probeMode}`;
    }

    // CPU path: every view must be present, otherwise one eye would sample a
    // stale layer of the depth array.
    let summary: string | null = null;
    for (let viewId = 0; viewId < pose.views.length; viewId += 1) {
      const info = frame.getDepthInformation(pose.views[viewId]);
      if (info == null) return null;
      this.textures?.updateData(info, viewId);
      uniforms.uWrRawToMeters.value = info.rawValueToMeters;
      uniforms.uWrDepthNear.value = 0;
      uniforms.uWrDepthFar.value = 0;
      uniforms.uWrFlipV.value = true;
      summary ??=
        `usage=cpu-optimized format=${session.depthDataFormat ?? 'unknown'} ${info.width}x${info.height} ` +
        `rawValueToMeters=${info.rawValueToMeters} eyes=${pose.views.length} ` +
        `kind=${this.textureKind(session)} decode=${DECODE_NAMES[this.probeMode] ?? this.probeMode}`;
    }
    const texture = this.textures?.getDataArrayTexture();
    if (texture == null) return null;
    uniforms.uWrDepthArray.value = texture;
    return summary;
  }

  /** Far plane for the normalized decodings, from the runtime or the session. */
  private depthFarFor(session: XRSession, info: XRWebGLDepthInformation, depthNear: number): number {
    const reported = readOptionalNumber(info, 'depthFar');
    if (reported > depthNear + 1) return reported;
    const renderState = session.renderState;
    if (renderState.depthFar > depthNear + 1) return renderState.depthFar;
    return FALLBACK_DEPTH_FAR;
  }

  /**
   * Publish `normDepthBufferFromNormView`. A runtime that hands over the
   * identity stub (the emulator does) gets the plain UV convention instead, so
   * a no-op matrix is never applied to already-correct UVs. The transform is a
   * pure axis mapping, not an eye-dependent one, so the sampled view's matrix
   * serves both stereo slots.
   */
  private publishTransform(info: XRWebGLDepthInformation | XRCPUDepthInformation): void {
    const uniforms = depthOcclusionUniforms;
    const transform = info.normDepthBufferFromNormView;
    if (transform == null) {
      uniforms.uWrUseMatrix.value = false;
      return;
    }
    const matrix = transform.matrix;
    uniforms.uWrUseMatrix.value = !isIdentityMatrix(matrix);
    const target = uniforms.uWrDepthFromView.value;
    for (let eye = 0; eye < 2; eye += 1) {
      for (let index = 0; index < 16; index += 1) target[eye * 16 + index] = matrix[index] ?? 0;
    }
  }

  /** Texel accessor kind the injected shaders must declare for this session. */
  private textureKind(session: XRSession): DepthTextureKind {
    // Every GPU format is a float-sampled texture (R32F on the emulator,
    // normalized depth16 on the headset); only CPU 16-bit entries are packed.
    if (session.depthUsage === 'gpu-optimized') return 'scalar';
    return session.depthDataFormat === 'float32' ? 'scalar' : 'packed16';
  }

  /** Interpretation this runtime is expected to use, before calibration. */
  private defaultDecode(session: XRSession): number {
    if (session.depthUsage !== 'gpu-optimized') return DepthDecodeMode.SpecRaw;
    if (session.depthDataFormat === 'float32') return DepthDecodeMode.InverseUnit;
    if (session.depthDataFormat === 'unsigned-short') return DepthDecodeMode.WindowDepth;
    return DepthDecodeMode.SpecRaw;
  }

  /** Keep the shared texture instance in step with the session's format. */
  private ensureTextures(session: XRSession): void {
    const useFloat32 = session.depthDataFormat === 'float32';
    if (this.textures == null || this.texturesFloat32 !== useFloat32) {
      this.releaseTextures();
      this.textures = new DepthTextures(useFloat32);
      this.texturesFloat32 = useFloat32;
    }
  }

  /**
   * Sample the live depth image, check whether the decoding the shaders use is
   * the right one and log a control value. Runs on the first depth frame and
   * then every `PROBE_INTERVAL_FRAMES` frames; the readback is a small stall,
   * which is why it is not per-frame.
   */
  private maybeProbe(session: XRSession): void {
    this.framesSinceProbe += 1;
    if (this.framesSinceProbe < PROBE_INTERVAL_FRAMES) return;
    this.framesSinceProbe = 0;

    const rawToMeters = depthOcclusionUniforms.uWrRawToMeters.value;
    const depthNear = depthOcclusionUniforms.uWrDepthNear.value;
    const depthFar = depthOcclusionUniforms.uWrDepthFar.value;
    const samples = this.sampleRawDepth(session);
    if (samples == null || samples.length === 0) return;
    const normalized = samples.every((raw) => raw > 0 && raw <= 1);

    const candidates = normalized
      ? [this.defaultDecode(session), DepthDecodeMode.WindowDepth, DepthDecodeMode.WindowDepthReversed, DepthDecodeMode.InverseUnit]
      : [this.defaultDecode(session), DepthDecodeMode.SpecRaw, DepthDecodeMode.Millimeters, DepthDecodeMode.InverseUnit];
    let resolved = false;
    for (const mode of candidates) {
      let plausible = 0;
      for (const raw of samples) {
        const meters = decodeSample(mode, raw, rawToMeters, depthNear, depthFar);
        if (meters >= PLAUSIBLE_MIN_M && meters <= PLAUSIBLE_MAX_M) plausible += 1;
      }
      if (plausible / samples.length >= PLAUSIBLE_SHARE) {
        this.probeMode = mode;
        resolved = true;
        break;
      }
    }
    // Nothing qualified: keep the per-format default rather than guessing, and
    // say so in the log so a device run can judge it.
    if (!resolved) this.probeMode = this.defaultDecode(session);
    depthOcclusionUniforms.uWrDecode.value = this.probeMode;

    const center = samples[Math.floor(samples.length / 2)] ?? 0;
    const decoded = decodeSample(this.probeMode, center, rawToMeters, depthNear, depthFar);
    const sorted = [...samples].sort((left, right) => left - right);
    const min = sorted[0] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    const textureName = TEXTURE_SHAPES[this.probeTextureShape] ?? 'unknown';
    console.info(
      `[weather-room] depth probe: format=${session.depthDataFormat ?? 'unknown'} tex=${textureName} ` +
        `normalized=${normalized ? 'yes' : 'no'} decode=${DECODE_NAMES[this.probeMode] ?? this.probeMode} ` +
        `matrix=${depthOcclusionUniforms.uWrUseMatrix.value ? 'on' : 'off'} ` +
        `raw[center]=${center} -> ${decoded.toFixed(2)}m ` +
        `raw[min..max]=${min}..${max} -> ${decodeSample(this.probeMode, min, rawToMeters, depthNear, depthFar).toFixed(2)}` +
        `..${decodeSample(this.probeMode, max, rawToMeters, depthNear, depthFar).toFixed(2)}m ` +
        `resolved=${resolved ? 'yes' : 'no'}`,
    );
  }

  /**
   * Raw depth samples at the probe positions, in the same units the shader's
   * float sampler returns. The CPU path reads them straight from the WebXR
   * buffer; the GPU path reads texels back through a framebuffer — as a color
   * read for float attachments, or as a depth read normalized to [0,1] for
   * depth-format textures, which is exactly what sampling them yields.
   */
  private sampleRawDepth(session: XRSession): number[] | null {
    const frame = this.world.xrFrame;
    const referenceSpace = this.world.xrReferenceSpace;
    if (frame == null || referenceSpace == null) return null;
    const pose = frame.getViewerPose(referenceSpace);
    if (pose == null || pose.views.length === 0) return null;

    if (session.depthUsage !== 'gpu-optimized') {
      const info = frame.getDepthInformation(pose.views[0]);
      if (info == null) return null;
      const view =
        session.depthDataFormat === 'float32'
          ? new Float32Array(info.data)
          : new Uint16Array(info.data);
      return this.pickSamples(view, info.width, info.height);
    }

    const binding = this.renderer.xr.getBinding();
    const view = pose.views[0];
    const info = binding != null && view != null ? binding.getDepthInformation(view) : null;
    if (info == null) return null;
    return this.readRawTexels(info);
  }

  /** Sample a spread of entries from a full CPU depth image, dropping 0s. */
  private pickSamples(
    view: Uint16Array | Float32Array,
    width: number,
    height: number,
  ): number[] | null {
    if (width <= 0 || height <= 0 || view.length < width * height) return null;
    const samples: number[] = [];
    for (const [column, row] of probeCoordinates(width, height)) {
      const value = view[row * width + column];
      if (value > 0) samples.push(value);
    }
    return samples.length > 0 ? samples : null;
  }

  /**
   * Read single depth texels back from the GPU image, one texel per call so the
   * readback buffer can never disagree with the region being read. The texture
   * is attached as a colour target first (float attachments report RED/FLOAT,
   * and the driver is asked which format it accepts instead of guessing); a
   * depth-format texture cannot be a colour attachment, so it is attached as a
   * depth target instead and read normalized to [0,1] — the same value the
   * shader's float sampler returns for it. The texture's internal format is
   * captured for the diagnostic line while it is bound.
   */
  private readRawTexels(info: XRWebGLDepthInformation): number[] | null {
    const context = this.renderer.getContext();
    // three r181 and IWSDK are WebGL2-only, and this readback needs the WebGL2
    // surface (layered attachments, integer and depth readback), so narrow once
    // here instead of sprinkling casts over every constant below.
    if (!(context instanceof WebGL2RenderingContext)) return null;
    const gl = context;
    const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const framebuffer = gl.createFramebuffer();
    if (framebuffer == null) return null;
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      this.attachDepthTexture(gl, info, gl.COLOR_ATTACHMENT0);
      const samples: number[] = [];
      if (
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE &&
        gl.getError() === gl.NO_ERROR
      ) {
        const readFormat = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number;
        const readType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number;
        if (readFormat === gl.RED && readType === gl.FLOAT) {
          const texel = new Float32Array(1);
          for (const [column, row] of probeCoordinates(info.width, info.height)) {
            gl.readPixels(column, row, 1, 1, readFormat, readType, texel);
            if (gl.getError() !== gl.NO_ERROR) break;
            if (texel[0] > 0) samples.push(texel[0]);
          }
          if (samples.length > 0) {
            this.probeTextureShape = 'colorFloat';
            return samples;
          }
        }
      }
      this.attachDepthTexture(gl, info, gl.DEPTH_ATTACHMENT);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
      this.probeTextureShape = 'depthNormalized';
      const wide = new Uint32Array(1);
      for (const [column, row] of probeCoordinates(info.width, info.height)) {
        gl.readPixels(column, row, 1, 1, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, wide);
        if (gl.getError() !== gl.NO_ERROR) return null;
        if (wide[0] > 0) samples.push(wide[0] / 0xffffffff);
      }
      return samples.length > 0 ? samples : null;
    } catch (error) {
      console.warn('[weather-room] depth probe unavailable on this runtime', error);
      return null;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
      gl.deleteFramebuffer(framebuffer);
    }
  }

  /** Attach the depth texture, as an array layer or a plain 2D texture. */
  private attachDepthTexture(
    gl: WebGL2RenderingContext,
    info: XRWebGLDepthInformation,
    attachment: number,
  ): void {
    if (info.textureType === 'texture-array') {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, attachment, info.texture, 0, info.imageIndex ?? 0);
    } else {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, info.texture, 0);
    }
  }

  /**
   * A stopped system must not leave the last frame's occlusion live. `stop()`
   * is the runtime off switch for this system (the ECS pause API calls it), and
   * paused has to mean "no occlusion", not "frozen at the last value".
   */
  stop(): void {
    super.stop();
    depthOcclusionUniforms.uWrEnabled.value = false;
  }

  private releaseTextures(): void {
    this.textures?.dispose();
    this.textures = null;
    depthOcclusionUniforms.uWrDepthArray.value = null;
  }
}
