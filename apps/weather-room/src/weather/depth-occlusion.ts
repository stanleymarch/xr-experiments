import { Vector2, Vector3, Vector4 } from '@iwsdk/core';
import type { ShaderMaterial, WebGLProgramParametersWithUniforms } from '@iwsdk/core';

/** Stock depth injection expects MeshStandardMaterial anchors. Custom weather
 * shaders expose those anchors while retaining their own color and alpha. */
const WHITE = new Vector3(1, 1, 1);
const wiredMaterials = new WeakSet<ShaderMaterial>();
const POSITION_ASSIGNMENT = /gl_Position\s*=\s*[^;]+;/gu;
const VERTEX_DEPTH_OVERRIDE = '\n#include <fog_vertex>\nvOcclusionViewDepth = gl_Position.w;';
const DIFFUSE_ANCHOR = 'vec4 diffuseColor = vec4( diffuse, opacity );';
const STEREO_FRAGMENT_PREFIX = /* glsl */ `
uniform int weatherRoomDepthViewId;
#ifndef VIEW_ID
#define VIEW_ID weatherRoomDepthViewId
uniform vec4 weatherRoomDepthViewport;
uniform vec2 weatherRoomDepthBufferSize;
// Stock depth divides gl_FragCoord by the full drawing-buffer size.
// For ArrayCamera sub-draws, adapt that input to eye-local coordinates.
vec4 weatherRoomDepthFragmentCoord() {
  vec2 uv = (gl_FragCoord.xy - weatherRoomDepthViewport.xy) / weatherRoomDepthViewport.zw;
  return vec4(uv * weatherRoomDepthBufferSize, gl_FragCoord.zw);
}
#define gl_FragCoord weatherRoomDepthFragmentCoord()
#endif
`;

export function enableDepthOcclusion(material: ShaderMaterial): void {
  if (wiredMaterials.has(material)) return;
  wiredMaterials.add(material);
  material.uniforms.diffuse = { value: WHITE };
  material.uniforms.opacity = { value: 1 };
  const viewport = new Vector4(0, 0, 1, 1);
  const bufferSize = new Vector2(1, 1);
  material.uniforms.weatherRoomDepthViewport = { value: viewport };
  material.uniforms.weatherRoomDepthBufferSize = { value: bufferSize };

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    exposeStockShaderAnchors(shader);
  };
  const previousRender = material.onBeforeRender;
  material.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
    previousRender.call(material, renderer, scene, camera, geometry, object, group);
    renderer.getCurrentViewport(viewport);
    renderer.getDrawingBufferSize(bufferSize);
    const cameras = renderer.xr.getCamera().cameras;
    let eye = 0;
    for (let i = 0; i < cameras.length; i += 1) {
      if (cameras[i] === camera) {
        eye = i;
        break;
      }
    }
    material.uniforms.weatherRoomDepthViewId.value = eye;
  };
  material.uniforms.weatherRoomDepthViewId = { value: 0 };
  material.needsUpdate = true;
}

function exposeStockShaderAnchors(shader: WebGLProgramParametersWithUniforms): void {
  const positions = [...shader.vertexShader.matchAll(POSITION_ASSIGNMENT)];
  const lastPosition = positions.at(-1);
  if (lastPosition?.index == null) {
    throw new Error('[weather-room] stock depth occlusion requires a gl_Position assignment');
  }
  const positionEnd = lastPosition.index + lastPosition[0].length;
  shader.vertexShader =
    '#include <common>\n' +
    shader.vertexShader.slice(0, positionEnd) +
    VERTEX_DEPTH_OVERRIDE +
    shader.vertexShader.slice(positionEnd);

  // The stock path measures modelViewMatrix * position, which is the entity
  // origin for InstancedMesh. The override after its fog anchor instead reads
  // the final clip-space w, after instance transforms and custom displacement.
  const mainStart = shader.fragmentShader.indexOf('void main()');
  const mainEnd = shader.fragmentShader.lastIndexOf('}');
  if (mainStart < 0 || mainEnd <= mainStart) {
    throw new Error('[weather-room] stock depth occlusion requires a fragment main function');
  }
  const bodyStart = shader.fragmentShader.indexOf('{', mainStart) + 1;
  shader.fragmentShader =
    STEREO_FRAGMENT_PREFIX +
    'uniform vec3 diffuse;\nuniform float opacity;\n' +
    shader.fragmentShader.slice(0, bodyStart) +
    `\n${DIFFUSE_ANCHOR}\n` +
    shader.fragmentShader.slice(bodyStart, mainEnd) +
    '\ngl_FragColor.a *= diffuseColor.a;\n' +
    shader.fragmentShader.slice(mainEnd);
}
