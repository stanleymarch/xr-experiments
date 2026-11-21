/** The bundled model has no embedded animation clips; its idle is procedural. */
export const BUNDLED_CHARACTER_PRESET = Object.freeze({
  id: 'ava',
  title: 'Ava',
  modelName: 'ab-1',
  format: 'VRM 1.0',
  description: 'Ava uses the bundled ab-1 model (optimized, 6.4 MB) with procedural blinking, breathing and sway. The model contains no embedded animation clips or animation pack.',
});

export interface CharacterStatus {
  /** True when an avatar is visible, including during replacement or failure. */
  ready: boolean;
  /** Resolved URL of the requested model (empty before the system starts). */
  source: string;
  /** Empty on success/loading; a failed replacement leaves the old avatar visible. */
  error: string;
}

let status: CharacterStatus = { ready: false, source: '', error: '' };
const listeners = new Set<(status: CharacterStatus) => void>();

export function getCharacterStatus(): CharacterStatus {
  return { ...status };
}

/** Subscribes to changes and immediately delivers the current snapshot. */
export function onCharacterStatus(cb: (status: CharacterStatus) => void): () => void {
  listeners.add(cb);
  cb(getCharacterStatus());
  return () => listeners.delete(cb);
}

/** AvatarSystem owns publication; UI consumers use the snapshot/subscription. */
export function setCharacterStatus(next: CharacterStatus): void {
  status = { ...next };
  for (const listener of listeners) {
    try {
      listener(getCharacterStatus());
    } catch (error) {
      console.error('[character] status listener failed', error);
    }
  }
}
