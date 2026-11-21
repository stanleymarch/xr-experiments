/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { agentState } from './state.js';
import { avatarBody } from '../avatar-body.js';
import { publishAvatarCue } from './cues.js';
import { synthesizeLocally } from './local-tts.js';
import { stopOmniPlayback } from './omni/omni-voice.js';
import { describeVoice, listVoices, pickVoice } from './voices.js';
import type { AvatarCue } from './contracts.js';

let status = 'Speech disabled';
const listeners = new Set<(status: string) => void>();
let active: { cancel(): void } | null = null;

function notify(value: string): void {
  status = value;
  for (const listener of listeners) listener(value);
}

/** Publishes a status line from the omni playback path through the same listeners. */
export function reportSpeechStatus(message: string): void {
  notify(message);
}

export function getSpeechStatus(): string {
  return status;
}

/** Subscribe to loading, playback, cancellation, and errors; also report now. */
export function onSpeechStatus(callback: (status: string) => void): () => void {
  listeners.add(callback);
  callback(status);
  return () => { listeners.delete(callback); };
}

/** Cancel fetching or playback. Intentional cancellation resolves speak(). */
export function hush(): void {
  active?.cancel();
  stopOmniPlayback();
  avatarBody.setTalking(false);
  avatarBody.playCue(null);
  publishAvatarCue(null);
}

/** Speak using the selected provider. Failures are both reported and rejected. */
export function speak(text: string, cue: AvatarCue | null = null): Promise<void> {
  hush();
  if (!text.trim()) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    const cleanups: (() => void)[] = [];
    let finished = false;
    let performanceStarted = false;
    function startPerformance(talking: boolean): void {
      if (performanceStarted || finished) return;
      performanceStarted = true;
      if (cue) avatarBody.playCue(cue);
      publishAvatarCue(cue);
      avatarBody.setTalking(talking);
    }
    const operation = { cancel: () => finish('Speech canceled') };
    active = operation;

    function finish(message: string, error?: Error): void {
      if (finished) return;
      finished = true;
      if (active === operation) active = null;
      avatarBody.setTalking(false);
      controller.abort();
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {
          error ??= new Error('Speech playback cleanup failed');
        }
      }
      notify(error ? `Speech error: ${error.message}` : message);
      if (error) reject(error);
      else resolve();
    }

    async function run(): Promise<void> {
      await agentState.ready;
      if (finished) return;
      const settings = agentState.getSettings();
      if (settings.ttsProvider === 'off') {
        startPerformance(false);
        finish('Speech disabled');
        return;
      }
      if (settings.ttsProvider === 'browser') {
        if (typeof window === 'undefined' || !window.speechSynthesis ||
            typeof SpeechSynthesisUtterance === 'undefined') {
          throw new Error('Browser speech synthesis is unavailable; select another provider');
        }
        const synthesis = window.speechSynthesis;
        const voices = await listVoices();
        if (!voices.length) throw new Error('No browser speech voices are available');
        const selected = settings.ttsVoice.trim();
        const voice = selected
          ? voices.find((item) => item.uri === selected || item.name === selected) ?? null
          : pickVoice(voices, settings.speechLanguage);
        if (!voice) throw new Error('Selected browser voice is unavailable; select an installed voice or leave voice empty');
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.voice = synthesis.getVoices().find((item) => item.voiceURI === voice.uri) ?? null;
        utterance.lang = settings.speechLanguage;
        utterance.rate = 1.05;
        const voiceLabel = describeVoice(voice);
        utterance.onstart = () => { if (!finished) { startPerformance(true); notify(`Speech: speaking (${voiceLabel})`); } };
        utterance.onend = () => finish('Speech complete');
        utterance.onerror = (event) => finish('', new Error(`Browser synthesis failed (${event.error})`));
        cleanups.push(() => {
          utterance.onstart = null;
          utterance.onend = null;
          utterance.onerror = null;
          synthesis.cancel();
        });
        notify('Speech: queued (browser)');
        if (!finished) synthesis.speak(utterance);
        return;
      }

      if (settings.ttsProvider === 'local') {
        if (!settings.ttsModel.trim()) throw new Error('Set an on-device voice model, for example Xenova/mms-tts-rus');
        if (typeof AudioContext === 'undefined') throw new Error('Audio playback is unavailable in this runtime');
        notify('Speech: generating audio on device');
        if (finished) return;
        const { audio, samplingRate } = await synthesizeLocally(
          text,
          settings.ttsModel.trim(),
          (status) => { if (!finished) notify(status); },
        );
        if (finished) return;
        const context = new AudioContext();
        const buffer = context.createBuffer(1, audio.length, samplingRate);
        const samples = new Float32Array(audio.length);
        samples.set(audio);
        buffer.copyToChannel(samples, 0);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        const ended = new Promise<void>((resolve) => { source.onended = () => resolve(); });
        cleanups.push(() => {
          source.onended = null;
          try { source.stop(); } catch { /* already stopped */ }
          void context.close().catch(() => { /* already closed */ });
        });
        await context.resume().catch(() => { /* autoplay may block until a gesture */ });
        if (finished) return;
        startPerformance(true);
        notify('Speech: speaking (on device)');
        avatarBody.speakChunk(text);
        source.start();
        await ended;
        finish('Speech complete');
        return;
      }

      if (!settings.ttsEndpoint.trim() || !settings.ttsModel.trim() || !settings.ttsVoice.trim()) {
        throw new Error('Set the speech endpoint, model, and voice for OpenAI-compatible TTS');
      }
      if (typeof Audio === 'undefined') throw new Error('Audio playback is unavailable');
      notify('Speech: generating audio');
      if (finished) return;
      const response = await fetch(`${settings.ttsEndpoint.trim().replace(/\/+$/u, '')}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.ttsApiKey ? { Authorization: `Bearer ${settings.ttsApiKey}` } : {}),
        },
        body: JSON.stringify({ model: settings.ttsModel, voice: settings.ttsVoice, input: text, response_format: 'mp3' }),
        signal: controller.signal,
      });
      if (finished) return;
      if (!response.ok) throw new Error(`Speech endpoint returned HTTP ${response.status}`);
      const blob = await response.blob();
      if (finished) return;
      if (!blob.size) throw new Error('Speech endpoint returned empty audio');
      const url = URL.createObjectURL(blob);
      cleanups.push(() => URL.revokeObjectURL(url));
      const audio = new Audio(url);
      cleanups.push(() => {
        audio.onended = null;
        audio.onerror = null;
        audio.onplaying = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      });
      audio.onended = () => finish('Speech complete');
      audio.onerror = () => finish('', new Error('Generated speech audio could not be decoded or played'));
      audio.onplaying = () => { if (!finished) { startPerformance(true); notify('Speech: speaking (OpenAI-compatible)'); } };
      notify('Speech: starting audio');
      if (!finished) await audio.play();
    }

    void run().catch((error: unknown) => {
      if (!finished) {
        // Never expose response bodies or request objects: providers may echo keys.
        const message = error instanceof Error && !controller.signal.aborted
          ? error.message.replaceAll(agentState.getSettings().ttsApiKey || '\u0000', '[redacted]')
          : 'Speech request failed';
        finish('', new Error(message));
      }
    });
  });
}

let previousSettings = agentState.getSettings();
agentState.onSettingsChanged((settings) => {
  if (settings.ttsProvider !== previousSettings.ttsProvider ||
      settings.ttsEndpoint !== previousSettings.ttsEndpoint ||
      settings.ttsModel !== previousSettings.ttsModel ||
      settings.ttsVoice !== previousSettings.ttsVoice ||
      settings.ttsApiKey !== previousSettings.ttsApiKey ||
      settings.speechLanguage !== previousSettings.speechLanguage) {
    hush();
    notify(settings.ttsProvider === 'off' ? 'Speech disabled' : `Speech ready (${settings.ttsProvider})`);
  }
  previousSettings = settings;
});
