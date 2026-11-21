import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASR_SYSTEM,
  INTERLEAVED_SYSTEM,
  buildConversation,
  dropOldestExchange,
  expandMedia,
  parseToolCall,
  type OmniTurn,
} from '../src/agent/omni/prompt';

const TEMPLATE = readFileSync(new URL('../src/agent/omni/chat-template.jinja', import.meta.url), 'utf8');

const system: OmniTurn = { role: 'system', content: [{ type: 'text', text: 'You are Ava.' }] };
const user: OmniTurn = { role: 'user', content: [{ type: 'text', text: 'Hello.' }] };

describe('buildConversation', () => {
  it('matches the hand-verified base prompt for a plain text turn', () => {
    const rendered = buildConversation(TEMPLATE, [system, user], { addGenerationPrompt: true });
    const handBuilt =
      '<|startoftext|>' +
      '<|im_start|>system\nYou are Ava.<|im_end|>\n' +
      '<|im_start|>user\nHello.<|im_end|>\n' +
      '<|im_start|>assistant\n<think></think>';
    expect(rendered).toBe(handBuilt);
  });

  it('appends <|mixed_start|> when speech is requested', () => {
    const rendered = buildConversation(TEMPLATE, [user], { addGenerationPrompt: true, speech: true });
    expect(rendered.endsWith('<|im_start|>assistant\n<think></think><|mixed_start|>')).toBe(true);
  });

  it('emits the documented ASR and interleaved system prompts', () => {
    expect(ASR_SYSTEM).toBe('Perform ASR in English.');
    expect(INTERLEAVED_SYSTEM).toBe('Respond with interleaved text and audio.');
    const asr = buildConversation(TEMPLATE, [
      { role: 'system', content: [{ type: 'text', text: ASR_SYSTEM }] },
      { role: 'user', content: [{ type: 'audio' }] },
    ], { addGenerationPrompt: true });
    expect(asr).toContain('<|vision_start|><|audio|><|vision_end|>');
  });

  it('renders tool definitions into the system prompt', () => {
    const rendered = buildConversation(TEMPLATE, [system, user], {
      addGenerationPrompt: true,
      tools: [{
        function: {
          name: 'avatar_perform',
          description: 'Pick an expression.',
          parameters: { type: 'object', properties: { emotion: { type: 'string' } } },
        },
      }],
    });
    expect(rendered).toContain('<tools>');
    expect(rendered).toContain('"name": "avatar_perform"');
    expect(rendered).toContain('<|im_start|>assistant\n<think></think>');
  });

  it('renders prior tool calls and the tool response turn', () => {
    const withCall: OmniTurn = {
      role: 'assistant',
      content: [],
      toolCalls: [{ function: { name: 'avatar_perform', arguments: { emotion: 'happy', gesture: 'none' } } }],
    };
    const result: OmniTurn = { role: 'tool', toolCallId: 'avatar_perform', content: [{ type: 'text', text: '{"queued":true}' }] };
    const rendered = buildConversation(TEMPLATE, [system, user, withCall, result], { addGenerationPrompt: true });
    expect(rendered).toContain('<tool_call>\n<function=avatar_perform>');
    expect(rendered).toContain('<parameter=emotion>\nhappy\n</parameter>');
    expect(rendered).toContain('<tool_response>\n{"queued":true}\n</tool_response>');
  });
});

describe('expandMedia', () => {
  it('expands each placeholder to its processor grid count in order', () => {
    const prompt = 'a<|vision_start|><|image|><|vision_end|>b<|vision_start|><|image|><|vision_end|>c<|vision_start|><|audio|><|vision_end|>d';
    const expanded = expandMedia(prompt, { images: [3, 1], videos: [], audios: [2] });
    expect(expanded).toBe('a<|vision_start|><|image|><|image|><|image|><|vision_end|>b<|vision_start|><|image|><|vision_end|>c<|vision_start|><|audio|><|audio|><|vision_end|>d');
  });

  it('passes prompts without media through unchanged', () => {
    expect(expandMedia('<|im_end|>', { images: [], videos: [], audios: [] })).toBe('<|im_end|>');
  });
});

describe('parseToolCall', () => {
  const names = ['avatar_perform', 'memory_write'];

  it('parses the template tool-call syntax with typed parameters', () => {
    const text = 'Sure.\n<tool_call>\n<function=avatar_perform>\n<parameter=emotion>\nhappy\n</parameter>\n<parameter=gesture>\n"none"\n</parameter>\n</function>\n</tool_call>';
    const call = parseToolCall(text, names);
    expect(call).toEqual({ name: 'avatar_perform', args: { emotion: 'happy', gesture: 'none' } });
  });

  it('rejects unknown tool names and calls without a tool_call block', () => {
    expect(parseToolCall('just prose', names)).toBeNull();
    expect(
      parseToolCall('<tool_call>\n<function=run_arbitrary_code>\n</function>\n</tool_call>', names),
    ).toBeNull();
  });
});

describe('dropOldestExchange', () => {
  const history: OmniTurn[] = [
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'one' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'one-reply' }] },
    { role: 'user', content: [{ type: 'text', text: 'two' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'two-reply' }] },
  ];

  it('drops the oldest user/assistant pair and keeps the system turn', () => {
    const next = [...history];
    expect(dropOldestExchange(next)).toBe(true);
    expect(next.some((turn) => turn.role === 'system')).toBe(true);
    expect(next.some((turn) => turn.role === 'user' && turn.content[0]?.type === 'text' && turn.content[0].text === 'one')).toBe(false);
    expect(next.filter((turn) => turn.role === 'assistant')).toHaveLength(1);
  });

  it('does not drop an exchange that has no assistant reply yet', () => {
    const pending: OmniTurn[] = [system, { role: 'user', content: [{ type: 'text', text: 'one' }] }];
    expect(dropOldestExchange(pending)).toBe(false);
    expect(pending).toHaveLength(2);
  });

  it('returns false when there is no exchange to drop', () => {
    expect(dropOldestExchange([system, user])).toBe(false);
  });
});
