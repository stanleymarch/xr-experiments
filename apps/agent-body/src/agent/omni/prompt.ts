/**
 * Chat-template rendering for LiquidAI/LFM3-Omni-2B. The official template
 * (tests/fixtures/chat_template.jinja, from LiquidAI/LFM3-Omni-2B) is rendered
 * with @huggingface/jinja; `<|mixed_start|>` (speech out) is appended after the
 * generation prompt exactly as brvtl/act-it-out verified (MIT). The template's
 * `{%- generation -%}` marker (a vLLM/SGLang generation-boundary tag) is
 * stripped before rendering: @huggingface/jinja does not implement it and it
 * carries no content.
 */
import { Template } from '@huggingface/jinja';
import type { MediaCounts, OmniTurn, ToolSchema } from './types';

export const ASR_SYSTEM = 'Perform ASR in English.';
export const INTERLEAVED_SYSTEM = 'Respond with interleaved text and audio.';

const BOS = '<|startoftext|>';

/** The generation-boundary tag carries no content; the tokenizer does not need it. */
function stripGenerationTag(template: string): string {
  return template.replace(/^\s*\{%-?\s*generation\s*-?%\}\s*$/gm, '').replace(/^\s*\{%-?\s*endgeneration\s*-?%\}\s*$/gm, '');
}

let cachedTemplate: { source: string; compiled: Template } | null = null;

function compile(source: string): Template {
  if (cachedTemplate?.source === source) return cachedTemplate.compiled;
  const compiled = new Template(stripGenerationTag(source));
  cachedTemplate = { source, compiled };
  return compiled;
}

function contentToTemplateValue(turn: OmniTurn): unknown {
  if (turn.role === 'assistant') {
    const text = turn.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    return {
      role: 'assistant',
      content: text,
      ...(turn.toolCalls?.length ? { tool_calls: turn.toolCalls } : {}),
    };
  }
  if (turn.role === 'tool') {
    const text = turn.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    return { role: 'tool', tool_call_id: turn.toolCallId ?? turn.toolCallId === '' ? '' : (turn.toolCallId ?? ''), content: text };
  }
  return { role: turn.role, content: turn.content.map((part) => ({ ...part })) };
}

export interface ConversationOptions {
  addGenerationPrompt: boolean;
  /** Speech out opens the reply with <|mixed_start|> (act-it-out's verified shape). */
  speech?: boolean;
  /** OpenAI-style tool schemas rendered into the system prompt's <tools> block. */
  tools?: ToolSchema[];
}

/**
 * Renders the pinned template for one conversation. Media parts render as single
 * placeholders here; expandMedia() scales them to the processor's grid counts.
 */
export function buildConversation(templateSource: string, turns: OmniTurn[], options: ConversationOptions): string {
  const compiled = compile(templateSource);
  const first = turns[0];
  const system = first?.role === 'system' ? first : null;
  const messages = (system ? turns.slice(1) : turns).map(contentToTemplateValue);
  const rendered = compiled.render({
    bos_token: BOS,
    eos_token: '<|im_end|>',
    messages: system ? [{ role: 'system', content: system.content.map((part) => ({ ...part })) }, ...messages] : messages,
    tools: options.tools ?? null,
    add_generation_prompt: options.addGenerationPrompt,
    enable_thinking: false,
  });
  return options.speech ? `${rendered}<|mixed_start|>` : rendered;
}

/**
 * Scales each media placeholder to the processor's token count, in order: one
 * `<|image|>` per t·h·w / merge² cell of its grid (act-it-out's expandVideo for
 * video, the same rule for still images and audio clips).
 */
export function expandMedia(prompt: string, counts: MediaCounts): string {
  let imageIndex = 0;
  let videoIndex = 0;
  let audioIndex = 0;
  return prompt.replace(/<\|vision_start\|><\|(image|video|audio)\|><\|vision_end\|>/g, (_match, kind: string) => {
    if (kind === 'image') {
      const count = counts.images[imageIndex++] ?? 1;
      return `<|vision_start|>${'<|image|>'.repeat(count)}<|vision_end|>`;
    }
    if (kind === 'video') {
      const count = counts.videos[videoIndex++] ?? 1;
      return `<|vision_start|>${'<|video|>'.repeat(count)}<|vision_end|>`;
    }
    const count = counts.audios[audioIndex++] ?? 1;
    return `<|vision_start|>${'<|audio|>'.repeat(count)}<|vision_end|>`;
  });
}

const TOOL_CALL_RE = /<tool_call>\s*<function=([A-Za-z0-9_.-]+)>\s*([\s\S]*?)<\/function>\s*<\/tool_call>/g;
const PARAMETER_RE = /<parameter=([A-Za-z0-9_.-]+)>\s*([\s\S]*?)\s*<\/parameter>/g;

/**
 * Parses the template's tool-call syntax out of an assistant reply. Values are
 * strings when the model wrote them bare and JSON when it wrote JSON; unknown
 * tool names return null (the zod schemas reject unknown payloads later).
 */
export function parseToolCall(text: string, names: readonly string[]): { name: string; args: Record<string, unknown> } | null {
  TOOL_CALL_RE.lastIndex = 0;
  const match = TOOL_CALL_RE.exec(text);
  if (!match) return null;
  const name = match[1];
  if (!names.includes(name)) return null;
  const args: Record<string, unknown> = {};
  const body = match[2];
  PARAMETER_RE.lastIndex = 0;
  let parameter: RegExpExecArray | null;
  while ((parameter = PARAMETER_RE.exec(body)) !== null) {
    const key = parameter[1];
    const value = parameter[2];
    try {
      args[key] = JSON.parse(value);
    } catch {
      args[key] = value;
    }
  }
  return { name, args };
}

/**
 * Drops the oldest complete user/assistant exchange to make room for a new
 * turn (both reference engines do this on ContextOverflow). A complete
 * exchange is a user turn followed by an assistant reply; the oldest such
 * pair is removed in place. Returns false when nothing can be dropped.
 */
export function dropOldestExchange(turns: OmniTurn[]): boolean {
  for (let index = 0; index < turns.length; index++) {
    if (turns[index].role !== 'user') continue;
    const reply = turns[index + 1];
    if (reply?.role === 'assistant') {
      turns.splice(index, 2);
      return true;
    }
  }
  return false;
}
