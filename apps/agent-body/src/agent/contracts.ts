/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { Object3D } from '@iwsdk/core';

/**
 * Shared contracts for the agent-body M0 slices. These types are the seam
 * between the state store (Dexie/MiniSearch), the agent UI panel, and the
 * VRM body driver. Runtime-agnostic: nothing here may import XR-, DOM-, or
 * mode-specific code, so desktop and MR share one implementation.
 */

// ---------------------------------------------------------------------------
// Settings & memory (implemented by src/agent/state.ts)
// ---------------------------------------------------------------------------

export interface AgentSettings {
  /** Display name shown on the agent panel and used in future prompts. */
  agentName: string;
  /** Master switch for procedural idle motion (breath/sway). */
  idleMotion: boolean;
  /** Whether the avatar's gaze tracks the viewer. */
  gazeTracking: boolean;
  /**
   * LLM endpoint base URL for the M1 brain (OpenAI-compatible, e.g.
   * `https://host/v1`). Empty string = scripted fallback brain. Stored
   * locally only (IndexedDB); never bundled.
   */
  modelEndpoint: string;
  /** Model id at modelEndpoint (e.g. `gpt-4o-mini`). */
  modelId: string;
  /**
   * User-owned API key for modelEndpoint. Stored only in this browser's
   * IndexedDB; never bundled or synced.
   */
  modelApiKey: string;
  /** Empty URL selects the bundled Ava VRM preset. */
  characterVrmUrl: string;
  characterPrompt: string;
  characterScale: number;
  speechLanguage: string;
  ttsProvider: 'off' | 'browser' | 'local' | 'openai';
  ttsEndpoint: string;
  ttsModel: string;
  ttsVoice: string;
  ttsApiKey: string;
  sttProvider: 'off' | 'browser' | 'local' | 'openai';
  sttEndpoint: string;
  sttModel: string;
  sttApiKey: string;
}

export type MemoryKind = 'note' | 'fact' | 'chat';

export interface MemoryRecord {
  id?: number;
  text: string;
  kind: MemoryKind;
  createdAt: number; // epoch ms
  role?: 'user' | 'assistant';
}

export interface AgentState {
  /** Resolves when the DB is open and the search index is warm. */
  readonly ready: Promise<void>;

  getSettings(): AgentSettings;
  updateSettings(patch: Partial<AgentSettings>): Promise<void>;
  /** Subscription; returns unsubscribe. */
  onSettingsChanged(cb: (settings: AgentSettings) => void): () => void;

  addMemory(text: string, kind: MemoryKind, role?: 'user' | 'assistant'): Promise<MemoryRecord>;
  recentMemories(limit: number): Promise<MemoryRecord[]>;
  searchMemories(query: string, limit: number): Promise<MemoryRecord[]>;
  clearMemories(): Promise<void>;
  /** Fires after any memory mutation (add/clear). */
  onMemoriesChanged(cb: () => void): () => void;
}

// ---------------------------------------------------------------------------
// VRM body driver (implemented by src/avatar.ts via src/avatar-body.ts)
// ---------------------------------------------------------------------------

export type AvatarExpressionName =
  | 'blink'
  | 'aa'
  | 'ih'
  | 'ou'
  | 'ee'
  | 'oh'
  | 'happy'
  | 'angry'
  | 'sad'
  | 'relaxed'
  | 'surprised'
  | (string & {});
/** Reply-driven emotion vocabulary (VRM 1.0 preset expressions). */
export type CueEmotion =
  | 'neutral'
  | 'happy'
  | 'angry'
  | 'sad'
  | 'relaxed'
  | 'surprised';

/** Reply gesture vocabulary: licensed VRMA clips where supplied, procedural otherwise. */
export type CueGesture = 'none' | 'wave' | 'nod' | 'shake' | 'think' | 'bow';

/** One avatar performance delivered alongside a model reply. */
export interface AvatarCue {
  readonly emotion: CueEmotion;
  readonly gesture: CueGesture;
}


export interface AvatarBody {
  /** True once the VRM scene graph exists and expressions can be driven. */
  readonly available: boolean;
  /** Weight 0..1 for a VRM 1.0 expression; ignored while unavailable. */
  setExpression(name: AvatarExpressionName, weight: number): void;
  /**
   * Audio playback owns this state. Mouth movement is approximate, not
   * provider-aligned phoneme timing.
   */
  setTalking(active: boolean): void;
  /**
   * Feed the text currently being spoken (e.g. streamed LLM tokens) so the
   * mouth driver can pick visemes from its vowel content. Cheap; call per
   * chunk. Only meaningful while talking.
   */
  speakChunk(text: string): void;
  /** Point the avatar's gaze at a world object (e.g. the camera/player head). */
  setAttentionTarget(target: Object3D | null): void;
  /** Disable/enable procedural idle (breath/sway). Blink always stays. */
  setIdleMotion(enabled: boolean): void;
  /**
   * Perform one reply-driven emotion + gesture. `null` clears the current
   * cue and restores the rest pose. Ignored while unavailable.
   */
  playCue(cue: AvatarCue | null): void;
  /** True while a cued emotion or gesture is still running. */
  readonly performing: boolean;
}
