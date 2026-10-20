/**
 * REALITY//FIELD — the panel.
 *
 * The panel is an instrument, not the experience: it carries the mode
 * switch, the reset action and a compact readout of what the room currently
 * knows. Readouts refresh a few times per second — a panel that changes
 * every frame is unreadable and noisy in a headset.
 */

import { UIKitMLAsset, VisibilityState, createSystem } from '@iwsdk/core';
import type { UIKit } from '@iwsdk/core';
import { Field, FieldModes } from '../field-component.js';
import { fieldRuntime } from '../field/runtime.js';
import { fieldState, resetFieldState } from '../field/state.js';

/** Seconds between readout refreshes. */
const REFRESH_S = 0.25;

export class PanelSystem extends createSystem({
  field: { required: [Field] },
}) {
  private panel: UIKitMLAsset | null = null;
  private modeValue: UIKit.Text | null = null;
  private roomValue: UIKit.Text | null = null;
  private surfacesValue: UIKit.Text | null = null;
  private impactsValue: UIKit.Text | null = null;
  private gestureValue: UIKit.Text | null = null;
  private tensionValue: UIKit.Text | null = null;
  private fpsValue: UIKit.Text | null = null;
  private lastRefresh = -REFRESH_S;
  private frames = 0;
  private fpsWindow = 0;

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('field-panel');
    if (panel == null) return;
    this.panel = panel;
    this.modeValue = panel.getElementById<UIKit.Text>('mode-value') ?? null;
    this.roomValue = panel.getElementById<UIKit.Text>('room-value') ?? null;
    this.surfacesValue = panel.getElementById<UIKit.Text>('surfaces-value') ?? null;
    this.impactsValue = panel.getElementById<UIKit.Text>('impacts-value') ?? null;
    this.gestureValue = panel.getElementById<UIKit.Text>('gesture-value') ?? null;
    this.tensionValue = panel.getElementById<UIKit.Text>('tension-value') ?? null;
    this.fpsValue = panel.getElementById<UIKit.Text>('fps-value') ?? null;

    const xrButton = panel.getElementById('xr-button');
    const exitButton = panel.getElementById('exit-button');
    const modeButton = panel.getElementById('mode-button');
    const resetButton = panel.getElementById('reset-button');

    const launchXR = (): void => {
      void this.world.launchXR();
    };
    const exitXR = (): void => {
      void this.world.exitXR();
    };
    const toggleMode = (): void => {
      const next = fieldState.mode === 'dream' ? FieldModes.Debug : FieldModes.Dream;
      this.applyMode(next);
    };
    const reset = (): void => {
      fieldRuntime.wave.clear();
      resetFieldState();
      this.applyMode(fieldState.mode);
    };

    if (xrButton != null) {
      xrButton.addEventListener('click', launchXR);
      this.cleanupFuncs.push(() => xrButton.removeEventListener('click', launchXR));
    }
    if (exitButton != null) {
      exitButton.addEventListener('click', exitXR);
      this.cleanupFuncs.push(() => exitButton.removeEventListener('click', exitXR));
    }
    if (modeButton != null) {
      modeButton.addEventListener('click', toggleMode);
      this.cleanupFuncs.push(() => modeButton.removeEventListener('click', toggleMode));
    }
    if (resetButton != null) {
      resetButton.addEventListener('click', reset);
      this.cleanupFuncs.push(() => resetButton.removeEventListener('click', reset));
    }

    if (!this.world.xrEnabled) {
      xrButton?.setProperties({ display: 'none' });
      exitButton?.setProperties({ display: 'none' });
    }
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((visibilityState) => {
        const is2D = visibilityState === VisibilityState.NonImmersive;
        xrButton?.setProperties({ display: is2D ? 'flex' : 'none' });
        exitButton?.setProperties({ display: is2D ? 'none' : 'flex' });
      }),
    );
  }

  /**
   * Desktop shortcuts for the emulator and for debugging:
   * `D` toggles the debug view, `R` resets the field.
   */
  private handleShortcuts(): void {
    const keyboard = this.input.keyboard;
    if (keyboard == null) return;
    if (keyboard.getKeyDown('KeyD')) {
      this.applyMode(fieldState.mode === 'dream' ? FieldModes.Debug : FieldModes.Dream);
    }
    if (keyboard.getKeyDown('KeyR')) {
      fieldRuntime.wave.clear();
      resetFieldState();
    }
  }

  /** Apply a mode to the shared state and to the authored component. */
  private applyMode(mode: string): void {
    fieldState.mode = mode === FieldModes.Debug ? 'debug' : 'dream';
    for (const entity of this.queries.field.entities) {
      entity.setValue(Field, 'mode', fieldState.mode);
    }
  }

  update(delta: number, time: number): void {
    this.handleShortcuts();
    this.frames += 1;
    this.fpsWindow += delta;
    if (this.fpsWindow >= 0.5) {
      fieldState.fps = Math.round(this.frames / this.fpsWindow);
      this.frames = 0;
      this.fpsWindow = 0;
    }
    if (time - this.lastRefresh < REFRESH_S) return;
    this.lastRefresh = time;
    this.refresh();
  }

  /** Push the current state into the panel text. */
  private refresh(): void {
    this.modeValue?.setProperties({ text: fieldState.mode === 'debug' ? 'DEBUG' : 'DREAM' });
    this.roomValue?.setProperties({
      text:
        this.world.xrSession == null
          ? 'browser preview'
          : fieldState.roomStatus === 'mesh'
            ? 'room sensed'
            : 'searching...',
    });
    this.surfacesValue?.setProperties({ text: String(fieldState.surfaceCount) });
    this.impactsValue?.setProperties({ text: String(fieldState.impactCount) });
    this.gestureValue?.setProperties({ text: fieldState.gestureLabel });
    this.tensionValue?.setProperties({ text: fieldState.tension.toFixed(2) });
    this.fpsValue?.setProperties({ text: String(fieldState.fps) });
  }
}
