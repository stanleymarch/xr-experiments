import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stopOmniPlayback = vi.fn();
vi.mock('../src/agent/omni/omni-voice', () => ({
  speakOmniReply: vi.fn(),
  stopOmniPlayback: () => stopOmniPlayback(),
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

import { hush } from '../src/agent/tts';
import { avatarBody } from '../src/avatar-body';

beforeEach(() => {
  stopOmniPlayback.mockClear();
  vi.mocked(avatarBody.setTalking).mockClear();
});

describe('hush', () => {
  it('stops omni playback and clears the talking state', () => {
    hush();
    expect(stopOmniPlayback).toHaveBeenCalledTimes(1);
    expect(avatarBody.setTalking).toHaveBeenCalledWith(false);
  });
});
