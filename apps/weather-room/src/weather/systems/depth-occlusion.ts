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
 * against a room-sized range and logs the chosen decoding and sampled values.
 * Plausible distances are diagnostics, not proof of physical silhouettes;
 * geometric occlusion still requires a rendered furniture/floor check.
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
  colorByte: 'rgba8',
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

/**
 * Decode one raw sample under a candidate interpretation, in meters. The
 * window-depth branches linearize a [0,1] window value (0 at the near plane:
 * window depth is NDC depth 2d-1, so the view distance is
 * near*far/(far-d*(far-near))); the guards are pure numerical epsilons, never
 * range clamps.
 */
function decodeSample(
  mode: number,
  raw: number,
  rawToMeters: number,
  depthNear: number,
  depthFar: number,
): number {
  const range = Math.max(depthFar - depthNear, 0.000001);
  if (mode === DepthDecodeMode.WindowDepth) {
    return (depthNear * depthFar) / Math.max(depthFar - raw * range, 0.000001);
  }
  if (mode === DepthDecodeMode.WindowDepthReversed) {
    return (depthNear * depthFar) / Math.max(depthFar - (1 - raw) * range, 0.000001);
  }
  if (mode === DepthDecodeMode.InverseUnit) {
    return (rawToMeters * depthNear) / Math.max(1 - raw, 0.000001);
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
  /**
   * Interpretation currently published to the shaders. `uploadDepth` rewrites
   * it from the session fallback on every accepted frame; the probe only
   * refines it through `calibratedMode` below.
   */
  private probeMode: number = DepthDecodeMode.SpecRaw;
  /**
   * Mode the probe actually resolved against this session's live image, or
   * null while uncalibrated. Tracked separately so a legitimately calibrated
   * SpecRaw is never mistaken for "not yet calibrated" and overwritten.
   */
  private calibratedMode: number | null = null;
  /** Shape of the live depth texture as the probe observed it. */
  private probeTextureShape = 'unknown';
  /**
   * Lazily built probe blit and its staging targets. They hold no
   * session-owned handles (the depth texture is only sampled, never stored),
   * so they outlive sessions and are freed in `destroy()`.
   */
  private probeBlit: {
    program: WebGLProgram;
    quad: WebGLBuffer;
    vao: WebGLVertexArrayObject;
    probeUv: WebGLUniformLocation | null;
    depthArray: WebGLUniformLocation | null;
    depthLayer: WebGLUniformLocation | null;
  } | null = null;
  private probeTargetFloat: { framebuffer: WebGLFramebuffer; texture: WebGLTexture } | null = null;
  private probeTargetByte: { framebuffer: WebGLFramebuffer; texture: WebGLTexture } | null = null;

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
      this.calibratedMode = null;
      this.probeTextureShape = 'unknown';
      // The published decode and transform belong to the previous session's
      // image; reset both before any new frame can enable occlusion, so a new
      // session can never inherit stale values.
      depthOcclusionUniforms.uWrDecode.value = DepthDecodeMode.SpecRaw;
      depthOcclusionUniforms.uWrUseMatrix.value.fill(0);
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
   * Refresh the app's depth image from the current XR frame, publish the
   * fallback decode and the depth-image transform. Returns the one-line
   * diagnostics of the accepted frame, or `null` when this frame cannot
   * occlude (no frame yet, no viewer pose, or no depth image).
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
      const firstView = pose.views[0];
      const first = binding != null && firstView != null ? binding.getDepthInformation(firstView) : null;
      if (first == null) return null;
      // A spec-encoded float32 image decodes with rawValueToMeters alone; the
      // near-dependent encodings need depthNear. Only the latter requires it.
      const depthNear = readOptionalNumber(first, 'depthNear');
      const fallback = this.defaultDecode(session, depthNear);
      if (fallback !== DepthDecodeMode.SpecRaw && !(depthNear > 0)) return null;
      const textures = this.textures;
      if (textures == null) return null;
      textures.updateNativeTexture(first, this.renderer);
      const texture = textures.getNativeTexture();
      if (texture == null) return null;
      // Each stereo view has its own depth-image transform; publish each into
      // its own slot so the right eye never inherits the left eye's mapping.
      // A missing second view invalidates the combined path rather than
      // leaving a stale matrix in its slot.
      this.publishTransform(first, 0);
      if (pose.views.length > 1) {
        const second = binding != null ? binding.getDepthInformation(pose.views[1]) : null;
        if (second == null) return null;
        this.publishTransform(second, 1);
      }
      uniforms.uWrDepthArray.value = texture;
      uniforms.uWrRawToMeters.value = first.rawValueToMeters;
      uniforms.uWrDepthNear.value = depthNear;
      uniforms.uWrDepthFar.value = this.depthFarFor(session, first, depthNear);
      uniforms.uWrFlipV.value = false;
      // The fallback decode is published with the frame that enables
      // occlusion, never left to a later probe: the shader must use the decode
      // the log claims from the first occluded frame. A mode the probe already
      // resolved for this session survives later uploads.
      this.probeMode = this.calibratedMode ?? fallback;
      uniforms.uWrDecode.value = this.probeMode;
      return `usage=gpu-optimized format=${session.depthDataFormat ?? 'unknown'} ${first.width}x${first.height} ` +
        `rawValueToMeters=${first.rawValueToMeters} depthNear=${depthNear} ` +
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
      // CPU buffers have specified semantics (raw * rawValueToMeters), so the
      // decode is fixed to them; scene changes must never flip it.
      this.publishTransform(info, viewId);
      uniforms.uWrRawToMeters.value = info.rawValueToMeters;
      uniforms.uWrDepthNear.value = 0;
      uniforms.uWrDepthFar.value = 0;
      uniforms.uWrFlipV.value = true;
      this.probeMode = DepthDecodeMode.SpecRaw;
      uniforms.uWrDecode.value = this.probeMode;
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
   * Publish `normDepthBufferFromNormView` into one stereo slot. A runtime that
   * hands over the identity stub (the emulator does) gets the plain UV
   * convention instead, so a no-op matrix is never applied to already-correct
   * UVs. Each eye owns its selection flag, so an identity/missing transform
   * cannot invalidate the other eye's valid matrix.
   */
  private publishTransform(info: XRWebGLDepthInformation | XRCPUDepthInformation, viewId: number): void {
    const uniforms = depthOcclusionUniforms;
    if (viewId < 0 || viewId > 1) return;
    const transform = info.normDepthBufferFromNormView;
    if (transform == null) {
      uniforms.uWrUseMatrix.value[viewId] = 0;
      return;
    }
    const matrix = transform.matrix;
    uniforms.uWrUseMatrix.value[viewId] = isIdentityMatrix(matrix) ? 0 : 1;
    const target = uniforms.uWrDepthFromView.value;
    for (let index = 0; index < 16; index += 1) target[viewId * 16 + index] = matrix[index] ?? 0;
  }

  /** Texel accessor kind the injected shaders must declare for this session. */
  private textureKind(session: XRSession): DepthTextureKind {
    // Every GPU format is a float-sampled texture (R32F on the emulator,
    // normalized depth16 on the headset); only CPU 16-bit entries are packed.
    if (session.depthUsage === 'gpu-optimized') return 'scalar';
    return session.depthDataFormat === 'float32' ? 'scalar' : 'packed16';
  }

  /**
   * Interpretation this runtime is expected to use, before calibration. A
   * float32 GPU image without the Meta-only near metadata is spec-encoded
   * (raw * rawValueToMeters), so it starts at SpecRaw; the near-dependent
   * encodings still require depthNear upstream.
   */
  private defaultDecode(session: XRSession, depthNear: number): number {
    if (session.depthUsage !== 'gpu-optimized') return DepthDecodeMode.SpecRaw;
    if (session.depthDataFormat === 'float32') {
      return depthNear > 0 ? DepthDecodeMode.InverseUnit : DepthDecodeMode.SpecRaw;
    }
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
      // A re-created texture wrapper means a new image shape: uncalibrated
      // again, with the shader already reset to the session fallback.
      this.calibratedMode = null;
      this.probeMode = DepthDecodeMode.SpecRaw;
      depthOcclusionUniforms.uWrDecode.value = this.probeMode;
      depthOcclusionUniforms.uWrUseMatrix.value.fill(0);
    }
  }

  /**
   * Sample the live depth image, check whether the decoding the shaders use is
   * the right one and log a control value. Runs on the first depth frame and
   * then every `PROBE_INTERVAL_FRAMES` frames; the readback is a small stall,
   * which is why it is not per-frame. CPU buffers have specified semantics,
   * so the probe only reports what it saw there and never changes the
   * published mode; GPU encodings are calibrated against the live samples.
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
    const isCpu = session.depthUsage !== 'gpu-optimized';

    let resolved = false;
    if (!isCpu) {
      // Near-dependent decodings are only candidates when the session
      // supplied the near plane; without it a spec-encoded image must keep
      // SpecRaw.
      const candidates = [this.defaultDecode(session, depthNear)];
      for (const mode of [DepthDecodeMode.SpecRaw, DepthDecodeMode.WindowDepth, DepthDecodeMode.WindowDepthReversed, DepthDecodeMode.InverseUnit]) {
        if (mode !== DepthDecodeMode.SpecRaw && !(depthNear > 0)) continue;
        if (!candidates.includes(mode)) candidates.push(mode);
      }
      for (const mode of candidates) {
        let plausible = 0;
        for (const raw of samples) {
          const meters = decodeSample(mode, raw, rawToMeters, depthNear, depthFar);
          if (meters >= PLAUSIBLE_MIN_M && meters <= PLAUSIBLE_MAX_M) plausible += 1;
        }
        if (plausible / samples.length >= PLAUSIBLE_SHARE) {
          // Record the calibration separately from the published mode: a
          // resolved SpecRaw stays resolved across later uploads.
          this.calibratedMode = mode;
          this.probeMode = mode;
          depthOcclusionUniforms.uWrDecode.value = mode;
          resolved = true;
          break;
        }
      }
      // Nothing qualified: fall back to the per-format default without
      // recording it as calibrated, and say so in the log.
      if (!resolved) {
        this.probeMode = this.defaultDecode(session, depthNear);
        depthOcclusionUniforms.uWrDecode.value = this.probeMode;
      }
    }

    const liveMode = this.probeMode;
    const center = samples[Math.floor(samples.length / 2)] ?? 0;
    const decoded = decodeSample(liveMode, center, rawToMeters, depthNear, depthFar);
    const sorted = [...samples].sort((left, right) => left - right);
    const min = sorted[0] ?? 0;
    const max = sorted[sorted.length - 1] ?? 0;
    const textureName = TEXTURE_SHAPES[this.probeTextureShape] ?? 'unknown';
    const normalized = samples.every((raw) => raw > 0 && raw <= 1);
    console.info(
      `[weather-room] depth probe: format=${session.depthDataFormat ?? 'unknown'} tex=${textureName} ` +
        `normalized=${normalized ? 'yes' : 'no'} decode=${DECODE_NAMES[liveMode] ?? liveMode} ` +
        `matrix=${depthOcclusionUniforms.uWrUseMatrix.value.join('/')} ` +
        `raw[center]=${center} -> ${decoded.toFixed(2)}m ` +
        `raw[min..max]=${min}..${max} -> ${decodeSample(liveMode, min, rawToMeters, depthNear, depthFar).toFixed(2)}` +
        `..${decodeSample(liveMode, max, rawToMeters, depthNear, depthFar).toFixed(2)}m ` +
        `resolved=${resolved ? 'yes' : 'no'}` +
        `${isCpu ? ' cpu=fixed' : ''}`,
    );
  }

  /**
   * Raw depth samples at the probe positions, in the same units the shader's
   * float sampler returns. The CPU path reads them straight from the WebXR
   * buffer; the GPU path samples the same depth array texture the shader
   * reads into a color staging target and reads that back.
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
   * Read depth samples back from the GPU image by drawing a tiny quad that
   * samples the depth array texture at the probe UVs into a small color
   * staging target, then reading that color target. GLES3 readPixels cannot
   * read a depth attachment at all, and a failed color attachment left bound
   * makes the framebuffer incomplete; the staging target is always a complete
   * color framebuffer, so neither failure mode applies. RGBA/FLOAT is used
   * when the float color-buffer extension allows it, otherwise
   * RGBA/UNSIGNED_BYTE with the raw value in the R channel — at 8-bit
   * precision, so the probe on that path is a coarse calibration signal, not
   * a measurement. Nothing is left bound and three's cached state is reset.
   */
  private readRawTexels(info: XRWebGLDepthInformation): number[] | null {
    const context = this.renderer.getContext();
    // three r181 and IWSDK are WebGL2-only, and this readback needs the WebGL2
    // surface (array samplers, float color targets), so narrow once here
    // instead of sprinkling casts over every constant below.
    if (!(context instanceof WebGL2RenderingContext)) return null;
    const gl = context;
    const previousTarget = this.renderer.getRenderTarget();
    try {
      const program = this.probeProgram(gl);
      if (program == null) return null;
      // Prefer a float staging target (exact raw values); without the float
      // color-buffer extension — or when the float target cannot be completed —
      // fall back to an 8-bit target (coarse values).
      let floatTarget = gl.getExtension('EXT_color_buffer_float') != null;
      let target = this.probeTarget(gl, floatTarget);
      if (target == null && floatTarget) {
        floatTarget = false;
        target = this.probeTarget(gl, false);
      }
      if (target == null) return null;
      const layer = Math.max(0, info.imageIndex ?? 0);
      const probeUv = new Float32Array(PROBE_COLUMNS.length * 2);
      const coordinates = probeCoordinates(info.width, info.height);
      for (let index = 0; index < coordinates.length; index += 1) {
        const coordinate = coordinates[index];
        probeUv[index * 2] = ((coordinate?.[0] ?? 0) + 0.5) / Math.max(info.width, 1);
        probeUv[index * 2 + 1] = ((coordinate?.[1] ?? 0) + 0.5) / Math.max(info.height, 1);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
      gl.viewport(0, 0, PROBE_COLUMNS.length, 1);
      // Staging overwrites raw samples; it never inherits additive weather
      // blending, depth/stencil tests, scissor or a partial color mask.
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.colorMask(true, true, true, true);
      gl.useProgram(program.program);
      gl.uniform2fv(program.probeUv, probeUv);
      gl.uniform1i(program.depthLayer, layer);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, info.texture);
      gl.uniform1i(program.depthArray, 0);
      gl.bindVertexArray(program.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const samples: number[] = [];
      if (floatTarget) {
        const texels = new Float32Array(PROBE_COLUMNS.length * 4);
        gl.readPixels(0, 0, PROBE_COLUMNS.length, 1, gl.RGBA, gl.FLOAT, texels);
        if (gl.getError() !== gl.NO_ERROR) return null;
        for (let index = 0; index < PROBE_COLUMNS.length; index += 1) {
          const raw = texels[index * 4] ?? 0;
          if (raw > 0) samples.push(raw);
        }
        if (samples.length === 0) return null;
        this.probeTextureShape = 'colorFloat';
        return samples;
      }
      const texels = new Uint8Array(PROBE_COLUMNS.length * 4);
      gl.readPixels(0, 0, PROBE_COLUMNS.length, 1, gl.RGBA, gl.UNSIGNED_BYTE, texels);
      if (gl.getError() !== gl.NO_ERROR) return null;
      for (let index = 0; index < PROBE_COLUMNS.length; index += 1) {
        const raw = (texels[index * 4] ?? 0) / 255;
        if (raw > 0) samples.push(raw);
      }
      if (samples.length === 0) return null;
      this.probeTextureShape = 'colorByte';
      return samples;
    } catch (error) {
      console.warn('[weather-room] depth probe unavailable on this runtime', error);
      return null;
    } finally {
      gl.bindVertexArray(null);
      // Reset the renderer's caches after raw GL work, then restore its
      // actual XR target. Restoring only the framebuffer before resetState
      // loses the current immersive frame.
      this.renderer.resetState();
      this.renderer.setRenderTarget(previousTarget);
    }
  }

  /**
   * Lazily compile the probe blit: a fullscreen triangle strip whose x
   * selects the probe sample and whose fragment shader writes the sampled
   * raw depth into R (RGBA so the target is always a readable color pair).
   * The texture size lookup snaps each probe UV to its texel center, so the
   * sample matches the texel the occlusion shader would filter.
   */
  private probeProgram(
    gl: WebGL2RenderingContext,
  ): NonNullable<DepthOcclusionSystem['probeBlit']> | null {
    if (this.probeBlit != null) return this.probeBlit;
    const vertex = gl.createShader(gl.VERTEX_SHADER);
    const fragment = gl.createShader(gl.FRAGMENT_SHADER);
    const program = vertex != null && fragment != null ? gl.createProgram() : null;
    if (vertex == null || fragment == null || program == null) {
      if (vertex != null) gl.deleteShader(vertex);
      if (fragment != null) gl.deleteShader(fragment);
      if (program != null) gl.deleteProgram(program);
      return null;
    }
    gl.shaderSource(vertex, `#version 300 es
layout(location = 0) in vec2 position;
out vec2 quadX;
void main() {
  quadX = vec2(position.x * 0.5 + 0.5, 1.0);
  gl_Position = vec4(position, 0.0, 1.0);
}`);
    gl.shaderSource(fragment, `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray depthArray;
uniform vec2 probeUv[${PROBE_COLUMNS.length}];
uniform int depthLayer;
in vec2 quadX;
layout(location = 0) out vec4 staged;
void main() {
  int probe = int(floor(quadX.x * float(${PROBE_COLUMNS.length})));
  vec2 uv = probeUv[probe];
  vec2 size = vec2(textureSize(depthArray, 0).xy);
  uv = (floor(uv * size) + 0.5) / size;
  float raw = texture(depthArray, vec3(uv, float(depthLayer))).r;
  staged = vec4(raw, 0.0, 0.0, 1.0);
}`);
    gl.compileShader(vertex);
    gl.compileShader(fragment);
    if (
      gl.getShaderParameter(vertex, gl.COMPILE_STATUS) !== true ||
      gl.getShaderParameter(fragment, gl.COMPILE_STATUS) !== true
    ) {
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      gl.deleteProgram(program);
      return null;
    }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      gl.deleteProgram(program);
      return null;
    }
    const quad = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (quad == null || vao == null) {
      if (quad != null) gl.deleteBuffer(quad);
      if (vao != null) gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      return null;
    }
    const previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(previousVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.probeBlit = {
      program,
      quad,
      vao,
      probeUv: gl.getUniformLocation(program, 'probeUv'),
      depthArray: gl.getUniformLocation(program, 'depthArray'),
      depthLayer: gl.getUniformLocation(program, 'depthLayer'),
    };
    return this.probeBlit;
  }

  /**
   * Lazily create the probe color target sized to the probe count (one texel
   * per sample). The target outlives the probe so the ~5 s cadence never
   * reallocates; the float and byte shapes are cached separately.
   */
  private probeTarget(
    gl: WebGL2RenderingContext,
    floatTarget: boolean,
  ): { framebuffer: WebGLFramebuffer; texture: WebGLTexture } | null {
    const cached = floatTarget ? this.probeTargetFloat : this.probeTargetByte;
    if (cached != null) return cached;
    const width = Math.max(PROBE_COLUMNS.length, 1);
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (texture == null || framebuffer == null) {
      if (texture != null) gl.deleteTexture(texture);
      if (framebuffer != null) gl.deleteFramebuffer(framebuffer);
      return null;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (floatTarget) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 1, 0, gl.RGBA, gl.FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.getError() !== gl.NO_ERROR || gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const target = { framebuffer, texture };
    if (floatTarget) {
      this.probeTargetFloat = target;
    } else {
      this.probeTargetByte = target;
    }
    return target;
  }

  /**
   * A stopped system must not leave the last frame's occlusion live. `stop()`
   * is the runtime off switch for this system (the ECS pause API calls it), and
   * paused has to mean "no occlusion", not "frozen at the last value". The
   * sampler uniform is cleared too: three keeps binding it while the branch is
   * compiled in, and the opaque XR texture it pointed at is invalid outside
   * its session. With the uniform null the shader still compiles the branch
   * but samples nothing, and uWrEnabled=false skips the test entirely.
   */
  stop(): void {
    super.stop();
    depthOcclusionUniforms.uWrEnabled.value = false;
    this.releaseTextures();
  }

  /** Free every GL handle this system owns so none outlives the system. */
  destroy(): void {
    this.releaseTextures();
    const context = this.renderer.getContext();
    if (context instanceof WebGL2RenderingContext) {
      const gl = context;
      for (const target of [this.probeTargetFloat, this.probeTargetByte]) {
        if (target != null) {
          gl.deleteFramebuffer(target.framebuffer);
          gl.deleteTexture(target.texture);
        }
      }
      if (this.probeBlit != null) {
        gl.deleteBuffer(this.probeBlit.quad);
        gl.deleteVertexArray(this.probeBlit.vao);
        gl.deleteProgram(this.probeBlit.program);
      }
    }
    this.probeTargetFloat = null;
    this.probeTargetByte = null;
    this.probeBlit = null;
    super.destroy();
  }

  private releaseTextures(): void {
    this.textures?.dispose();
    this.textures = null;
    depthOcclusionUniforms.uWrDepthArray.value = null;
  }
}
