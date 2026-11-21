import { z } from 'zod';
import type { AvatarCue, CueEmotion, CueGesture } from './contracts.js';

export const CUE_EMOTIONS = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const satisfies readonly CueEmotion[];
export const CUE_GESTURES = ['none', 'wave', 'nod', 'shake', 'think', 'bow'] as const satisfies readonly CueGesture[];

/** Native tool arguments, separate from assistant prose. Unknown keys/values reject. */
export const avatarCueSchema = z.object({
  emotion: z.enum(CUE_EMOTIONS),
  gesture: z.enum(CUE_GESTURES),
}).strict();

/** Clearly labelled offline demonstration only; never substitutes for model inference. */
export function pickOfflineCue(text: string): AvatarCue {
  if (/\b(hi|hello|hey)\b|привет|здравств/iu.test(text)) return { emotion: 'happy', gesture: 'wave' };
  if (/thank|спасиб/iu.test(text)) return { emotion: 'happy', gesture: 'nod' };
  if (/\b(bye|goodbye)\b|пока|до свидан/iu.test(text)) return { emotion: 'relaxed', gesture: 'bow' };
  if (/sad|груст|плохо|устал|больно/iu.test(text)) return { emotion: 'sad', gesture: 'none' };
  if (/\b(no|nope)\b|(?:^|\s)нет(?:$|[\s,.!?])|не хочу/iu.test(text)) return { emotion: 'neutral', gesture: 'shake' };
  if (/remember|запомн|подумай|заметк|\bnote\b/iu.test(text)) return { emotion: 'neutral', gesture: 'think' };
  return { emotion: 'neutral', gesture: 'none' };
}

type CueListener = (cue: AvatarCue | null) => void;
const listeners = new Set<CueListener>();
let activeCue: AvatarCue | null = null;

export function onAvatarCue(listener: CueListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishAvatarCue(cue: AvatarCue | null): void {
  activeCue = cue;
  for (const listener of listeners) listener(cue);
}

export function getAvatarCue(): AvatarCue | null { return activeCue; }
