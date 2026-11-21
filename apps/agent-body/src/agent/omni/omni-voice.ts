/**
 * Main-thread playback for the omni tier's streamed 24 kHz speech: an
 * AudioContext queue that appends buffers as the worker produces them,
 * drives the avatar's talking state, and stops only when the user hushes it
 * (no barge-in — the recorder and playback stay sequential).
 */
import { avatarBody } from '../../avatar-body.js';
import { publishAvatarCue } from '../cues.js';
import { reportSpeechStatus } from '../tts.js';
import type { AvatarCue } from '../contracts.js';

interface ActivePlayback {
  context: AudioContext;
  sources: { node: AudioBufferSourceNode; ended: boolean }[];
  cancel(): void;
}

let active: ActivePlayback | null = null;

/** True while a hush must also tear down the omni queue. */
export function stopOmniPlayback(): void {
  const current = active;
  active = null;
  if (!current) return;
  current.cancel();
}

/**
 * Opens a playback session for one reply. Feed it PCM chunks as they arrive;
 * the avatar starts performing with the first audible sample and stops when
 * the queue drains or the user hushes.
 */
export function speakOmniReply(cue: AvatarCue | null): {
  onAudio(pcm: Float32Array): void;
  finish(): Promise<void>;
} {
  stopOmniPlayback();
  const AudioCtor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) throw new Error('Audio playback is unavailable in this runtime');
  const context = new AudioCtor();
  const sources: { node: AudioBufferSourceNode; ended: boolean }[] = [];
  let nextStart = 0;
  let startedPerformance = false;
  let samples = 0;
  let canceled = false;

  const playback: ActivePlayback = {
    context,
    sources,
    cancel() {
      canceled = true;
      for (const source of sources) {
        try {
          source.node.onended = null;
          source.ended = true;
          source.node.stop();
        } catch {
          /* already stopped */
        }
      }
      void context.close().catch(() => { /* already closed */ });
      reportSpeechStatus('Speech canceled');
      avatarBody.setTalking(false);
    },
  };
  active = playback;

  const drain = (): Promise<void> =>
    new Promise((resolve) => {
      const check = () => {
        if (canceled) return resolve();
        const pending = sources.filter((source) => !source.ended);
        if (samples > 0 && pending.length === 0) {
          avatarBody.setTalking(false);
          reportSpeechStatus('Speech complete');
          void context.close().catch(() => { /* already closed */ });
          if (active === playback) active = null;
          resolve();
          return;
        }
        window.setTimeout(check, 120);
      };
      check();
    });

  return {
    onAudio(pcm: Float32Array) {
      if (canceled || !pcm.length) return;
      samples += pcm.length;
      const buffer = context.createBuffer(1, pcm.length, 24000);
      buffer.copyToChannel(new Float32Array(pcm), 0);
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      const entry: { node: AudioBufferSourceNode; ended: boolean } = { node, ended: false };
      node.onended = () => { entry.ended = true; };
      const startAt = Math.max(context.currentTime + 0.03, nextStart);
      node.start(startAt);
      nextStart = startAt + buffer.duration;
      sources.push(entry);
      if (!startedPerformance) {
        startedPerformance = true;
        if (cue) {
          avatarBody.playCue(cue);
          publishAvatarCue(cue);
        }
        avatarBody.setTalking(true);
        reportSpeechStatus('Speech: speaking (on-device omni)');
      }
    },
    finish: drain,
  };
}
