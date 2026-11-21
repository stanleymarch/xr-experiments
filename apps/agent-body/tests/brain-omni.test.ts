import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const omniRespond = vi.fn();
const omniAsr = vi.fn();
vi.mock('../src/agent/omni/omni-client', () => ({
  omniClient: {
    ensureLoaded: async () => undefined,
    respond: (request: unknown, handlers: unknown) => omniRespond(request, handlers),
    asr: (pcm: Float32Array) => omniAsr(pcm),
    cancel: () => undefined,
    loaded: true,
  },
  onOmniStatus: (cb: (s: string) => void) => {
    void cb('');
    return () => undefined;
  },
  getOmniStatus: () => '',
  installDevHarness: () => undefined,
}));
vi.mock('../src/agent/omni/capability', () => ({
  peekOmniCapability: () => ({ capable: true, reason: '' }),
  getOmniCapability: async () => ({ capable: true, reason: '' }),
}));
vi.mock('../src/agent/omni/omni-voice', () => ({
  speakOmniReply: vi.fn(() => ({ onAudio: () => undefined, finish: async () => undefined })),
  stopOmniPlayback: vi.fn(),
}));
vi.mock('../src/agent/perception', () => ({
  getRoomContext: () => 'ROOM-METADATA',
  getRoomSummary: () => 'ROOM-SUMMARY',
  capturePhoto: vi.fn(async () => ({ dataUrl: 'data:image/jpeg;base64,AA', source: 'webcam', capturedAt: 0 })),
  onPerceptionStatus: (cb: (s: string) => void) => {
    void cb('');
    return () => undefined;
  },
  bindPerception: () => () => undefined,
}));
vi.mock('../src/avatar-body', () => ({
  avatarBody: {
    available: true,
    setExpression: vi.fn(),
    setTalking: vi.fn(),
    speakChunk: vi.fn(),
    setAttentionTarget: vi.fn(),
    setIdleMotion: vi.fn(),
    playCue: vi.fn(),
    performing: false,
  },
}));

import { agentState } from '../src/agent/state';
import { agentBrain } from '../src/agent/brain';
import { onAvatarCue, publishAvatarCue } from '../src/agent/cues';
import { DEFAULT_SETTINGS } from '../src/agent/settings';
import type { OmniRespondRequest } from '../src/agent/omni/omni-client';

/** Scripted omni reply: streams one audio chunk and resolves with text (optionally a tool call). */
function scriptReply(text: string, toolCall?: { name: string; args: Record<string, unknown> }) {
  omniRespond.mockImplementation(async (request: OmniRespondRequest, handlers: { onAudio?: (pcm: Float32Array) => void; onToolCall?: (n: string, a: Record<string, unknown>) => void }) => {
    handlers.onAudio?.(new Float32Array(2400));
    if (toolCall) handlers.onToolCall?.(toolCall.name, toolCall.args);
    return { text, spokenFrames: 30 };
  });
}

async function resetState(): Promise<void> {
  await agentState.ready;
  await agentState.clearMemories();
  publishAvatarCue(null);
  agentBrain.resetConversation();
  await agentState.updateSettings({
    ...DEFAULT_SETTINGS,
    agentName: 'Ava',
    modelEndpoint: 'local://webllm',
    modelId: 'auto',
    speechLanguage: 'en-US',
  });
}

beforeEach(resetState);

describe('agentBrain omni path', () => {
  it('sendVoice transcribes, replies with speech and records both turns', async () => {
    omniAsr.mockResolvedValue('Hello there.');
    scriptReply('Hi! I am Ava.');
    const cues: unknown[] = [];
    const unsubscribe = onAvatarCue((cue) => cues.push(cue));

    const reply = await agentBrain.sendVoice(new Float32Array(16000).fill(0.01));

    expect(reply).toBe('Hi! I am Ava.');
    expect(omniAsr).toHaveBeenCalledTimes(1);
    const request = omniRespond.mock.calls[0][0] as OmniRespondRequest;
    expect(request.speech).toBe(true);
    // The user audio turn plus persona system turn with room context.
    expect(request.turns[0].role).toBe('system');
    expect(JSON.stringify(request.turns[0].content)).toContain('ROOM-METADATA');
    expect(request.turns.at(-1)?.role).toBe('user');
    expect(request.turns.at(-1)?.content.some((part) => part.type === 'audio')).toBe(true);
    // The transcript, not the audio, lands in the chat log.
    const records = await agentState.recentMemories(Number.MAX_SAFE_INTEGER);
    const chat = records.filter((record) => record.kind === 'chat');
    expect(chat.map((record) => record.text)).toEqual(['Hi! I am Ava.', 'Hello there.']);
    unsubscribe();
  });

  it('executes avatar_perform and memory_write tool calls locally', async () => {
    omniAsr.mockResolvedValue('Remember my favorite color is teal.');
    scriptReply('Noted.', { name: 'memory_write', args: { text: 'favorite color is teal', kind: 'fact' } });

    await agentBrain.sendVoice(new Float32Array(8000).fill(0.02));

    const records = await agentState.recentMemories(20);
    expect(records.some((record) => record.kind === 'fact' && record.text === 'favorite color is teal')).toBe(true);
  });

  it('emits the avatar cue from avatar_perform', async () => {
    omniAsr.mockResolvedValue('Look, a wave!');
    scriptReply('Hello!', { name: 'avatar_perform', args: { emotion: 'happy', gesture: 'wave' } });
    let cue: unknown = null;
    const unsubscribe = onAvatarCue((next) => { cue = next; });

    await agentBrain.sendVoice(new Float32Array(8000).fill(0.02));

    expect(cue).toEqual({ emotion: 'happy', gesture: 'wave' });
    unsubscribe();
  });

  it('refuses the omni path when the pipeline resolves elsewhere', async () => {
    await agentState.updateSettings({ speechLanguage: 'ru-RU' });
    const settings = agentState.getSettings();
    expect(settings.speechLanguage).toBe('ru-RU');
    await expect(agentBrain.sendVoice(new Float32Array(8000))).rejects.toThrow(/omni/i);
    expect(omniRespond).not.toHaveBeenCalled();
    expect(omniAsr).not.toHaveBeenCalled();
  });

  it('typed text also goes through the omni engine with speech', async () => {
    scriptReply('A typed reply.');
    const reply = await agentBrain.send('Connection test: hello');
    expect(reply).toBe('A typed reply.');
    const request = omniRespond.mock.calls[0][0] as OmniRespondRequest;
    expect(request.speech).toBe(true);
    expect(request.turns.at(-1)?.content[0]).toEqual({ type: 'text', text: 'Connection test: hello' });
  });

  it('exposes the tool schemas for the cue and memory tools', async () => {
    scriptReply('ok');
    await agentBrain.send('hello');
    const request = omniRespond.mock.calls[0][0] as OmniRespondRequest;
    const names = (request.tools ?? []).map((tool) => tool.function.name);
    // Memory recall is pre-supplied in the prompt, so there is no
    // memory_search tool (see the Task 7 ruling in the ledger).
    expect(names).toEqual(['avatar_perform', 'memory_write']);
    expect(request.toolNames).toEqual(['avatar_perform', 'memory_write']);
  });
});
