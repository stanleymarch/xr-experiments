/**
 * WEATHER//ROOM shared light-shaft (god-ray) state.
 *
 * One physical source — the modelled sun — drives every weather layer. The
 * beam is the single reason a particle is visible, so rain, wind, snow, the
 * puddle specular and the dust motes all read the same uniforms and the room
 * moves and lights as one body. This module owns that one uniform block and
 * the `onBeforeCompile` injection, mirroring `depth-occlusion.ts`: the layers
 * keep their own shader source and only gain the beam uniforms, a world
 * position varying and two helpers.
 *
 * `LightFieldSystem` (systems/light-field.ts) writes the uniforms once per
 * frame before the layers render; the additive cone it owns is the visible
 * carrier of those same values, so the shaft the viewer sees and the shaft the
 * particles are lit by can never disagree.
 *
 * The uniform block is a module singleton shared by every beam-lit material,
 * so one update per frame serves all of them. With no beam (`uBeamIntensity`
 * 0, e.g. at night) `rBeamGate` collapses to zero and only `rBeamFactor`'s
 * relative 0.45..1.35 brightness contrast survives, which is what keeps rain
 * and wind readable in the dark.
 */

import { Color, Vector3 } from '@iwsdk/core';
import type { ShaderMaterial, WebGLProgramParametersWithUniforms } from '@iwsdk/core';

/**
 * World position of the modelled sun. It is the same point the
 * `DirectionalLightComponent` in `atmosphere.ts` sits at, so the visible
 * shaft, the scene light and the beam uniforms share one origin.
 */
export const SUN_WORLD_POSITION = new Vector3(-4, 6, 2);

/** Sun palette: the ramp both the light shaft and the atmosphere lerp over. */
export const SUN_DAY_COLOR = new Color(0xffe8c4);
export const SUN_NIGHT_COLOR = new Color(0x8fa8d8);

/** Half-angle of the visible shaft, in radians (16 degrees). */
export const BEAM_HALF_ANGLE_RAD = (16 * Math.PI) / 180;
/** Cosine of the half-angle: the cone aperture the layers gate against. */
export const BEAM_COS = Math.cos(BEAM_HALF_ANGLE_RAD);

/**
 * Single shared uniform block. `uBeamDir` points along the light's travel
 * (from the sun toward the room), so `dot(normalize(p - origin), uBeamDir)`
 * approaches 1 for a particle inside the shaft.
 */
export const lightSharedUniforms = {
  uBeamOrigin: { value: SUN_WORLD_POSITION.clone() },
  uBeamDir: { value: SUN_WORLD_POSITION.clone().negate().normalize() },
  uBeamCos: { value: BEAM_COS },
  /** 0 = no shaft (night / heavy overcast), 1 = full daylight through breaks. */
  uBeamIntensity: { value: 0 },
  uBeamColor: { value: SUN_DAY_COLOR.clone() },
};

const BEAM_UNIFORMS = /* glsl */ `uniform vec3 uBeamOrigin;
uniform vec3 uBeamDir;
uniform float uBeamCos;
uniform float uBeamIntensity;
uniform vec3 uBeamColor;
`;

/**
 * Two readings of the same beam:
 * - `rBeamFactor` is the art-directed brightness ratio (0.45 outside the shaft,
 *   1.35 inside), used where the layer must stay readable but gain a glow when
 *   it crosses the light.
 * - `rBeamGate` is the absolute in-shaft presence (0 outside, scaled by the
 *   shaft's own intensity), used where the layer exists only inside the light:
 *   dust motes and snow crystals.
 */
const BEAM_HELPERS = /* glsl */ `
float rBeamFactor(vec3 worldPos) {
  vec3 delta = worldPos - uBeamOrigin;
  float d = dot(delta, uBeamDir) / max(length(delta), 0.0001);
  return mix(0.45, 1.35, smoothstep(uBeamCos, 1.0, d));
}

float rBeamGate(vec3 worldPos) {
  vec3 delta = worldPos - uBeamOrigin;
  float d = dot(delta, uBeamDir) / max(length(delta), 0.0001);
  return uBeamIntensity * smoothstep(uBeamCos - 0.04, uBeamCos + 0.10, d);
}
`;

const GL_POSITION_ASSIGNMENT = /gl_Position\s*=\s*[^;]+;/u;
const FRAGMENT_OUTPUT = 'gl_FragColor =';

const VERTEX_PRELUDE = /* glsl */ `varying vec3 vBeamWorld;
`;

/** Materials already wired, so a second call cannot inject the hooks twice. */
const beamMaterials = new Set<ShaderMaterial>();

/** CPU mirror of `rBeamGate`, for systems that gate instance attributes. */
export function beamGateAt(x: number, y: number, z: number): number {
  const origin = lightSharedUniforms.uBeamOrigin.value;
  const dir = lightSharedUniforms.uBeamDir.value;
  const dx = x - origin.x;
  const dy = y - origin.y;
  const dz = z - origin.z;
  const length = Math.max(1e-4, Math.sqrt(dx * dx + dy * dy + dz * dz));
  const d = (dx * dir.x + dy * dir.y + dz * dir.z) / length;
  const cos = lightSharedUniforms.uBeamCos.value;
  const t = Math.min(1, Math.max(0, (d - (cos - 0.04)) / 0.14));
  const smooth = t * t * (3 - 2 * t);
  return lightSharedUniforms.uBeamIntensity.value * smooth;
}

/**
 * Give one custom `ShaderMaterial` the shared beam: uniforms, the world
 * position varying, and the two helpers available in both shader stages (the
 * vertex stage needs `rBeamGate` because snow scales its instance there).
 * Idempotent per material and safe to combine with `enableDepthOcclusion` in
 * either order — each hook preserves whatever `onBeforeCompile` already held
 * and only appends its own text after the shader's own `gl_Position`.
 */
export function enableBeamLighting(material: ShaderMaterial): void {
  if (beamMaterials.has(material)) return;
  if (
    !GL_POSITION_ASSIGNMENT.test(material.vertexShader) ||
    !material.fragmentShader.includes(FRAGMENT_OUTPUT)
  ) {
    console.warn(
      '[weather-room] light beam skipped: shader has no gl_Position assignment or gl_FragColor output',
    );
    return;
  }
  beamMaterials.add(material);
  Object.assign(material.uniforms, lightSharedUniforms);
  const previous = material.onBeforeCompile as
    | ((shader: WebGLProgramParametersWithUniforms, renderer: unknown) => void)
    | undefined;
  material.onBeforeCompile = (shader, renderer) => {
    previous?.(shader, renderer);
    injectBeam(shader);
  };
  material.needsUpdate = true;
}

/** Inject the beam uniform block, helpers and world-position varying. */
function injectBeam(shader: WebGLProgramParametersWithUniforms): void {
  const world = shader.vertexShader.includes('instanceMatrix')
    ? 'modelMatrix * instanceMatrix * vec4(position, 1.0)'
    : 'modelMatrix * vec4(position, 1.0)';
  shader.vertexShader = (VERTEX_PRELUDE + BEAM_UNIFORMS + BEAM_HELPERS + shader.vertexShader).replace(
    GL_POSITION_ASSIGNMENT,
    (match) => `${match}\n  vBeamWorld = (${world}).xyz;`,
  );
  shader.fragmentShader = `varying vec3 vBeamWorld;\n${BEAM_UNIFORMS}${BEAM_HELPERS}${shader.fragmentShader}`;
}
