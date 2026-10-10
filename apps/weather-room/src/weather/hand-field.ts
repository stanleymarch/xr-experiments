/**
 * WEATHER//ROOM hand push field: shared capsule uniforms and the vertex
 * injection that lets a tracked hand part the weather.
 *
 * Problem this solves: the hand occluder (`systems/hand-occluder.ts`) already
 * stops rain from *rendering behind* a hand by cutting the depth buffer, but
 * the particles that cross the hand's volume are simply sliced — the field
 * reads as a hole, not as something a hand moves through. This module adds the
 * missing half: a capsule SDF field (2 hands x palm + forearm) that *pushes*
 * weather particles out of the hand's volume along the surface normal and dims
 * them by how deep they were, so streaks and motes visibly sweep around the
 * hand. No CPU physics: the capsules are 8 vec4 uniforms and the push happens
 * in each weather layer's own vertex shader.
 *
 * How the injection works (same `onBeforeCompile` chaining contract as
 * `depth-occlusion.ts` and `light-shared.ts`):
 * - The gl_Position assignment expression is *wrapped*, not appended to:
 *   `gl_Position = EXPR` becomes `gl_Position = EXPR + projectionMatrix *
 *   viewMatrix * vec4(wrHand.xyz, 0.0)`. Adding a view-space translation
 *   after projection is exact (`P * (v + o) == P * v + P * (o, 0)`), and
 *   because the push is part of the assignment itself, anything that later
 *   reads gl_Position — the depth occlusion's `vWrClipXyw` capture in any
 *   registration order — sees the pushed position.
 * - The alpha dim rides the layer's own `vAlpha` write: a `vec4 wrHand` is
 *   computed right after it (every wired layer writes `vAlpha` before
 *   `gl_Position`; `enableHandField` refuses shaders where that order does
 *   not hold) and the displacement reuses the same value, so one SDF
 *   evaluation serves both effects. No new varyings, no fragment changes.
 * - Names are `wrHand*`-prefixed and unique to this module, so no injection
 *   pair can collide (the redefinition rake depth occlusion and the beam
 *   already avoid by construction).
 *
 * Zero-cost contract: `HandFieldSystem` keeps `uWrHandCount` at 0 when no
 * hand/controller is tracked or outside an XR session. The GLSL then takes an
 * early-out branch (one integer compare), three.js' uniform cache skips the
 * upload because the values stop changing, and no buffer of any kind is read.
 * Layers whose rollout flag is false never call `enableHandField` at all, so
 * their shader sources stay byte-identical to before this module existed.
 */

import type { ShaderMaterial, WebGLProgramParametersWithUniforms } from '@iwsdk/core';

/** Capsule capacity: 2 hands x (palm + forearm). */
export const HAND_FIELD_MAX_CAPSULES = 4;

/**
 * Staged rollout switch, one flag per layer. `false` means the layer's
 * material is never wired: its vertex shader keeps its original source and the
 * hand field costs it exactly nothing. Flip a flag and the injection is live
 * on the next build — no other code changes.
 */
export const HAND_FIELD_LAYERS: Readonly<Record<'rain' | 'dust' | 'wind' | 'snow', boolean>> = {
  // Wave 1: the two layers the hand physically reads best on.
  rain: true,
  dust: true,
  // Implemented, off until wave 1 is verified on hardware.
  wind: false,
  snow: false,
};

/**
 * Single shared uniform block (module singleton, exactly like
 * `depthOcclusionUniforms` and `lightSharedUniforms`): `HandFieldSystem`
 * writes it once per frame and every wired material reads the same values.
 *
 * Packing: capsule `i` occupies slots `2i` and `2i+1` — vec4 A = endpoint A
 * with `.w` = radius, vec4 B = endpoint B with `.w` = the same radius (kept
 * symmetric; `.w` of A is authoritative). That is 4 capsules x 2 vec4 = 128
 * bytes plus one int for the live count; a flat Float32Array works because
 * three uploads vector arrays from flat buffers.
 */
export const handFieldUniforms = {
  uWrHandCapsules: { value: new Float32Array(HAND_FIELD_MAX_CAPSULES * 2 * 4) },
  /** Live capsule count; 0 disables every read in the injected shaders. */
  uWrHandCount: { value: 0 },
};

const HAND_FIELD_PRELUDE = /* glsl */ `uniform vec4 uWrHandCapsules[8];
uniform int uWrHandCount;

// Capsule push field for tracked hands. Tests worldPos against up to
// uWrHandCount capsules: inside the radius the point is displaced onto the
// shell (plus a 1 cm breathing margin so particles do not linger on the rim)
// and dimmed toward 0.15 by its original depth inside the capsule; on the
// shell it is untouched, so the field is continuous across the boundary.
// uWrHandCount == 0 returns a zero displacement with factor 1: one integer
// compare, no loop, no texture reads.
vec4 wrHandField(vec3 worldPos) {
  if (uWrHandCount <= 0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 push = vec3(0.0);
  float fade = 1.0;
  for (int i = 0; i < 4; i++) {
    if (i >= uWrHandCount) break;
    vec4 a = uWrHandCapsules[i * 2];
    vec4 b = uWrHandCapsules[i * 2 + 1];
    vec3 ba = b.xyz - a.xyz;
    float h = clamp(dot(worldPos - a.xyz, ba) / max(dot(ba, ba), 1e-10), 0.0, 1.0);
    vec3 delta = worldPos - (a.xyz + ba * h);
    float dist2 = dot(delta, delta);
    float r = a.w;
    if (dist2 < r * r) {
      float dist = sqrt(dist2);
      // A point exactly on the capsule axis has no defined normal; the guard
      // leaves it unpushed and the dim factor below still applies.
      vec3 n = delta / max(dist, 1e-4);
      push += n * (r - dist + 0.01);
      fade = min(fade, 0.15 + 0.85 * (dist / r));
    }
  }
  return vec4(push, fade);
}
`;

const GL_POSITION_ASSIGNMENT = /gl_Position\s*=\s*[^;]+;/u;
const ALPHA_WRITE = /vAlpha\s*=\s*[^;]+;/u;

/** Materials already wired, so a second call cannot inject the hooks twice. */
const handFieldMaterials = new Set<ShaderMaterial>();

/**
 * Give one custom `ShaderMaterial` the hand push field: the shared capsule
 * uniforms and the vertex-stage SDF. The layer's fragment shader is never
 * touched — the dim factor is folded into the layer's own `vAlpha` varying.
 * Idempotent per material and safe to combine with `enableBeamLighting` and
 * `enableDepthOcclusion` in any order (see the module comment).
 */
export function enableHandField(material: ShaderMaterial): void {
  if (handFieldMaterials.has(material)) return;
  // The anchors are checked here, on the material's own sources, so a
  // material that passes cannot be half-injected later. The alpha write must
  // come before gl_Position because the injected displacement (`wrHand`) is
  // declared at the alpha write and consumed by the position assignment.
  const alphaMatch = ALPHA_WRITE.exec(material.vertexShader);
  const positionMatch = GL_POSITION_ASSIGNMENT.exec(material.vertexShader);
  if (
    alphaMatch == null ||
    positionMatch == null ||
    alphaMatch.index > positionMatch.index
  ) {
    console.warn(
      '[weather-room] hand field skipped: shader needs a vAlpha write before its gl_Position assignment',
    );
    return;
  }
  handFieldMaterials.add(material);
  Object.assign(material.uniforms, handFieldUniforms);
  const previous = material.onBeforeCompile as
    | ((shader: WebGLProgramParametersWithUniforms, renderer: unknown) => void)
    | undefined;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    injectHandField(shader);
  };
  material.needsUpdate = true;
}

/** Inject the capsule SDF into one vertex shader. Anchors are pre-validated. */
function injectHandField(shader: WebGLProgramParametersWithUniforms): void {
  const world = shader.vertexShader.includes('instanceMatrix')
    ? 'modelMatrix * instanceMatrix * vec4(position, 1.0)'
    : 'modelMatrix * vec4(position, 1.0)';
  shader.vertexShader = (HAND_FIELD_PRELUDE + shader.vertexShader)
    .replace(
      ALPHA_WRITE,
      (match) => `${match}
  vec4 wrHand = wrHandField((${world}).xyz);
  vAlpha *= wrHand.w;`,
    )
    .replace(GL_POSITION_ASSIGNMENT, (match) => `${match.slice(0, -1)} + projectionMatrix * viewMatrix * vec4(wrHand.xyz, 0.0);`);
}
