/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { agentState } from './state.js';
import { decodeMono16k, transcribeLocally } from './local-stt.js';
import { resolvePipeline } from './pipeline.js';
import { peekOmniCapability } from './omni/capability.js';
import { isLocalImmersiveSession } from './local-model.js';

// SpeechRecognition is not part of every browser's DOM declarations or runtime.
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  /** Chrome 139+: keep the audio on the device. */
  processLocally?: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface RecognitionAvailability {
  langs: string[];
  processLocally: boolean;
}
interface RecognitionConstructor {
  new (): Recognition;
  available?(options: RecognitionAvailability): Promise<string>;
  install?(options: RecognitionAvailability): Promise<boolean>;
}
interface RecognitionWindow extends Window {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
}

export interface ListeningSession {
  readonly active: boolean;
  /** Finish recording and deliver the transcript when recognition completes. */
  stop(): void;
  /** Discard this session, abort uploads, and never deliver its transcript. */
  cancel(): void;
}

let active: ListeningSession | null = null;
let generation = 0;

/** Cancels even a pending permission request; acquired tracks are then stopped. */
export function cancelListening(): void {
  active?.cancel();
}

/** Start the selected provider; status callbacks cover all async failures. */
export async function startListening(
  onTranscript: (text: string) => void,
  onStatus: (status: string) => void,
  hooks?: { onOmniAudio?: (pcm: Float32Array) => void },
): Promise<ListeningSession> {
  active?.cancel();
  const ownGeneration = ++generation;
  let canceled = false;
  let closed = false;
  let stopping = false;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let recognition: Recognition | null = null;
  let vadTimer: number | undefined;
  let vadContext: AudioContext | null = null;
  const controller = new AbortController();

  /** Stops the energy gate that turns the microphone off after a pause. */
  function stopVoiceDetection(): void {
    if (vadTimer !== undefined) {
      window.clearInterval(vadTimer);
      vadTimer = undefined;
    }
    if (vadContext) {
      void vadContext.close().catch(() => undefined);
      vadContext = null;
    }
  }

  function releaseMicrophone(): void {
    stopVoiceDetection();
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }

  function close(message: string): void {
    if (closed) return;
    closed = true;
    if (active === session) active = null;
    controller.abort();
    if (recognition) {
      recognition.onstart = null;
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      try {
        recognition.abort();
      } catch {
        message = `${message}; browser recognition could not be aborted`;
      }
    }
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          message = `${message}; recorder could not be stopped`;
        }
      }
    }
    releaseMicrophone();
    onStatus(message);
  }

  const session: ListeningSession = {
    get active() { return !closed; },
    stop() {
      if (closed || stopping) return;
      stopping = true;
      onStatus('Microphone: finishing recording');
      try {
        if (recognition) recognition.stop();
        else if (recorder && recorder.state !== 'inactive') {
          recorder.stop();
          releaseMicrophone();
        } else {
          close('Microphone stopped without a recording');
        }
      } catch {
        close('Microphone error: could not finish recording');
      }
    },
    cancel() {
      canceled = true;
      close('Microphone canceled');
    },
  };
  active = session;

  // Energy gate for the recorder providers. One tap arms the microphone;
  // speech opens the utterance and a pause closes it, so the button is not a
  // push-to-talk switch and no second tap is needed.
  const VAD_POLL_MS = 80;
  const VAD_SILENCE_MS = 1100;
  const VAD_NO_SPEECH_MS = 8000;
  const VAD_MAX_UTTERANCE_MS = 30000;

  function startVoiceDetection(recording: MediaRecorder): void {
    const AudioCtor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const sourceStream = stream;
    // Without an analyser the manual stop path still works.
    if (!AudioCtor || !sourceStream) return;
    let context: AudioContext;
    try {
      context = new AudioCtor();
    } catch {
      return;
    }
    vadContext = context;
    const source = context.createMediaStreamSource(sourceStream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const startedAt = performance.now();
    let heardSpeech = false;
    let finished = false;
    let lastVoiceAt = 0;
    let noiseFloor = 0.004;

    vadTimer = window.setInterval(() => {
      if (closed || finished || recording.state === 'inactive') {
        stopVoiceDetection();
        return;
      }
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (let index = 0; index < samples.length; index += 1) {
        energy += samples[index] * samples[index];
      }
      const rms = Math.sqrt(energy / samples.length);
      const now = performance.now();

      if (!heardSpeech) {
        // Learn the room noise while the user is still silent, so a hum or a
        // fan does not hold the gate open on its own.
        noiseFloor = noiseFloor * 0.95 + Math.min(rms, 0.05) * 0.05;
        if (rms > Math.max(0.014, noiseFloor * 3)) {
          heardSpeech = true;
          lastVoiceAt = now;
          onStatus('Microphone: listening');
        } else if (now - startedAt > VAD_NO_SPEECH_MS) {
          finished = true;
          canceled = true;
          close('No speech detected');
        }
        return;
      }

      if (rms > Math.max(0.01, noiseFloor * 2.5)) lastVoiceAt = now;
      if (now - lastVoiceAt < VAD_SILENCE_MS && now - startedAt < VAD_MAX_UTTERANCE_MS) return;
      finished = true;
      onStatus('Microphone: speech finished, transcribing');
      try {
        recording.stop();
      } catch {
        close('Microphone error: could not finish recording');
      }
    }, VAD_POLL_MS);
  }

  try {
    await agentState.ready;
    if (closed) return session;
    const settings = agentState.getSettings();
    if (settings.sttProvider === 'off') {
      close('Microphone disabled: select a speech recognition provider');
      return session;
    }
    if (settings.sttProvider === 'browser') {
      const host = typeof window === 'undefined' ? undefined : window as RecognitionWindow;
      const Constructor = host?.SpeechRecognition ?? host?.webkitSpeechRecognition;
      if (!Constructor) {
        throw new Error('Browser speech recognition is unavailable; select on-device Whisper or OpenAI-compatible STT');
      }
      const browserRecognition = new Constructor();
      recognition = browserRecognition;
      browserRecognition.lang = settings.speechLanguage;
      browserRecognition.continuous = false;
      browserRecognition.interimResults = false;
      // Chrome 139+ can recognise speech on the device. Without the language
      // pack the browser falls back to the vendor's cloud recognition.
      let onDevice = false;
      if (typeof Constructor.available === 'function') {
        const options = { langs: [settings.speechLanguage], processLocally: true };
        const availability = await Constructor.available(options).catch(() => 'unavailable');
        if (availability === 'available') onDevice = true;
        else if (availability === 'downloadable' && typeof Constructor.install === 'function') {
          onStatus('Microphone: installing the on-device speech pack (one-time download)');
          onDevice = await Constructor.install(options).catch(() => false);
        }
      }
      if (onDevice && 'processLocally' in browserRecognition) browserRecognition.processLocally = true;
      const engine = onDevice ? 'browser, on-device' : 'browser, cloud';
      const finalResults: string[] = [];
      browserRecognition.onstart = () => {
        if (!closed) onStatus(`Microphone: listening (${engine})`);
      };
      browserRecognition.onresult = (event) => {
        if (closed) return;
        for (let index = event.resultIndex; index < event.results.length; index++) {
          const result = event.results[index];
          if (result?.isFinal) finalResults[index] = result[0]?.transcript ?? '';
        }
      };
      browserRecognition.onerror = (event) => {
        close(`Microphone error: browser recognition failed (${event.error})`);
      };
      browserRecognition.onend = () => {
        if (closed) return;
        const text = finalResults.join(' ').trim();
        close(text ? 'Transcription complete' : 'No speech recognized');
        // onStatus may have started a newer session during close().
        if (text && !canceled && generation === ownGeneration) onTranscript(text);
      };
      onStatus(`Microphone: starting ${engine} recognition`);
      if (!closed) browserRecognition.start();
      return session;
    }

    const onDevice = settings.sttProvider === 'local';
    if (onDevice && !settings.sttModel.trim()) {
      throw new Error('Set an on-device Whisper model id, for example onnx-community/whisper-base');
    }
    if (!onDevice && (!settings.sttEndpoint.trim() || !settings.sttModel.trim())) {
      throw new Error('Set the transcription endpoint and model for OpenAI-compatible STT');
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is unavailable; use a secure HTTPS context and allow microphone access');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder is unavailable in this browser');
    }
    onStatus('Microphone: requesting permission');
    if (closed) return session;
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (closed) {
      for (const track of acquired.getTracks()) track.stop();
      return session;
    }
    stream = acquired;
    const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
        .find((type) => MediaRecorder.isTypeSupported(type))
      : undefined;
    const recording = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    recorder = recording;
    const chunks: Blob[] = [];
    recording.ondataavailable = (event) => {
      if (!closed && event.data.size) chunks.push(event.data);
    };
    recording.onerror = () => close('Microphone error: audio recording failed');
    recording.onstop = () => {
      releaseMicrophone();
      if (closed) return;
      void transcribe().catch(() => {
        if (!closed) close('Microphone error: transcription request failed (network, CORS, or invalid response)');
      });
    };

    async function transcribe(): Promise<void> {
      const type = recording.mimeType || chunks[0]?.type || 'application/octet-stream';
      const audio = new Blob(chunks, { type });
      if (!audio.size) {
        close('Microphone error: recording was empty');
        return;
      }
      if (hooks?.onOmniAudio && resolvePipeline(settings, peekOmniCapability(), isLocalImmersiveSession()) === 'omni') {
        // The omni tier transcribes and answers from the raw audio itself;
        // Whisper is not loaded for it.
        onStatus('Microphone: captured for the on-device omni model');
        const pcm = await decodeMono16k(audio);
        if (closed) return;
        close('Microphone: utterance captured');
        if (!canceled && generation === ownGeneration) hooks.onOmniAudio(pcm);
        return;
      }
      if (onDevice) {
        let text = '';
        try {
          text = await transcribeLocally(audio, settings.sttModel, settings.speechLanguage, controller.signal, onStatus);
        } catch (error) {
          if (!closed) close(`Microphone error: ${error instanceof Error ? error.message : 'on-device transcription failed'}`);
          return;
        }
        if (closed) return;
        close(text ? 'Transcription complete' : 'No speech recognized');
        if (text && !canceled && generation === ownGeneration) onTranscript(text);
        return;
      }
      const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('webm') ? 'webm' : 'bin';
      const form = new FormData();
      form.append('file', audio, `recording.${extension}`);
      form.append('model', settings.sttModel);
      const language = settings.speechLanguage.split(/[-_]/u)[0]?.toLowerCase();
      if (language && /^[a-z]{2}$/u.test(language)) form.append('language', language);
      onStatus('Microphone: transcribing');
      if (closed) return;
      const response = await fetch(`${settings.sttEndpoint.trim().replace(/\/+$/u, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: settings.sttApiKey ? { Authorization: `Bearer ${settings.sttApiKey}` } : {},
        body: form,
        signal: controller.signal,
      });
      if (closed) return;
      if (!response.ok) {
        close(`Microphone error: transcription endpoint returned HTTP ${response.status}`);
        return;
      }
      const result: unknown = await response.json();
      if (closed) return;
      if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string') {
        close('Microphone error: transcription endpoint must return a JSON text field');
        return;
      }
      const text = result.text.trim();
      close(text ? 'Transcription complete' : 'No speech recognized');
      if (text && !canceled && generation === ownGeneration) onTranscript(text);
    }

    recording.start();
    onStatus('Microphone: listening; it stops automatically after a pause');
    startVoiceDetection(recording);
    return session;
  } catch (error) {
    if (closed) return session;
    const message = error instanceof Error
      ? error.message.replaceAll(agentState.getSettings().sttApiKey || '\u0000', '[redacted]')
      : 'Microphone capture failed';
    close(`Microphone error: ${message}`);
    throw new Error(message);
  }
}

let previousSettings = agentState.getSettings();
agentState.onSettingsChanged((settings) => {
  if (settings.sttProvider !== previousSettings.sttProvider ||
      settings.sttEndpoint !== previousSettings.sttEndpoint ||
      settings.sttModel !== previousSettings.sttModel ||
      settings.sttApiKey !== previousSettings.sttApiKey ||
      settings.speechLanguage !== previousSettings.speechLanguage) active?.cancel();
  previousSettings = settings;
});
