/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { SceneUnderstandingSystem, XRMesh, XRPlane, type World } from '@iwsdk/core';

export interface CapturedPhoto {
  dataUrl: string;
  source: 'webcam' | 'quest-camera';
  capturedAt: number;
}

const MAX_SURFACES = 12;
const MAX_POLYGON_POINTS = 256;
const MAX_PHOTO_EDGE = 1024;
const CAPTURE_TIMEOUT_MS = 30_000;
let boundWorld: World | null = null;
let unbind: (() => void) | null = null;
let sessionStartedAt = 0;
let activeCapture: AbortController | null = null;
let status = 'Camera idle: one photo only when explicitly requested';
const listeners = new Set<(status: string) => void>();

function publish(message: string): void {
  status = message;
  for (const listener of listeners) listener(status);
}

export function getPerceptionStatus(): string {
  return status;
}

export function onPerceptionStatus(callback: (status: string) => void): () => void {
  listeners.add(callback);
  callback(status);
  return () => { listeners.delete(callback); };
}

/** No camera permission, scan prompt, background stream, or per-frame callback. */
export function bindPerception(world: World): () => void {
  unbind?.();
  boundWorld = world;
  sessionStartedAt = world.xrSession ? performance.now() : 0;
  // Notify UI on structural changes, not every XR frame. The short startup
  // timer only changes "waiting" to "no scan data"; it never initiates a scan.
  const notifyRoomChanged = () => { publish(status); };
  let startupTimer = world.xrSession ? window.setTimeout(notifyRoomChanged, 3100) : 0;
  const understanding = world.getSystem(SceneUnderstandingSystem);
  const roomSubscriptions = understanding ? [
    understanding.queries.planeEntities.subscribe('qualify', notifyRoomChanged, false),
    understanding.queries.planeEntities.subscribe('disqualify', notifyRoomChanged, false),
    understanding.queries.meshEntities.subscribe('qualify', notifyRoomChanged, false),
    understanding.queries.meshEntities.subscribe('disqualify', notifyRoomChanged, false),
  ] : [];
  const onSessionStart = () => {
    activeCapture?.abort(new Error('Camera capture canceled because the XR session changed; request another photo in the new session'));
    sessionStartedAt = performance.now();
    window.clearTimeout(startupTimer);
    startupTimer = window.setTimeout(notifyRoomChanged, 3100);
    if (!activeCapture) publish('XR session active; camera idle until explicitly requested');
  };
  const onSessionEnd = () => {
    sessionStartedAt = 0;
    window.clearTimeout(startupTimer);
    activeCapture?.abort(new Error('Camera capture canceled because the XR session ended; request another photo outside immersive mode'));
    if (!activeCapture) publish('Desktop mode: room detection inactive; camera idle until requested');
  };
  const onPageHide = () => {
    activeCapture?.abort(new Error('Camera capture canceled because the page closed'));
  };
  world.renderer.xr.addEventListener('sessionstart', onSessionStart);
  world.renderer.xr.addEventListener('sessionend', onSessionEnd);
  window.addEventListener('pagehide', onPageHide);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    world.renderer.xr.removeEventListener('sessionstart', onSessionStart);
    world.renderer.xr.removeEventListener('sessionend', onSessionEnd);
    window.removeEventListener('pagehide', onPageHide);
    window.clearTimeout(startupTimer);
    for (const unsubscribe of roomSubscriptions) unsubscribe();
    if (boundWorld === world) {
      activeCapture?.abort(new Error('Camera capture canceled because perception was disposed'));
      boundWorld = null;
      unbind = null;
    }
  };
  unbind = dispose;
  publish('Camera idle: one photo only when explicitly requested');
  return dispose;
}

function measurement(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'unknown';
}

function label(value: string | null | undefined): string {
  // Labels are browser metadata, not instructions or a visual classification.
  return JSON.stringify((value || 'unlabeled').replace(/[\u0000-\u001f]/g, '').slice(0, 48));
}

/** Build a bounded description only on demand, using IWSDK's current detected entities. */
export function getRoomContext(): string {
  const world = boundWorld;
  if (!world) return 'Room state: unbound. No room observation is available.';
  const session = world.xrSession;
  if (!session) {
    return 'Room state: desktop/non-immersive. WebXR room detection is inactive; no physical room has been observed. Enter mixed reality and grant space-setup access to provide detected geometry.';
  }
  const features = session.enabledFeatures;
  const planesEnabled = features?.includes('plane-detection') ?? false;
  const meshesEnabled = features?.includes('mesh-detection') ?? false;
  if (features && !planesEnabled && !meshesEnabled) {
    return 'Room state: unsupported or not granted. This XR session has neither plane-detection nor mesh-detection enabled. Use a supporting browser/device and grant space-setup access; no room contents are known.';
  }
  const understanding = world.getSystem(SceneUnderstandingSystem);
  if (!understanding) {
    return 'Room state: detection not configured. Enable IWSDK features.sceneUnderstanding and optional XR planeDetection/meshDetection before starting the session. No room contents are known.';
  }
  const planes = understanding.queries.planeEntities.entities;
  const meshes = understanding.queries.meshEntities.entities;
  if (planes.size === 0 && meshes.size === 0) {
    if (performance.now() - sessionStartedAt < 3000) {
      return 'Room state: waiting for initial scan data. WebXR may take several seconds to expose geometry; no room contents are known yet.';
    }
    if (!features) {
      return 'Room state: detection support unknown. The browser exposes neither enabledFeatures nor detected geometry; no scan or room contents can be confirmed.';
    }
    return 'Room state: no scan data. Detection is enabled but no geometry is exposed. Complete or update the headset Room/Space Setup and allow the browser access, then re-enter mixed reality. An empty result is not evidence of an empty room.';
  }
  const lines = [
    `Room state: browser-provided detected geometry (${planes.size} planes, ${meshes.size} meshes).`,
    'Meters; positions are surface origins in the XR tracking reference space, not user-relative distances. Dimensions are local-axis bounds, not object recognition. Labels below are supplied by the browser. In an emulator this data is simulated, not a physical room observation.',
  ];
  let count = 0;
  for (const entity of planes) {
    if (count >= MAX_SURFACES) break;
    const plane = entity.getValue(XRPlane, '_plane') as globalThis.XRPlane | undefined;
    const position = entity.object3D?.position;
    if (!plane || !position) continue;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    const polygon = plane.polygon;
    if (polygon.length > 0 && polygon.length <= MAX_POLYGON_POINTS) {
      for (const point of polygon) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
      }
    }
    lines.push(`Plane ${++count}: label=${label(plane.semanticLabel)}, orientation=${plane.orientation ?? 'unknown'}, local extent=${measurement(maxX - minX)} x ${measurement(maxZ - minZ)} m, origin=(${measurement(position.x)}, ${measurement(position.y)}, ${measurement(position.z)}).`);
  }
  for (const entity of meshes) {
    if (count >= MAX_SURFACES) break;
    const position = entity.object3D?.position;
    if (!position) continue;
    const bounded = entity.getValue(XRMesh, 'isBounded3D');
    const dimensions = bounded ? entity.getVectorView(XRMesh, 'dimensions') : null;
    const extent = dimensions
      ? `${measurement(dimensions[0])} x ${measurement(dimensions[1])} x ${measurement(dimensions[2])} m`
      : 'unbounded / dimensions not provided';
    lines.push(`Mesh ${++count}: label=${label(entity.getValue(XRMesh, 'semanticLabel'))}, local extent=${extent}, origin=(${measurement(position.x)}, ${measurement(position.y)}, ${measurement(position.z)}).`);
  }
  if (planes.size + meshes.size > count) lines.push(`Summary limited to ${MAX_SURFACES} surfaces; remaining or unavailable measurements omitted.`);
  lines.push('Geometry alone does not establish people, colors, text, movable objects, or unseen room contents. A photo is separate and only captured on explicit request.');
  return lines.join('\n');
}

/** One short line for the panel. The full geometry stays in getRoomContext() for the model. */
export function getRoomSummary(): string {
  const world = boundWorld;
  if (!world) return 'Room geometry: not available.';
  const session = world.xrSession;
  if (!session) return 'Room geometry: unavailable on desktop. Enter MR to measure surfaces.';
  const features = session.enabledFeatures;
  const planesEnabled = features?.includes('plane-detection') ?? false;
  const meshesEnabled = features?.includes('mesh-detection') ?? false;
  if (features && !planesEnabled && !meshesEnabled) {
    return 'Room geometry: plane/mesh detection not granted.';
  }
  const understanding = world.getSystem(SceneUnderstandingSystem);
  if (!understanding) return 'Room geometry: detection not configured.';
  const planes = understanding.queries.planeEntities.entities;
  const meshes = understanding.queries.meshEntities.entities;
  if (planes.size === 0 && meshes.size === 0) {
    return performance.now() - sessionStartedAt < 3000
      ? 'Room geometry: waiting for the initial scan.'
      : 'Room geometry: no surfaces detected.';
  }
  return `Room geometry: ${planes.size} planes, ${meshes.size} meshes (metadata, not vision).`;
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Browser permission/playback promises cannot themselves be canceled. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(signal.reason); };
    if (signal.aborted) {
      reject(signal.reason);
      // Keep any later rejection handled, even though the caller has left.
      promise.catch(() => {});
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function waitForFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadeddata', onData);
      video.removeEventListener('resize', onData);
      video.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onData = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('The camera opened but no decodable video frame was delivered'));
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    if (signal.aborted) { reject(signal.reason); return; }
    video.addEventListener('loadeddata', onData);
    video.addEventListener('resize', onData);
    video.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    onData();
  });
}

function cameraSource(track: MediaStreamTrack): CapturedPhoto['source'] {
  const identity = track.label;
  // CameraUtils' front/back heuristics cannot establish headset provenance.
  // Only positive camera metadata may produce the 'quest-camera' result.
  if (!/avatar|virtual|synthetic/i.test(identity) && /passthrough|quest.*camera|camera.*quest/i.test(identity)) {
    return 'quest-camera';
  }
  // UA is diagnostic provenance only, never an API-support check. Quest Browser
  // may expose a virtual/ambiguous feed: do not pass that off as the real room.
  if (/OculusBrowser|MetaQuestBrowser/i.test(navigator.userAgent)) {
    throw new Error('The camera did not identify itself as a physical Quest passthrough camera. No photo was captured. Exit immersive mode and use a browser/device exposing a supported physical camera, or use the desktop webcam. WebXR passthrough display alone does not expose camera pixels.');
  }
  if (/avatar|virtual|synthetic/i.test(identity)) {
    throw new Error('The selected camera identifies as a virtual/synthetic/avatar feed, not a physical camera. Select a real webcam in browser camera settings.');
  }
  return 'webcam';
}

function cameraFailure(error: unknown, immersive: boolean): Error {
  const detail = error instanceof Error ? error.message : 'Unknown camera error';
  const action = immersive
    ? ' Exit immersive mode and try again with a supported camera, or use the desktop webcam.'
    : ' Select an available webcam and allow camera access in this site’s browser settings.';
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return new Error(`Camera permission denied or blocked by browser/site policy. No photo was captured.${action}`);
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return new Error(`No supported camera was exposed by this browser/device. No photo was captured.${action}`);
    }
    if (error.name === 'NotReadableError' || error.name === 'AbortError') {
      return new Error(`Camera could not provide a frame (it may be busy or unavailable in this mode). No photo was captured.${action}`);
    }
  }
  return new Error(detail);
}

/**
 * Call ONLY for an explicit user photo request. Returns an ephemeral JPEG; this
 * module does not retain, persist, upload, or silently substitute any image.
 * No RAW0069/XRWebGLBinding camera support is assumed.
 */
export async function capturePhoto(): Promise<CapturedPhoto> {
  if (activeCapture) throw new Error('A camera capture is already in progress; finish it before requesting another photo');
  const immersive = Boolean(boundWorld?.xrSession);
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    const error = new Error('Camera capture is unavailable: open this site over HTTPS in a browser with getUserMedia camera support. If immersive, exit XR and retry with a supported camera or desktop webcam.');
    publish(error.message);
    throw error;
  }
  const controller = new AbortController();
  activeCapture = controller;
  const { signal } = controller;
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  const release = () => {
    if (stream) {
      stopStream(stream);
      stream = null;
    }
    if (video) {
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      video.load();
      video.remove();
      video = null;
    }
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
      canvas = null;
    }
  };
  const timer = window.setTimeout(() => controller.abort(new Error('Camera request timed out without a photo. Dismiss any pending permission prompt; if access is granted later its tracks will be stopped. Exit immersive mode or use a supported webcam and request another photo.')), CAPTURE_TIMEOUT_MS);
  signal.addEventListener('abort', release, { once: true });
  try {
    publish('Camera: requesting permission for one photo (no continuous recording)');
    const request = navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: MAX_PHOTO_EDGE }, height: { ideal: MAX_PHOTO_EDGE } },
    }).then((media) => {
      // getUserMedia has no abort signal. A permission grant after disposal or
      // timeout must not leave the late stream running.
      if (signal.aborted) stopStream(media);
      return media;
    });
    stream = await abortable(request, signal);
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') throw new Error('The camera returned no live video track; no photo was captured');
    const source = cameraSource(track);
    video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    publish('Camera: waiting for the first real video frame');
    await abortable(video.play(), signal);
    await waitForFrame(video, signal);
    if (signal.aborted) throw signal.reason;
    if (track.readyState !== 'live') throw new Error('The camera stopped before a frame could be captured');
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(video.videoWidth, video.videoHeight));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('This browser could not create a canvas for the camera frame');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const capturedAt = Date.now();
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('This browser could not encode the camera frame as JPEG');
    // Stop hardware before notifying listeners or returning the ephemeral data.
    release();
    publish(`Photo captured from ${source === 'quest-camera' ? 'identified Quest camera' : 'webcam'}; camera stopped`);
    return { dataUrl, source, capturedAt };
  } catch (error) {
    const failure = cameraFailure(error, immersive);
    release();
    publish(failure.message);
    throw failure;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener('abort', release);
    release();
    if (activeCapture === controller) activeCapture = null;
  }
}
