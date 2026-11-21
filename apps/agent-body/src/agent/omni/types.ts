/** Conversation shapes shared by the prompt renderer and the generation loop. */

/** One content part of a turn. Media parts render as placeholders; text as prose. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image' }
  | { type: 'video' }
  | { type: 'audio' }
  | { type: 'audio_out' };

export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export type OmniTurnRole = 'system' | 'user' | 'assistant' | 'tool';

export interface OmniTurn {
  role: OmniTurnRole;
  content: ContentPart[];
  /** Assistant turns may carry tool calls; tool turns name the tool they answer. */
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

/** OpenAI-style schema handed to the template's tools block. */
export interface ToolSchema {
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/** Placeholder expansion counts: one entry per image/video/audio part, in order. */
export interface MediaCounts {
  images: number[];
  videos: number[];
  audios: number[];
}
