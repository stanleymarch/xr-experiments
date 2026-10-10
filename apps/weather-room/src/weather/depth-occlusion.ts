/**
 * WEATHER//ROOM real-world depth occlusion for the app's custom shader
 * materials.
 *
 * Why this exists next to the framework's `DepthOccludable`: the framework
 * injects its depth test into three's built-in material shaders (it anchors on
 * `#include <fog_vertex>`, `uniform vec3 diffuse;` and
 * `vec4 diffuseColor = vec4( diffuse, opacity );`) and derives the virtual
 * fragment depth from `modelViewMatrix * vec4(position, 1.0)`. For an
 * `InstancedMesh` that expression is the mesh origin, identical for every
 * instance, so every instanced weather visual would be occluded as one block.
 * The weather effects are raw `ShaderMaterial`s, where the injection is a
 * silent no-op. This module injects an equivalent but instance-correct test
 * through `onBeforeCompile`.
 *
 * How the test is built:
 * - Vertex: after the shader's own `gl_Position` assignment we export
 *   `gl_Position.xyw` as a varying. That is already the instance, curvature and
 *   billboard result of whatever math the shader does, and perspective-correct
 *   interpolation of `xyw` gives the exact fragment clip position, so
 *   `xyw.z` is the fragment's view depth (`w = -z_view` for a perspective
 *   projection) and `xyw.xy / xyw.z` its normalized device coordinates.
 * - Fragment: map the fragment to depth-image UVs, read the raw depth texel,
 *   decode it to meters and fade the fragment out where a real surface is
 *   closer.
 *
 * What the depth texture actually is, learned on hardware: every GPU format is
 * read through a plain float `sampler2DArray`. The spec's format table lists
 * R16UI for `unsigned-short`, but that entry describes the CPU-array shape of
 * the data; Meta's gpu-optimized `unsigned-short` arrives as a *normalized*
 * GL_DEPTH_COMPONENT16 texture (confirmed on Quest 3, where an integer sampler
 * is rejected with "internal format GL_DEPTH_COMPONENT16 is not compatible with
 * sampler type GL_UNSIGNED_INT_SAMPLER_2D_ARRAY" on every draw). So the sampler
 * never changes on the GPU path and only the *decoding* does. The one
 * compile-time difference that remains is the CPU path, where this module packs
 * 16-bit entries into an RG texture itself and the shader has to reassemble the
 * two bytes; that is the only reason a sampler-independent "texture kind" (and
 * its program cache key) still exists.
 *
 * Decoding: `uWrDecode` selects between the interpretations shipped runtimes
 * actually use, every division guarded against zero and a raw value of 0 always
 * meaning "invalid depth, keep the fragment". The owning system calibrates the
 * choice against the live image and logs it.
 *
 * Depth-image coordinates: the spec's source of truth is
 * `normDepthBufferFromNormView`, which maps normalized view coordinates (origin
 * top-left, y growing downward) to normalized depth-buffer coordinates. When
 * the runtime supplies a real transform the shader uses it; when it supplies
 * the identity stub (as the emulator does) the shader falls back to the plain
 * convention instead of applying a no-op matrix to already-correct UVs.
 *
 * The uniforms are module singletons shared by every occluded material, so one
 * value update per frame serves all of them. `DepthOcclusionSystem` owns them;
 * with no XR depth available `uWrEnabled` stays false and every material
 * renders exactly as it did before this module existed.
 */

import { Matrix4 } from '@iwsdk/core';
import type { ShaderMaterial, Texture, WebGLProgramParametersWithUniforms } from '@iwsdk/core';

/**
 * Real-depth margin in meters that keeps a fragment visible. WebXR depth is a
 * coarse, smoothed buffer; without the margin, surfaces the app itself snapped
 * to (sampled floors, tables) would flicker against their own samples.
 */
const DEPTH_BIAS_M = 0.03;
/** Fade-in distance in meters behind the real surface; avoids a hard silhouette. */
const DEPTH_FADE_M = 0.06;
/** Occlusion factor at or below which the fragment is discarded outright. */
const DISCARD_BELOW = 0.02;

/**
 * How the depth texels are laid out. `scalar` reads the red channel as-is
 * (every GPU format, and float32 CPU data); `packed16` reassembles the two
 * bytes of a 16-bit entry from the RG texture this app builds for CPU depth
 * data, where red holds the least significant byte per the spec.
 */
export type DepthTextureKind = 'scalar' | 'packed16';

/** Mutable compile-time input: the accessor the injected shaders declare. */
const textureKindState: { kind: DepthTextureKind } = { kind: 'scalar' };

/**
 * Single shared uniform block; see the module comment. `uWrDepthFromView` is a
 * flat mat4[2] (`normDepthBufferFromNormView` per stereo eye) because three
 * uploads matrix arrays from a flat Float32Array.
 */
export const depthOcclusionUniforms = {
  uWrDepthArray: { value: null as Texture | null },
  uWrDepthFromView: { value: new Float32Array(32) },
  uWrRawToMeters: { value: 0.001 },
  uWrDepthNear: { value: 0 },
  uWrDepthFar: { value: 0 },
  /** Interpretation of the raw texel; see DepthDecodeMode in the system. */
  uWrDecode: { value: 0 },
  /**
   * Stereo eye for this draw (0 left, 1 right). Read only when three did not
   * define VIEW_ID (the ArrayCamera per-eye fallback); multiview programs keep
   * using three's builtin. Written per draw from `onBeforeRender` below.
   */
  uWrEye: { value: 0 },
  /** Transform selection is independent for each stereo eye. */
  uWrUseMatrix: { value: new Int32Array(2) },
  /** Legacy convention only: flip the depth UV vertically (CPU images). */
  uWrFlipV: { value: false },
  uWrEnabled: { value: false },
};

const GL_POSITION_ASSIGNMENT = /gl_Position\s*=\s*[^;]+;/u;
const FRAGMENT_OUTPUT = 'gl_FragColor =';
const TONEMAPPING_INCLUDE = '#include <tonemapping_fragment>';

const VERTEX_PRELUDE = /* glsl */ `varying vec3 vWrClipXyw;
`;

/** Texel accessor for the active layout. */
function rawDepthAccessor(kind: DepthTextureKind): string {
  if (kind === 'packed16') {
    return /* glsl */ `uniform sampler2DArray uWrDepthArray;
float wrRawDepth(vec2 uv) {
  vec2 packedDepth = texture(uWrDepthArray, vec3(uv, float(WR_VIEW_ID))).rg;
  // Red holds the least significant byte (WebXR depth-sensing table).
  return dot(packedDepth, vec2(255.0, 65280.0));
}
`;
  }
  return /* glsl */ `uniform sampler2DArray uWrDepthArray;
float wrRawDepth(vec2 uv) {
  return texture(uWrDepthArray, vec3(uv, float(WR_VIEW_ID))).r;
}
`;
}

const FRAGMENT_UNIFORMS = /* glsl */ `varying vec3 vWrClipXyw;
uniform mat4 uWrDepthFromView[2];
uniform float uWrRawToMeters;
uniform float uWrDepthNear;
uniform float uWrDepthFar;
uniform int uWrDecode;
uniform int uWrEye;
uniform bool uWrUseMatrix[2];
uniform bool uWrFlipV;
uniform bool uWrEnabled;
#ifdef VIEW_ID
// Multiview program: three defines VIEW_ID as gl_ViewID_OVR.
#define WR_VIEW_ID VIEW_ID
#else
// ArrayCamera per-eye fallback: three defines no VIEW_ID, so each draw reads
// the eye index the onBeforeRender hook below wrote for that draw.
#define WR_VIEW_ID uWrEye
#endif
`;

const OCCLUSION_HELPERS = /* glsl */ `
// Depth-image UVs for this fragment. Real runtime transform first; the plain
// convention is the fallback for runtimes that hand over an identity stub.
vec2 wrDepthUv() {
  vec2 ndc = vWrClipXyw.xy / max(vWrClipXyw.z, 0.000001);
  if (uWrUseMatrix[int(WR_VIEW_ID)]) {
    // Spec normalized view coordinates: origin top-left, y growing downward.
    vec2 normView = vec2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
    return (uWrDepthFromView[int(WR_VIEW_ID)] * vec4(normView, 0.0, 1.0)).xy;
  }
  vec2 uv = ndc * 0.5 + 0.5;
  return uWrFlipV ? vec2(uv.x, 1.0 - uv.y) : uv;
}

// Linearize a [0,1] window-depth value (0 at the near plane, 1 at the far
// plane) under a standard perspective projection. Window depth d is NDC depth
// 2d-1, so with the projection's depth coefficients the view distance is
// near*far/(far-d*(far-near)). The guard is a pure numerical epsilon.
float wrWindowDepth(float windowDepth, float near, float far) {
  float range = max(far - near, 0.000001);
  return (near * far) / max(far - windowDepth * range, 0.000001);
}

// Raw texel value -> meters. The guards are pure numerical epsilons, never
// range clamps; a raw value of 0 means "invalid depth" per the spec and must
// leave the fragment visible.
float wrDecodeDepth(float raw) {
  if (raw <= 0.0) return 0.0;
  if (uWrDecode == 1) {
    return wrWindowDepth(raw, uWrDepthNear, uWrDepthFar);
  }
  if (uWrDecode == 2) {
    return wrWindowDepth(1.0 - raw, uWrDepthNear, uWrDepthFar);
  }
  if (uWrDecode == 3) {
    return uWrRawToMeters * uWrDepthNear / max(1.0 - raw, 0.000001);
  }
  if (uWrDecode == 4) {
    return raw * 0.001;
  }
  return raw * max(uWrRawToMeters, 0.0000001);
}
`;

const OCCLUSION_TEST = /* glsl */ `  float wrOcclusion = 1.0;
  if (uWrEnabled && vWrClipXyw.z > 0.0) {
    vec2 wrUv = wrDepthUv();
    if (wrUv.x >= 0.0 && wrUv.x <= 1.0 && wrUv.y >= 0.0 && wrUv.y <= 1.0) {
      float wrRealDepth = wrDecodeDepth(wrRawDepth(wrUv));
      if (wrRealDepth > 0.0) {
        wrOcclusion = smoothstep(
          0.0,
          ${DEPTH_FADE_M.toFixed(3)},
          wrRealDepth - vWrClipXyw.z + ${DEPTH_BIAS_M.toFixed(3)}
        );
      }
    }
  }
  if (wrOcclusion < ${DISCARD_BELOW.toFixed(2)}) discard;
`;

/** Materials already wired, so a second call cannot inject the hooks twice. */
const occludedMaterials = new Set<ShaderMaterial>();

/**
 * Switch the texel accessor the injected shaders declare. Materials already
 * compiled are flagged for recompilation, which is what happens when the XR
 * session reports a format (or the texture probe identifies one) after the
 * effects were first built. Because three keys its program cache on
 * `customProgramCacheKey()`, that key carries the kind too — see
 * `enableDepthOcclusion`.
 */
export function setDepthTextureKind(kind: DepthTextureKind): void {
  if (textureKindState.kind === kind) return;
  textureKindState.kind = kind;
  for (const material of occludedMaterials) material.needsUpdate = true;
}

/** The texel accessor kind currently baked into new shaders. */
export function depthTextureKind(): DepthTextureKind {
  return textureKindState.kind;
}

/**
 * Make one custom `ShaderMaterial` fade out behind real-world geometry.
 * The material keeps its own shader code; only the depth test is injected.
 * Safe to call before the material is first rendered (the usual case) and
 * idempotent per material.
 */
export function enableDepthOcclusion(material: ShaderMaterial): void {
  if (occludedMaterials.has(material)) return;
  // The anchor check runs here, on the material's own sources. For a
  // ShaderMaterial three hands those exact strings to `onBeforeCompile`, so a
  // material that passes this check cannot half-inject a program later.
  if (
    !GL_POSITION_ASSIGNMENT.test(material.vertexShader) ||
    !material.fragmentShader.includes(FRAGMENT_OUTPUT)
  ) {
    console.warn(
      '[weather-room] depth occlusion skipped: shader has no gl_Position assignment or gl_FragColor output',
    );
    return;
  }
  occludedMaterials.add(material);
  Object.assign(material.uniforms, depthOcclusionUniforms);
  // three keys its program cache on `customProgramCacheKey()`, which for a
  // material with `onBeforeCompile` is that callback's source text — a string
  // that cannot see the texel accessor this module bakes in at compile time. The
  // cache key therefore has to carry the kind, or a material compiled for one
  // accessor could be handed the cached program of another. The previous
  // implementation is chained, so other injections into the same material keep
  // contributing to the key.
  const previousCacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () =>
    `${previousCacheKey()}::depth-tex-${textureKindState.kind}`;
  const previous = material.onBeforeCompile as
    | ((shader: WebGLProgramParametersWithUniforms, renderer: unknown) => void)
    | undefined;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    injectDepthOcclusion(shader);
  };
  // ArrayCamera per-eye fallback path only (multiview programs ignore uWrEye:
  // WR_VIEW_ID is VIEW_ID there). The draw's camera is the sub-camera three is
  // rendering for; its position in the XR ArrayCamera's .cameras array, ordered
  // [left, right], is the eye. This runs before three uploads uniforms for the
  // draw, and three re-uploads on camera and material changes, so the value the
  // shader reads is always this draw's eye. Outside XR the camera list is empty
  // and the eye stays 0, which is a no-op while uWrEnabled is false.
  const previousRender = material.onBeforeRender;
  material.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
    previousRender.call(material, renderer, scene, camera, geometry, object, group);
    const eye = renderer.xr.getCamera().cameras.findIndex((sub) => sub === camera);
    // Only two depth-transform slots exist, so anything unexpected is the left eye.
    depthOcclusionUniforms.uWrEye.value = eye >= 0 && eye < 2 ? eye : 0;
  };
  material.needsUpdate = true;
}

/**
 * Inject the depth test into one shader pair. The caller has already checked
 * the anchors; the varying is only ever declared together with the write that
 * feeds it, so no program can be left with an unwritten varying.
 */
function injectDepthOcclusion(shader: WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = (VERTEX_PRELUDE + shader.vertexShader).replace(
    GL_POSITION_ASSIGNMENT,
    (match) => `${match}\n  vWrClipXyw = gl_Position.xyw;`,
  );

  shader.fragmentShader = FRAGMENT_UNIFORMS + rawDepthAccessor(textureKindState.kind) + OCCLUSION_HELPERS + shader.fragmentShader.replace(
    FRAGMENT_OUTPUT,
    `${OCCLUSION_TEST}  ${FRAGMENT_OUTPUT}`,
  );

  // Soft edge: scale the alpha the fragment already wrote. Shaders without the
  // tone-mapping hook keep the binary discard-only result, which is still
  // correct — just harder edged.
  if (shader.fragmentShader.includes(TONEMAPPING_INCLUDE)) {
    shader.fragmentShader = shader.fragmentShader.replace(
      TONEMAPPING_INCLUDE,
      `gl_FragColor.a *= wrOcclusion;\n  ${TONEMAPPING_INCLUDE}`,
    );
  }
}

const IDENTITY = new Matrix4();

/** Identity test for a column-major 4x4 matrix, used to spot a stub transform. */
export function isIdentityMatrix(matrix: Float32Array): boolean {
  for (let index = 0; index < 16; index += 1) {
    if (Math.abs(matrix[index] - IDENTITY.elements[index]) > 1e-6) return false;
  }
  return true;
}
