/**
 * Procedural weather audio: rain hiss, wind bed, thunder rumbles and small
 * timeline ticks, synthesized with WebAudio — no audio assets. Gains follow
 * the shared weather drivers every frame; momentary sounds subscribe to
 * weatherEvents (thunder flash, timeline grab/snap). The AudioContext is
 * created suspended and resumes on the first user gesture (pointerdown),
 * satisfying autoplay policy in both flat and XR presentations.
 */

import { createSystem, VisibilityState } from '@iwsdk/core';
import { connectAudio } from '../audio-stub.js';
import { WeatherEvent, weatherEvents, weatherStore } from '../weather-state.js';

/** Seconds of looped noise per buffer; short enough to stay cheap. */
const NOISE_BUFFER_S = 2;

function makeNoiseBuffer(ctx: AudioContext, brown: boolean): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_BUFFER_S);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i += 1) {
    const white = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    } else {
      data[i] = white;
    }
  }
  return buffer;
}

export class WeatherAudioSystem extends createSystem({}) {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private rainLevel = 0;
  private windLevel = 0;
  /** Seconds since the last accepted Gust event; swells the wind bed. */
  private gustAgeS = Number.POSITIVE_INFINITY;
  /**
   * The AudioContext is created suspended and resumed on the first user
   * gesture. Desktop unlocks on window pointerdown; immersive VR never gets
   * a window pointerdown, so the app's own XR entry path — every
   * VisibilityState.Visible transition, including the UIKit panel's Enter AR
   * click that triggers it — also resumes. Either path calls the same
   * unlock, so flat and XR entry both work.
   */
  init(): void {
    if (typeof window === 'undefined') return;
    const unlock = (): void => {
      void this.ensureContext()
        ?.resume()
        .catch(() => undefined);
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    // XR entry has no window pointerdown: the Enter AR click resolves into a
    // session visibility transition, so unlock on the first Visible too.
    // Harmless on flat (unlock is idempotent, resume resolves immediately).
    const unlockOnVisible = (state: VisibilityState): void => {
      if (state === VisibilityState.Visible) unlock();
    };
    const unsubscribeVisible = this.world.visibilityState.subscribe(unlockOnVisible);
    this.cleanupFuncs.push(
      () => window.removeEventListener('pointerdown', unlock),
      unsubscribeVisible,
      weatherEvents.on(WeatherEvent.Thunder, () => this.rumble()),
      // Gust is the single whoosh owner: gesture sweeps and UI buttons emit
      // the event, this listener answers — never the emitter, so the paths
      // cannot double-play. The wind bed also swells briefly (update below).
      weatherEvents.on(WeatherEvent.Gust, (detail: unknown) => this.gustWhoosh(detail)),
      weatherEvents.on(WeatherEvent.TimelineGrab, () => this.tick(520, 0.05, 0.03)),
      weatherEvents.on(WeatherEvent.TimelineSnap, () => {
        this.tick(660, 0.06, 0.03);
        window.setTimeout(() => this.tick(990, 0.08, 0.05), 90);
      }),
      // Room-wide hour detent: one soft tick per crossed hour on the same
      // shared moment as the guide fill, panels, room pulse, and haptic.
      // Deliberately quieter and shorter than the snap double-tick above
      // so scrubbing stays a calm instrument; the NOW snap keeps its
      // unmistakable two-tone thunk.
      weatherEvents.on(WeatherEvent.HourCrossed, () => this.tick(740, 0.03, 0.025)),
      // UI tick: modest in level by design (gain 0.04, 30 ms).
      weatherEvents.on(WeatherEvent.UiPress, () => this.tick(880, 0.04, 0.03)),
      () => {
        void this.ctx?.close().catch(() => undefined);
        this.ctx = null;
        this.master = null;
        this.rainGain = null;
        this.windGain = null;
      },
    );
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx != null) return this.ctx;
    if (typeof AudioContext === 'undefined') return null;
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);

    const white = makeNoiseBuffer(ctx, false);
    const brown = makeNoiseBuffer(ctx, true);

    // Rain: bright hiss, high-passed so it reads as falling water.
    const rainSource = ctx.createBufferSource();
    rainSource.buffer = white;
    rainSource.loop = true;
    const rainHighpass = ctx.createBiquadFilter();
    rainHighpass.type = 'highpass';
    rainHighpass.frequency.value = 1200;
    const rainLowpass = ctx.createBiquadFilter();
    rainLowpass.type = 'lowpass';
    rainLowpass.frequency.value = 7000;
    const rainGain = ctx.createGain();
    rainGain.gain.value = 0;
    connectAudio(rainSource, rainHighpass, rainLowpass, rainGain, master);
    rainSource.start();

    // Wind: brown-noise bed with a slow breathing LFO on the lowpass.
    const windSource = ctx.createBufferSource();
    windSource.buffer = brown;
    windSource.loop = true;
    const windLowpass = ctx.createBiquadFilter();
    windLowpass.type = 'lowpass';
    windLowpass.frequency.value = 420;
    windLowpass.Q.value = 0.7;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 160;
    connectAudio(lfo, lfoGain, windLowpass.frequency);
    lfo.start();
    connectAudio(windSource, windLowpass, windGain, master);
    windSource.start();

    this.ctx = ctx;
    this.master = master;
    this.rainGain = rainGain;
    this.windGain = windGain;
    return ctx;
  }

  update(delta: number): void {
    if (this.gustAgeS < 30) this.gustAgeS += Math.min(delta, 0.1);
    if (this.rainGain == null || this.windGain == null || this.ctx == null) return;
    if (this.ctx.state !== 'running') return;
    const current = weatherStore.current();
    const rain = current?.drivers.rain ?? 0;
    // Wind bed follows mean flow with a floor so calm hours stay quiet —
    // plus a brief swell after each accepted gust so the wave is heard even
    // in calm weather (decays ~1.2 s, matching the gust envelope's tail).
    const wind = Math.min(1, ((current?.drivers.wind ?? 0) - 0.05) / 0.95);
    const gustSwell = this.gustAgeS < 1.2 ? (1 - this.gustAgeS / 1.2) * 0.55 : 0;
    const ease = Math.min(1, delta * 1.5);
    this.rainLevel += (rain - this.rainLevel) * ease;
    this.windLevel += (Math.max(0, Math.min(1, wind + gustSwell)) - this.windLevel) * ease;
    this.rainGain.gain.value = this.rainLevel * 0.22;
    this.windGain.gain.value = this.windLevel * 0.3;
  }

  /** Short filtered burst for grabs and snaps. */
  private tick(frequencyHz: number, gain: number, seconds: number): void {
    const ctx = this.ensureContext();
    if (ctx == null || ctx.state !== 'running' || this.master == null) return;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = frequencyHz;
    const env = ctx.createGain();
    const t = ctx.currentTime;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    connectAudio(osc, env, this.master);
    osc.start(t);
    osc.stop(t + seconds + 0.05);
  }

  /**
   * Thunder rumble: a satisfying low attack with a rolling tail. The onset
   * crack lands ~90 ms after the accepted action (lightning first, thunder
   * just behind it — the purposeful separation), then brown noise rolls
   * through a falling lowpass for ~2.6 s with two restrike swells riding the
   * decay, mirroring the visual envelope's tail. Reuses the 2 s looped brown
   * buffer (playbackRate drift keeps the tail from looping audibly); only
   * the per-strike nodes (source/filter/envelope) are created transiently.
   */
  private rumble(): void {
    const ctx = this.ensureContext();
    if (ctx == null || ctx.state !== 'running' || this.master == null) return;
    // Purposeful lightning/rumble separation: the discharge flashes first.
    const t = ctx.currentTime + 0.09;
    const brown = makeNoiseBuffer(ctx, true);
    const source = ctx.createBufferSource();
    source.buffer = brown;
    source.loop = true;
    source.playbackRate.value = 0.55;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.Q.value = 0.6;
    lowpass.frequency.setValueAtTime(1400, t);
    lowpass.frequency.exponentialRampToValueAtTime(320, t + 0.12);
    lowpass.frequency.exponentialRampToValueAtTime(70, t + 2.4);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    // Attack: fast but not a click (8 ms), then the rolling decay.
    env.gain.exponentialRampToValueAtTime(0.65, t + 0.05);
    env.gain.exponentialRampToValueAtTime(0.28, t + 0.4);
    // Two restrike swells riding the tail, matching the visual shimmer.
    env.gain.exponentialRampToValueAtTime(0.34, t + 0.62);
    env.gain.exponentialRampToValueAtTime(0.14, t + 1.1);
    env.gain.exponentialRampToValueAtTime(0.17, t + 1.45);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    connectAudio(source, lowpass, env, this.master);
    source.start(t);
    source.stop(t + 2.7);
    // Sub weight: one low sine drop under the crack so small speakers feel it.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(68, t);
    sub.frequency.exponentialRampToValueAtTime(34, t + 0.8);
    const subEnv = ctx.createGain();
    subEnv.gain.setValueAtTime(0.0001, t);
    subEnv.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
    subEnv.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    connectAudio(sub, subEnv, this.master);
    sub.start(t);
    sub.stop(t + 1.2);
  }

  /**
   * Gust whoosh: the single audible answer to an accepted sweep (gesture or
   * UI button). Brightness and level track the accepted strength; the swell
   * starts on the event, not the motion, so the feedback lands with the wake.
   */
  private gustWhoosh(detail: unknown): void {
    this.gustAgeS = 0;
    let level = 0.7;
    if (detail != null && typeof detail === 'object' && 'strength' in detail) {
      const candidate = detail.strength;
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        level = Math.min(1, Math.max(0.25, candidate));
      }
    }
    const ctx = this.ensureContext();
    if (ctx == null || ctx.state !== 'running' || this.master == null) return;
    const t = ctx.currentTime;
    const white = makeNoiseBuffer(ctx, false);
    const source = ctx.createBufferSource();
    source.buffer = white;
    source.loop = true;
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.Q.value = 1.1;
    bandpass.frequency.setValueAtTime(500 + level * 500, t);
    bandpass.frequency.exponentialRampToValueAtTime(240, t + 0.55);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.1 + level * 0.22, t + 0.09);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    connectAudio(source, bandpass, env, this.master);
    source.start(t);
    source.stop(t + 0.8);
  }
}
