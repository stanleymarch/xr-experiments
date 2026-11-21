/**
 * Messages between the main thread (omni-client.ts) and the omni worker
 * (omni.worker.ts). Media arrays are transferred, never copied.
 */
import type { ImagePixels } from './patchify';
import type { LoadProgressMessage } from './runtime';
import type { OmniTurn, ToolSchema } from './types';

export interface RespondPayload {
  id: number;
  turns: OmniTurn[];
  tools?: ToolSchema[];
  speech: boolean;
  toolNames?: readonly string[];
  media?: { image?: ImagePixels; audioPcm?: Float32Array };
}

export type WorkerInbound =
  | { type: 'load'; template: string }
  | { type: 'respond'; payload: RespondPayload }
  | { type: 'asr'; id: number; pcm: Float32Array }
  | { type: 'cancel'; id: number };

export type WorkerOutbound =
  | { type: 'progress'; progress: LoadProgressMessage }
  | { type: 'ready' }
  | { type: 'loadError'; message: string }
  | { type: 'text'; id: number; delta: string }
  | { type: 'audio'; id: number; pcm: Float32Array }
  | { type: 'tool'; id: number; name: string; args: Record<string, unknown> }
  | { type: 'transcript'; id: number; text: string }
  | { type: 'done'; id: number; text: string; spokenFrames: number }
  | { type: 'error'; id: number; message: string };
