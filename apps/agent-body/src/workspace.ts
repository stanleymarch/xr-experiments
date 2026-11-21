import { createSystem, InputActions, InputComponent, ScreenSpace, SessionMode, UIKitMLAsset, Visibility, VisibilityState } from '@iwsdk/core';
import { Mesh, Quaternion, Vector3 } from 'three';
import qrcode from 'qrcode-generator';
import { reportBootIssue } from './boot-diagnostics.js';
import { agentState } from './agent/state.js';
import { FREE_PRESET, LOCAL_PRESET, PAID_PRESET, isLocalLlmEndpoint } from './agent/settings.js';
import { agentBrain } from './agent/brain.js';
import { getLocalLlmStatus, onLocalLlmStatus, warmLocalLlm } from './agent/local-llm.js';
import { describeLocalModel, LOCAL_MODELS, LOCAL_MODEL_AUTO, resolveLocalModel, setLocalImmersiveSession } from './agent/local-model.js';
import { describeVoice, listVoices, voiceCycle } from './agent/voices.js';
import type { AgentSettings, MemoryRecord } from './agent/contracts.js';
import { speak, hush, getSpeechStatus, onSpeechStatus } from './agent/tts.js';
import { startListening, cancelListening, type ListeningSession } from './agent/stt.js';
import { getCharacterStatus, onCharacterStatus, BUNDLED_CHARACTER_PRESET } from './agent/character.js';
import { buildCharacterCard, parseCharacterCard, serializeCharacterCard } from './agent/character-card.js';
import { getAvatarCue, onAvatarCue } from './agent/cues.js';
import { getPerceptionStatus, onPerceptionStatus, getRoomSummary } from './agent/perception.js';
import { getOmniStatus, onOmniStatus } from './agent/omni/omni-client.js';
import { resolvePipeline } from './agent/pipeline.js';
import { getOmniCapability } from './agent/omni/capability.js';
import { createPairingOffer, consumePairingUrl, parsePairingFragment, type PairingOffer } from './pairing.js';
import { HAPTIC_TICK, pulseHaptics } from './haptics.js';
import { PanelGrabSystem } from './panel-grab.js';
import { CHARACTER_FIELDS, CONNECTION_FIELDS, providerLabel, type SettingField, type WorkspaceTab, type ConnectionTab } from './workspace-fields.js';
import './workspace.css';

const TAB_LABELS: Record<WorkspaceTab, string> = { chat: 'Dialogue', character: 'Character', connections: 'Connections', memory: 'Memory' };
const SUB_LABELS: Record<ConnectionTab, string> = { llm: 'LLM', stt: 'STT', tts: 'TTS', transfer: 'Transfer' };

/**
 * Everything that belongs to the virtual reading room. Immersive-ar passthrough
 * already has the real room, so the whole virtual set - architecture,
 * colliders and grabbable props - is hidden there and only the panel remains.
 */
const VIRTUAL_ROOM_NODE_IDS = [
  'vr-space',
  'collider-floor',
  'collider-table',
  'collider-sideboard',
  'collider-sofa',
  'plant-sansevieria',
  'prop-book-rust',
  'prop-book-mustard',
  'prop-book-teal',
  'prop-book-navy',
  'prop-mug',
  'prop-vase',
  'prop-brass-sphere',
  'prop-keepsake-box',
  'prop-cushion-cream',
  'prop-cushion-sage',
];
/** The panel is smaller in an immersive session so it does not fill the view. */
const PANEL_XR_SCALE = 0.5;
/** Session frames over which the panel is placed before it is left alone. */
const PANEL_PLACEMENT_FRAMES = 30;

/**
 * The on-device model variants. Shown as chips on the LLM tab whenever the
 * draft points at the local endpoint, so "Full local" no longer hides which
 * models exist and what each one costs in download and VRAM.
 */
const LOCAL_MODEL_CHIPS: Record<string, string> = {
  'llm-model-auto': LOCAL_MODEL_AUTO,
  'llm-model-gemma': 'gemma3-1b-it-q4f16_1-MLC',
  'llm-model-smollm': 'SmolLM2-360M-Instruct-q4f16_1-MLC',
  'llm-model-qwen': 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
};
/** Draw the panel after the scene's transparent objects (see WorkspaceSystem.update). */
const PANEL_RENDER_ORDER = 20;
type EditorTarget = SettingField | 'chat' | 'note' | 'search' | 'pin' | 'card';

// Capture only in memory and remove the encrypted fragment before world bootstrap.
// No PIN or ciphertext is written to storage, analytics, or logs.
let pendingPairingUrl = typeof window !== 'undefined' && parsePairingFragment(window.location.hash) ? window.location.href : '';
if (pendingPairingUrl) window.history.replaceState(null, '', window.location.pathname + window.location.search);

/** One Horizon UIKitML surface and controller in browser, MR and VR. */
export class WorkspaceSystem extends createSystem({}) {
  /** The controller that drove the pointer last, for the haptic tick. */
  private lastHand: 'left' | 'right' = 'right';

  init(): void {
    // A throw inside setup used to kill the system silently: the panel kept its
    // authored `Visibility: false`, so the window showed the room and the avatar
    // with no interface and no explanation. The strip makes the reason visible.
    try {
      this.setup();
    } catch (error) {
      reportBootIssue('Workspace setup failed', error);
    }
  }

  private setup(): void {
    const world = this.world;
    const panel = world.getSceneObject<UIKitMLAsset>('agent-panel');
    const panelEntity = world.getSceneEntity('agent-panel');
    if (!panel || !panelEntity) {
      // The panel is a UIKitML asset from ui/agent.uikitml. Without it there is
      // no interface at all, and no DOM element to show in its place.
      reportBootIssue(
        'Panel asset "agent-panel" is missing from the scene',
        new Error('ui/agent.uikitml did not instantiate'),
      );
      return;
    }
    const authoredPanelScale = (panelEntity.object3D?.scale ?? new Vector3(1, 1, 1)).clone();
    // The session may move the panel anywhere the user dragged it; on the
    // desktop it must come back exactly where the scene authored it.
    const authoredPanelPosition = (panelEntity.object3D?.position ?? new Vector3()).clone();
    const authoredPanelQuaternion = (panelEntity.object3D?.quaternion ?? new Quaternion()).clone();
    // UIKit paints the panel in the transparent pass without depth writes, and
    // the renderer sorts transparent objects near-to-far for UI readability,
    // so the scene behind painted over the panel and it looked translucent.
    // See update(): the whole panel is drawn after the scene's transparent
    // objects instead.
    // Teleport aiming: IWSDK binds the arc to the thumbstick pushed down, so
    // the marker appears wherever that stick points. Holding the trigger aims
    // the arc as well, which is the gesture most people try first; the arc is
    // suppressed while the ray points at a panel button.
    world.input.actions.addBinding({
      source: 'xrGamepad',
      action: InputActions.LocomotionTeleportAim,
      kind: 'button',
      handedness: 'right',
      button: InputComponent.Trigger,
    });
    const disposers: (() => void)[] = [];
    let disposed = false;
    let receivingUrl = pendingPairingUrl;
    pendingPairingUrl = '';
    let receivingPin = '';
    let receivingBusy = false;
    let tab: WorkspaceTab = receivingUrl ? 'connections' : 'chat';
    let sub: ConnectionTab = receivingUrl ? 'transfer' : 'llm';
    let draft = agentState.getSettings();
    const pending: Partial<AgentSettings> = {};
    let busy = false;
    let capture: ListeningSession | null = null;
    let microphoneStarting = false;
    let records: MemoryRecord[] = [];
    let search = '';
    let page = 0;
    let recordGeneration = 0;
    let editing: EditorTarget | null = null;
    let composing = false;
    let confirmingClear = false;
    let pairing: PairingOffer | null = null;
    let pairingGeneration = 0;
    let pairingTimer: number | undefined;
    let pairingBusy = false;
    let supportsMR = false;
    let supportsVR = false;
    let cue = getAvatarCue();
    let cameraStatus = getPerceptionStatus();
    let localStatus = getLocalLlmStatus();
    let omniStatus = getOmniStatus();
    let omniCapable = false;

    // Native editing only: no duplicate DOM navigation, settings or business UI.
    // A focused DOM input is also the documented Quest system-keyboard bridge.
    const bridge = document.createElement('div');
    bridge.id = 'workspace-keyboard-bridge';
    bridge.hidden = true;
    const bridgeLabel = document.createElement('label');
    bridgeLabel.id = 'workspace-keyboard-label';
    const textInput = document.createElement('textarea');
    textInput.id = 'workspace-native-text';
    textInput.rows = 3;
    const secretInput = document.createElement('input');
    secretInput.id = 'workspace-native-secret';
    secretInput.type = 'password';
    for (const input of [textInput, secretInput]) {
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-labelledby', bridgeLabel.id);
    }
    bridge.append(bridgeLabel, textInput, secretInput);
    document.body.append(bridge);
    let input: HTMLTextAreaElement | HTMLInputElement = textInput;
    const setText = (id: string, text: string): void => {
      const element = panel.requireElementById(id) as unknown as {
        setProperties: (properties: Record<string, unknown>) => void;
        children?: { setProperties: (properties: Record<string, unknown>) => void }[];
      };
      element.setProperties({ text });
      // UIKit renders a Container's text through a child _Text with its own
      // style, so text rules on the Container alone do not reach the glyphs.
      const childStyle: Record<string, Record<string, unknown>> = {
        'workspace-body': { whiteSpace: 'pre-line' },
        'workspace-title': { textAlign: 'center' },
      };
      const style = childStyle[id];
      if (style) {
        for (const child of element.children ?? []) child.setProperties(style);
      }
    };
    const show = (id: string, visible: boolean): void => { panel.requireElementById(id).setProperties({ display: visible ? 'flex' : 'none' }); };
    // Horizon buttons paint their own hover/pressed theme layers above inline
    // colours, so a clicked chip would keep the dark pressed fill. Resolve the
    // same colour for every pointer state instead of only the resting one.
    const tintChip = (id: string, background: string): void => {
      const fill = { backgroundColor: background, hover: { backgroundColor: background }, active: { backgroundColor: background } };
      panel.requireElementById(id).setProperties(fill);
      panel.requireElementById(`${id}-label`).setProperties({ color: '#202124', hover: { color: '#202124' }, active: { color: '#202124' } });
    };
    const feedback = (text: string, error = false): void => {
      if (disposed) return;
      setText('workspace-feedback', text);
      panel.requireElementById('workspace-feedback').setProperties({ color: error ? '#a50e0e' : '#174ea6' });
    };
    const reportError = (error: unknown): void => feedback(error instanceof Error ? error.message : String(error), true);
    const changeDraft = (patch: Partial<AgentSettings>): void => {
      Object.assign(pending, patch);
      Object.assign(draft, patch);
    };
    const currentFields = (): SettingField[] => {
      if (tab === 'character') return CHARACTER_FIELDS;
      if (tab !== 'connections' || sub === 'transfer') return [];
      const fields = CONNECTION_FIELDS[sub];
      if (sub === 'llm') return fields;
      const provider = draft[sub === 'stt' ? 'sttProvider' : 'ttsProvider'];
      return fields.filter((field) => field.kind === 'provider' ||
        (provider !== 'off' && field.key === 'speechLanguage') ||
        (provider === 'local' && (field.key === 'sttModel' || field.key === 'ttsModel')) ||
        (provider === 'browser' && field.key === 'ttsVoice') || provider === 'openai');
    };
    const visibleRecords = (): MemoryRecord[] => records.filter((record) => tab === 'chat' ? record.kind === 'chat' : record.kind !== 'chat');
    const refreshRoom = (): void => {
      setText('room-status', getRoomSummary());
    };
    const renderPanel = (): void => {
      if (disposed) return;
      const settings = agentState.getSettings();
      const fields = currentFields();
      const character = tab === 'character';
      const connection = tab === 'connections';
      const transfer = connection && sub === 'transfer';
      const history = tab === 'chat' || tab === 'memory';
      setText('workspace-title', `${settings.agentName} / ${TAB_LABELS[tab]}`);
      const motion = cue && (cue.emotion !== 'neutral' || cue.gesture !== 'none') ? ` / ${cue.emotion} / ${cue.gesture}` : '';
      const local = isLocalLlmEndpoint(settings.modelEndpoint);
      const pipeline = resolvePipeline(settings, { capable: omniCapable }, false);
      const omni = pipeline === 'omni';
      const omniProgress = omni && omniStatus ? ` / ${omniStatus}` : '';
      const localProgress = local && !omni && localStatus ? ` / ${localStatus}` : '';
      const modelLabel = omni
        ? 'LFM3-Omni-2B (WebGPU), local'
        : local ? `${describeLocalModel(settings.modelId)}, local WebGPU` : settings.modelId;
      setText('workspace-status', `${Object.keys(pending).length ? 'Unsaved changes / ' : ''}${agentBrain.mode === 'live' ? `LLM: ${modelLabel}` : 'Offline demo / no authenticated LLM'}${localProgress}${omniProgress}${motion}`);
      for (const key of Object.keys(TAB_LABELS) as WorkspaceTab[]) tintChip(`nav-${key}`, tab === key ? '#d2e3fc' : '#f1f3f4');
      for (const key of Object.keys(SUB_LABELS) as ConnectionTab[]) tintChip(`sub-${key}`, sub === key ? '#d2e3fc' : '#f1f3f4');
      show('connection-tabs', connection);
      show('camera-status', tab === 'chat');
      show('room-status', tab === 'chat');
      setText('camera-status', cameraStatus);
      refreshRoom();
      let body = '';
      if (history) {
        const items = visibleRecords();
        page = Math.min(page, Math.max(0, items.length - 1));
        const record = items[page];
        body = record ? `${record.kind === 'chat' ? record.role === 'user' ? 'You' : settings.agentName : record.kind.toUpperCase()}\n${record.text}` : tab === 'chat' ? 'Write a message, use the microphone, or explicitly request Look / camera. Camera frames are never captured in the background.' : search ? `No saved notes/facts matching: ${search}` : 'No saved facts or notes. Add a note or let the agent save a fact during dialogue.';
        setText('workspace-page', `${items.length ? page + 1 : 0} / ${items.length}${search && tab === 'memory' ? ' / search' : ''}`);
      } else if (character) {
        const status = getCharacterStatus();
        body = `${draft.characterVrmUrl ? 'Custom VRM' : BUNDLED_CHARACTER_PRESET.modelName}\n${status.error || (status.ready ? 'Avatar ready in the shared scene.' : 'Loading avatar...')}\nPreset restores the bundled character. Select any field to edit; Save applies your draft.`;
      } else if (transfer) {
        body = receivingUrl ? 'Encrypted settings received. Enter the 6-digit PIN from the sending device, then Apply settings. The link expires after 10 minutes. Skip discards this link without changing your settings.' : 'Encrypted settings transfer. Save settings first, generate a QR, then scan/open its link on the receiver and enter the PIN. QR + PIN together are secret. Expires after 10 minutes. No memory or dialogue is transferred.';
      } else {
        body = sub === 'llm' ? 'Presets fill this draft; Save applies them. Full local runs the LFM3-Omni voice model on this device in English (speech in and out, photos, memory tools): no key, no audio and no text leaves the device. Russian falls back to the WebLLM + Whisper + OS-voice stack. Free APIs uses OpenRouter Nemotron free with the free browser/OS speech of this machine. Paid APIs uses Gemma 4 31B and asks OpenRouter to sort providers by price. API keys are never copied or cleared by a preset and are never bundled. Local variants: Auto picks a model for this device (desktop Gemma 3 1B, headset or ≤4 GB SmolLM2 360M) and the chips below pin one explicitly.' : sub === 'stt' ? 'Independent speech recognition. The browser engine is free: with the on-device speech pack it never uploads audio, otherwise the browser vendor recognises it in the cloud. On-device Whisper runs through WebGPU, downloads once, and never uploads audio. OpenAI-compatible STT records only while active. Test records and displays a transcript without sending it to the LLM.' : 'Independent speech output. The browser voice is the free OS voice of this machine, a female voice is picked first and Next voice cycles them. The on-device voice (MMS TTS) never sends the text anywhere, but it is much harder to understand than the OS voice. The Fish free preset uses the OpenAI-compatible audio/speech endpoint instead. Copy LLM key to TTS is an explicit separate action.';
      }
      setText('workspace-body', body);
      show('record-navigation', history && !editing);
      show('workspace-fields', fields.length > 0 && !editing);
      for (let index = 0; index < 6; index++) {
        const field = fields[index];
        show(`field-${index}`, Boolean(field));
        if (!field) continue;
        const value = draft[field.key];
        const label = field.kind === 'secret' ? value ? 'Stored (hidden); blank retains' : 'Not set' : field.kind === 'toggle' ? value ? 'On' : 'Off' : field.kind === 'provider' ? providerLabel(field.key, value) : String(value || 'Not set');
        const text = `${field.label}: ${label}`;
        // Field rows are one line high: truncate the assembled label (prefix
        // included) so it cannot wrap into a second, clipped line.
        setText(`field-label-${index}`, text.length > 62 ? `${text.slice(0, 59)}...` : text);
      }
      show('chat-actions', tab === 'chat' && !editing);
      show('settings-actions', fields.length > 0 && !editing);
      show('workspace-test', connection && !transfer);
      setText('workspace-test-label', sub === 'stt' && capture ? 'Stop test' : `Test ${sub.toUpperCase()}`);
      show('workspace-clear-key', fields.some((field) => field.kind === 'secret'));
      show('workspace-preset', character);
      show('character-actions', character && !editing);
      show('llm-presets', connection && sub === 'llm' && !editing);
      // The local model variants only matter when the draft points at the
      // on-device stack; the chip of the drafted model is tinted.
      const localDraft = isLocalLlmEndpoint(draft.modelEndpoint);
      show('llm-models', connection && sub === 'llm' && !editing && localDraft);
      for (const [chip, modelId] of Object.entries(LOCAL_MODEL_CHIPS)) {
        tintChip(chip, connection && sub === 'llm' && draft.modelId === modelId ? '#d2e3fc' : '#f1f3f4');
      }
      show('connection-actions', connection && !transfer && !editing && sub === 'tts');
      show('workspace-copy-key', sub === 'tts');
      show('workspace-browser-voice', sub === 'tts' && draft.ttsProvider === 'browser');
      show('memory-actions', tab === 'memory' && !editing);
      setText('workspace-clear-label', confirmingClear ? 'Confirm clear' : 'Clear all');
      show('transfer-actions', transfer && !receivingUrl && !editing);
      show('receiver-actions', transfer && Boolean(receivingUrl) && !editing);
      setText('workspace-receiver-pin-label', receivingPin ? 'PIN entered (hidden)' : 'Enter receiver PIN');
      show('transfer-image', transfer && !receivingUrl && pairing != null);
      if (pairing) setText('pairing-pin', `PIN: ${pairing.pin}\nOpen link on receiver. Valid for 10 minutes. Treat QR + PIN as a secret.`);
      show('workspace-editor', editing != null);
      setText('workspace-listen-label', microphoneStarting ? 'Starting...' : capture ? 'Stop recording' : 'Microphone');
      show('workspace-enter-mr', !world.session && supportsMR);
      show('workspace-enter-vr', !world.session && supportsVR);
      show('workspace-exit', Boolean(world.session));
      // Inside a session the panel is a world object the user can grab, so it
      // gets a way back to the default spot and a hint about the grab.
      show('immersive-actions', Boolean(world.session));
      show('immersive-hint', Boolean(world.session));
    };
    /**
     * Guarded wrapper. Panel text is written into a UIKit document; if one id is
     * missing (an older ui/agent.uikitml still cached, a partially built
     * document) the throw must not stop the panel from being made visible.
     */
    const render = (): void => {
      try {
        renderPanel();
      } catch (error) {
        reportBootIssue('Panel update failed', error);
      }
    };
    disposers.push(onLocalLlmStatus((next) => {
      localStatus = next;
      if (!disposed) render();
    }));
    disposers.push(onOmniStatus((next) => {
      omniStatus = next;
      if (!disposed) render();
    }));
    void getOmniCapability().then((probe) => {
      if (disposed) return;
      omniCapable = probe.capable;
      if (!probe.capable && probe.reason) feedback(`Omni model unavailable: ${probe.reason}`);
      render();
    }).catch(() => { /* the probe never throws; kept for safety */ });
    const save = async (): Promise<boolean> => {
      try {
        const patch = { ...pending };
        await agentState.updateSettings(patch);
        if (disposed) return false;
        for (const key of Object.keys(patch) as (keyof AgentSettings)[]) {
          if (pending[key] === patch[key]) delete pending[key];
        }
        draft = { ...agentState.getSettings(), ...pending };
        // Applying the local preset starts the model download immediately and
        // shows its progress in the status line; the user does not have to
        // send a first message to discover where the "download" lives.
        const applied = agentState.getSettings();
        if (isLocalLlmEndpoint(applied.modelEndpoint)) {
          feedback('Saved on this device. The local model now downloads in the background - watch the status line.');
          void warmLocalLlm(applied.modelId);
        } else {
          feedback('Saved on this device.');
        }
        render(); return true;
      } catch (error) { reportError(error); return false; }
    };
    const submit = (text: string): void => {
      if (disposed || !text.trim() || busy) return;
      busy = true; feedback('Thinking...');
      void agentBrain.send(text.trim()).then(() => feedback('')).catch(reportError).finally(() => { busy = false; if (!disposed) render(); });
    };
    const submitVoice = (pcm: Float32Array): void => {
      if (disposed || busy) return;
      busy = true; feedback('Thinking (on-device omni)...');
      void agentBrain.sendVoice(pcm).then(() => feedback('')).catch(reportError).finally(() => { busy = false; if (!disposed) render(); });
    };
    const microphone = (test = false): void => {
      if (capture) { capture.stop(); feedback('Finishing recording...'); return; }
      if (microphoneStarting) return;
      microphoneStarting = true; render();
      void startListening((text) => {
        if (disposed) return;
        capture = null;
        feedback(text ? test ? `STT transcript: ${text}` : 'Transcript received.' : 'No speech detected.');
        if (!test) submit(text);
        render();
      }, (status) => {
        if (disposed) return;
        feedback(status);
        if (/stopped|error|failed|denied|unsupported|unavailable|cancel|complete|No speech|disabled/i.test(status)) capture = null;
        render();
      }, {
        // The omni tier transcribes and answers from the raw audio; the
        // recorder never runs Whisper for it.
        onOmniAudio: (pcm) => {
          if (disposed) return;
          capture = null;
          if (test) { feedback('Omni voice captured (test).'); render(); return; }
          submitVoice(pcm);
        },
      }).then((session) => {
        if (disposed) { session.cancel(); return; }
        capture = session.active ? session : null;
      }).catch(reportError).finally(() => { microphoneStarting = false; if (!disposed) render(); });
    };
    const updateEditorPreview = (): void => {
      const secret = editing === 'pin' || (typeof editing === 'object' && editing?.kind === 'secret');
      setText('workspace-editor-value', secret ? input.value ? editing === 'pin' ? 'PIN entered (hidden)' : 'Replacement key entered (hidden)' : editing === 'pin' ? 'Enter the 6-digit PIN from the sender.' : 'Blank retains stored key. Use Clear key to remove it.' : input.value.slice(-180) || 'Type with your keyboard. Enter = Done; Shift+Enter = newline.');
    };
    const closeEditor = (commit: boolean): void => {
      const target = editing;
      if (!target) return;
      if (commit && composing) return;
      const value = typeof target === 'object' && target.kind === 'secret' ? input.value.trim() : input.value;
      if (commit && target === 'chat' && busy) { feedback('Wait for the current reply before sending.', true); return; }
      if (commit && typeof target === 'object' && target.kind === 'number') {
        const number = Number(value);
        if (!value.trim() || !Number.isFinite(number) || number < 0.5 || number > 2) { feedback('Avatar scale must be between 0.5 and 2.', true); return; }
      }
      editing = null;
      input.value = ''; input.blur(); bridge.hidden = true;
      if (commit) {
        if (target === 'chat') submit(value);
        else if (target === 'note') { if (value.trim()) void agentState.addMemory(value, 'note').then(() => feedback('Note saved on this device.')).catch(reportError); }
        else if (target === 'search') { search = value.trim(); page = 0; refreshRecords(); }
        else if (target === 'pin') { receivingPin = value.replace(/\D/gu, '').slice(0, 6); feedback(receivingPin.length === 6 ? 'PIN ready. Press Apply settings.' : 'Enter all 6 PIN digits.', receivingPin.length !== 6); }
        else if (target === 'card') {
          try {
            const card = parseCharacterCard(value);
            changeDraft({
              ...(card.name ? { agentName: card.name } : {}),
              ...(card.prompt ? { characterPrompt: card.prompt } : {}),
            });
            feedback('Character card imported into the draft. Save to apply it.');
          } catch (error) {
            feedback(error instanceof Error ? error.message : 'This card could not be read.', true);
          }
        }
        else if (target.kind !== 'secret' || value !== '') changeDraft({ [target.key]: target.kind === 'number' ? Number(value) : value });
      }
      render();
    };
    const focusEditor = (): void => {
      if (!editing) return;
      const session = world.session as (XRSession & { isSystemKeyboardSupported?: boolean }) | null;
      if (session?.isSystemKeyboardSupported === false) {
        feedback('This immersive browser does not support the system keyboard. Use browser mode or encrypted QR transfer.', true);
        return;
      }
      input.focus();
    };
    const edit = (target: EditorTarget): void => {
      if (editing) closeEditor(true);
      if (editing) return;
      if (typeof target === 'object' && target.kind === 'toggle') { changeDraft({ [target.key]: !draft[target.key] }); render(); return; }
      if (typeof target === 'object' && target.kind === 'provider') {
        const values = ['off', 'browser', 'local', 'openai'];
        const next = values[(values.indexOf(String(draft[target.key])) + 1) % values.length];
        changeDraft({ [target.key]: next });
        if (target.key === 'ttsProvider' && next === 'browser') changeDraft({ ttsVoice: '' });
        render(); return;
      }
      editing = target;
      const secret = target === 'pin' || (typeof target === 'object' && target.kind === 'secret');
      input = secret ? secretInput : textInput;
      input.inputMode = target === 'pin' ? 'numeric' : 'text';
      secretInput.hidden = !secret; textInput.hidden = secret;
      input.value = typeof target === 'object' ? secret ? '' : String(draft[target.key]) : target === 'search' ? search : '';
      const label = typeof target === 'object' ? target.label : target === 'chat' ? 'Message' : target === 'note' ? 'New memory note' : target === 'pin' ? 'Receiver PIN (6 digits)' : target === 'card' ? 'Paste a character card (JSON)' : 'Search saved notes and facts';
      bridgeLabel.textContent = label;
      bridgeLabel.htmlFor = input.id;
      setText('workspace-editor-label', typeof target === 'object' ? `${label}${target.help ? ` / ${target.help}` : ''}` : label);
      bridge.hidden = false;
      updateEditorPreview(); render(); focusEditor(); input.select();
    };
    const refreshRecords = (): void => {
      const generation = ++recordGeneration;
      const result = search && tab === 'memory' ? agentState.searchMemories(search, Number.MAX_SAFE_INTEGER) : agentState.recentMemories(Number.MAX_SAFE_INTEGER);
      void result.then((next) => { if (disposed || generation !== recordGeneration) return; records = next; render(); }).catch(reportError);
    };
    const selectTab = (next: WorkspaceTab): void => {
      closeEditor(true);
      if (editing) return;
      tab = next; page = 0; confirmingClear = false; refreshRecords(); render();
    };
    const action = (id: string, callback: () => void): void => {
      const element = panel.requireElementById(id);
      element.name = id;
      const listener = (): void => {
        // A short tick confirms the press on the controller that made it.
        pulseHaptics(world, this.lastHand, HAPTIC_TICK);
        callback();
      };
      element.addEventListener('click', listener);
      disposers.push(() => element.removeEventListener('click', listener));
    };
    for (const key of Object.keys(TAB_LABELS) as WorkspaceTab[]) action(`nav-${key}`, () => selectTab(key));
    for (const key of Object.keys(SUB_LABELS) as ConnectionTab[]) action(`sub-${key}`, () => { closeEditor(true); if (editing) return; sub = key; render(); });
    for (let index = 0; index < 6; index++) action(`field-${index}`, () => { const field = currentFields()[index]; if (field) edit(field); });
    action('workspace-edit-chat', () => edit('chat'));
    action('workspace-look', () => submit('Look at this'));
    action('workspace-listen', () => microphone());
    // Horizon-style re-centre: put the panel back in front of the user.
    action('workspace-panel-home', () => {
      placePanelInFrontOfUser();
      feedback('Panel placed in front of you.');
    });
    action('workspace-save', () => { closeEditor(true); if (!editing) void save(); });
    action('workspace-test', () => {
      const provider = sub;
      if (provider === 'stt' && capture) { microphone(true); return; }
      void save().then((saved) => {
        if (!saved || disposed) return;
        if (provider === 'llm') {
          if (agentBrain.mode !== 'live') { feedback('No live LLM configured. Choose Full local or set an endpoint, model and key before testing.', true); return; }
          submit('Connection test: please reply with a short greeting.');
        } else if (provider === 'stt') microphone(true);
        else if (provider === 'tts') void speak('Hello. This is a test of your selected voice provider.').catch(reportError);
      });
    });
    action('workspace-clear-key', () => {
      closeEditor(false);
      const field = currentFields().find((item) => item.kind === 'secret');
      if (field) { changeDraft({ [field.key]: '' }); feedback('Key explicitly removed from draft. Save to apply.'); render(); }
    });
    action('workspace-preset', () => { changeDraft({ characterVrmUrl: '', characterScale: 1 }); feedback('Bundled character selected in draft. Save to apply.'); render(); });
    action('workspace-local-preset', () => {
      changeDraft(LOCAL_PRESET);
      feedback('Full-local draft: the on-device omni voice model in English (WebGPU) - speech, photos and memory tools, no key. Russian keeps the WebLLM + Whisper stack. Save starts the model download; progress shows in the status line above.');
      render();
    });
    action('workspace-free-preset', () => {
      changeDraft(FREE_PRESET);
      feedback('Free-API draft: OpenRouter Nemotron free, browser/OS voice and browser speech recognition (on-device pack when the browser has it). Only the LLM needs a key. Save to apply.');
      render();
    });
    action('workspace-paid-preset', () => {
      changeDraft(PAID_PRESET);
      feedback('Paid-API draft: Gemma 4 31B with cheapest healthy provider first, Fish free voice, browser STT. Keys are unchanged; add an OpenRouter key. Save to apply.');
      render();
    });
    for (const [chip, modelId] of Object.entries(LOCAL_MODEL_CHIPS)) {
      action(chip, () => {
        changeDraft({ modelId });
        const info = LOCAL_MODELS[modelId] ?? resolveLocalModel(modelId);
        const footprint = info.vramMB ? `${info.vramMB} MB VRAM / ${info.downloadMB} MB download` : 'custom model';
        feedback(modelId === LOCAL_MODEL_AUTO
          ? `Draft model: Auto - runs ${info.label} on this device (${footprint}). Save to apply.`
          : `Draft model: ${info.label} (${footprint}, ${info.note}). Save to apply.`);
        render();
      });
    }
    action('workspace-copy-key', () => {
      if (!draft.modelApiKey) { feedback('Set an LLM key first. The TTS key was not changed.', true); return; }
      changeDraft({ ttsApiKey: draft.modelApiKey });
      feedback('LLM key explicitly copied to TTS draft. Save to apply.'); render();
    });
    action('workspace-browser-voice', () => {
      void listVoices().then((voices) => {
        if (disposed) return;
        if (!voices.length) { feedback('This runtime exposes no browser voices. Try again after voices load, or choose another speech provider.', true); render(); return; }
        const ordered = voiceCycle(voices, draft.speechLanguage, draft.ttsVoice);
        const voice = ordered[0];
        if (!voice) return;
        changeDraft({ ttsVoice: voice.uri });
        feedback(`Voice: ${describeVoice(voice)}. Female voices come first. Save to apply.`);
        render();
      });
    });
    action('workspace-export-card', () => {
      const card = buildCharacterCard({
        name: draft.agentName,
        prompt: draft.characterPrompt,
        scenario: '',
        model: draft.characterVrmUrl || BUNDLED_CHARACTER_PRESET.modelName,
      });
      const json = serializeCharacterCard(card);
      const slug = (draft.agentName || 'ava')
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]+/gu, '-')
        .replace(/^-+|-+$/gu, '') || 'ava';
      const fileName = `${slug}.chara_card_v3.json`;
      try {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
        feedback(`Character card exported: ${fileName} (chara_card_v3).`);
      } catch (error) {
        reportError(error);
      }
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(json)
          .then(() => feedback(`Character card exported and copied to the clipboard (${fileName}).`))
          .catch(() => { /* the download already happened */ });
      }
    });
    action('workspace-import-card', () => edit('card'));
    action('workspace-memory-add', () => edit('note'));
    action('workspace-memory-search', () => edit('search'));
    action('workspace-memory-reset', () => { search = ''; page = 0; refreshRecords(); });
    action('workspace-memory-clear', () => {
      if (!confirmingClear) { confirmingClear = true; feedback('This permanently clears ALL dialogue, facts and notes. Press Confirm clear again, or change tab to cancel.', true); render(); return; }
      confirmingClear = false; search = ''; page = 0;
      // The panel is not the only place that remembers: drop model history and stop speech too.
      agentBrain.resetConversation();
      hush();
      void agentState.clearMemories().then(() => feedback('All dialogue, facts and notes cleared on this device, and the model dialogue reset.')).catch(reportError); render();
    });
    action('workspace-previous', () => { page = Math.max(0, page - 1); render(); });
    action('workspace-next', () => { page = Math.min(Math.max(0, visibleRecords().length - 1), page + 1); render(); });
    action('workspace-editor-focus', focusEditor);
    action('workspace-editor-done', () => closeEditor(true));
    action('workspace-editor-cancel', () => closeEditor(false));
    action('workspace-transfer', () => {
      if (pairingBusy) return;
      if (Object.keys(pending).length) { feedback('Save your draft before generating a settings transfer.', true); return; }
      const generation = ++pairingGeneration;
      pairingBusy = true; feedback('Encrypting settings...');
      void createPairingOffer(agentState.getSettings()).then((offer) => {
        if (disposed || generation !== pairingGeneration) return;
        pairing = offer;
        const qr = qrcode(0, 'M'); qr.addData(offer.url); qr.make();
        panel.requireElementById('pairing-qr').setProperties({ src: qr.createDataURL(5, 20) });
        clearTimeout(pairingTimer);
        pairingTimer = window.setTimeout(() => {
          pairing = null;
          setText('pairing-pin', '');
          panel.requireElementById('pairing-qr').setProperties({ src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==' });
          feedback('QR display expired. Generate another offer.'); render();
        }, Math.max(0, offer.expiresAt - Date.now()));
        feedback('Scan the encrypted QR and enter the PIN on the receiving browser.'); render();
      }).catch(reportError).finally(() => { pairingBusy = false; });
    });
    action('workspace-copy-link', () => {
      if (!pairing || pairing.expiresAt <= Date.now()) { feedback('Generate a valid QR offer first.', true); return; }
      if (!navigator.clipboard?.writeText) { feedback('Clipboard unavailable in this browser. Scan the QR instead.', true); return; }
      void navigator.clipboard.writeText(pairing.url).then(() => feedback('Encrypted pairing link copied. Enter its PIN on the receiving browser.')).catch(() => feedback('Clipboard denied. Scan the QR instead.', true));
    });
    const discardReceiver = (): void => {
      receivingUrl = ''; receivingPin = '';
      if (parsePairingFragment(location.hash)) history.replaceState(null, '', location.pathname + location.search);
      render();
    };
    // Opening a pairing link in a tab where this app is already running is a
    // same-document hash navigation: no reload happens, so the fragment must be
    // picked up here or the panel would keep the previous link.
    const receivePairingUrl = (): void => {
      if (!parsePairingFragment(window.location.hash)) return;
      receivingUrl = window.location.href;
      receivingPin = ''; receivingBusy = false;
      editing = null; input.value = ''; input.blur(); bridge.hidden = true;
      tab = 'connections'; sub = 'transfer'; page = 0; confirmingClear = false;
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      feedback('Pairing link received. Enter the 6-digit PIN, then Apply settings.');
      render();
    };
    window.addEventListener('hashchange', receivePairingUrl);
    disposers.push(() => window.removeEventListener('hashchange', receivePairingUrl));
    action('workspace-receiver-pin', () => edit('pin'));
    action('workspace-receiver-apply', () => {
      if (receivingBusy) return;
      if (!receivingUrl || receivingPin.length !== 6) { feedback('Enter all 6 PIN digits first.', true); return; }
      receivingBusy = true; feedback('Decrypting settings...');
      void consumePairingUrl(receivingUrl, receivingPin).then((patch) => {
        if (disposed) return;
        return agentState.updateSettings(patch);
      }).then(() => {
        if (disposed) return;
        draft = { ...agentState.getSettings(), ...pending };
        discardReceiver();
        feedback('Settings applied to this browser. Any existing unsaved draft is retained.');
      }).catch(reportError).finally(() => { receivingBusy = false; });
    });
    action('workspace-receiver-skip', () => { closeEditor(false); discardReceiver(); feedback('Pairing link discarded. Current settings unchanged.'); });
    action('workspace-enter-mr', () => { world.launchXR({ sessionMode: SessionMode.ImmersiveAR }); });
    action('workspace-enter-vr', () => { world.launchXR({ sessionMode: SessionMode.ImmersiveVR, features: { anchors: false, hitTest: false, planeDetection: false, meshDetection: false } }); });
    action('workspace-exit', () => world.exitXR());

    const keyboardDown = (event: Event): void => {
      if (!(event instanceof KeyboardEvent)) return;
      event.stopPropagation();
      if (event.isComposing || composing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); closeEditor(true); }
      else if (event.key === 'Escape') { event.preventDefault(); closeEditor(false); }
    };
    const stopKeys = (event: Event): void => event.stopPropagation();
    const startComposition = (): void => { composing = true; };
    let canvasPointerActive = false;
    const canvasPointerDown = (): void => { canvasPointerActive = true; };
    const canvasPointerUp = (): void => { canvasPointerActive = false; };
    const finishComposition = (): void => {
      composing = false; updateEditorPreview();
      if (world.session && document.activeElement !== input && !canvasPointerActive) closeEditor(true);
    };
    // A canvas click must reach Done/Cancel before committing a blurred editor.
    // Native system-keyboard Done blurs without a canvas pointer and commits.
    const blurEditor = (): void => { if (world.session && !composing && !canvasPointerActive) closeEditor(true); };
    const canvas = world.renderer.domElement;
    canvas.addEventListener('pointerdown', canvasPointerDown, true);
    window.addEventListener('pointerup', canvasPointerUp, true);
    window.addEventListener('pointercancel', canvasPointerUp, true);
    disposers.push(() => {
      canvas.removeEventListener('pointerdown', canvasPointerDown, true);
      window.removeEventListener('pointerup', canvasPointerUp, true);
      window.removeEventListener('pointercancel', canvasPointerUp, true);
    });
    for (const editor of [textInput, secretInput]) {
      editor.addEventListener('keydown', keyboardDown); editor.addEventListener('keyup', stopKeys);
      editor.addEventListener('input', updateEditorPreview); editor.addEventListener('compositionstart', startComposition);
      editor.addEventListener('compositionend', finishComposition); editor.addEventListener('blur', blurEditor);
      disposers.push(() => {
        editor.removeEventListener('keydown', keyboardDown); editor.removeEventListener('keyup', stopKeys);
        editor.removeEventListener('input', updateEditorPreview); editor.removeEventListener('compositionstart', startComposition);
        editor.removeEventListener('compositionend', finishComposition); editor.removeEventListener('blur', blurEditor);
      });
    }
    const resize = (): void => {
      const width = Math.min(480, window.innerWidth - 24);
      const height = Math.min(720, window.innerHeight - 24);
      panelEntity.setValue(ScreenSpace, 'width', `${width}px`);
      panelEntity.setValue(ScreenSpace, 'height', `${height}px`);
    };
    /**
     * In an immersive session the panel is a world object, so it is placed in
     * front of the player and turned towards them. It stays grabbable, so the
     * user can move it wherever they want it.
     */
    /**
     * In an immersive session the panel is a world object, so it is placed
     * beside the user and turned towards them. It stays off the centre of the
     * view - the companion and the teleport arc need that space - and it
     * remains grabbable, so the user can move it wherever they want it.
     */
    const placePanelInFrontOfUser = (): void => {
      const head = world.player?.head;
      const object = panelEntity.object3D;
      if (!head || !object) return;
      const headPosition = new Vector3();
      const headRotation = new Quaternion();
      head.getWorldPosition(headPosition);
      head.getWorldQuaternion(headRotation);
      // The head looks down its own -Z axis, its +X axis points right and its
      // +Y is up. All offsets are applied in this camera space: a headset
      // keeps its floor-anchored "up", but a handheld phone reports an
      // AR session in a camera-anchored "local" space where the world Y axis
      // has no relation to the floor, so a world-Y drop parked the panel
      // below the user's view - effectively at the floor.
      const look = new Vector3(0, 0, -1).applyQuaternion(headRotation);
      const right = new Vector3(1, 0, 0).applyQuaternion(headRotation);
      const up = new Vector3(0, 1, 0).applyQuaternion(headRotation);
      // A phone is held at arm's length, so there the panel sits closer and
      // smaller; a headset keeps the roomy, off-centre placement.
      const handheld = !supportsVR;
      const distance = handheld ? 0.55 : 1.15;
      const side = handheld ? 0 : -0.42;
      const drop = handheld ? 0.1 : 0.18;
      const scale = handheld ? 0.3 : PANEL_XR_SCALE;
      object.position.copy(headPosition)
        .add(look.multiplyScalar(distance))
        .add(right.multiplyScalar(side))
        .add(up.multiplyScalar(-drop));
      object.lookAt(headPosition);
      object.scale.setScalar(scale);
      object.updateMatrixWorld(true);
    };
    panelEntity.addComponent(ScreenSpace, { width: '480px', height: '720px', top: '12px', right: '12px', zOffset: 0.4 });
    resize();
    window.addEventListener('resize', resize);
    const updateMode = (state: VisibilityState): void => {
      const immersive = state !== VisibilityState.NonImmersive;
      document.body.classList.toggle('workspace-immersive', immersive);
      // The local model tier is chosen by what the device can afford.
      setLocalImmersiveSession(immersive);
      panelEntity.setValue(Visibility, 'isVisible', true);
      const showRoom = !immersive || world.session?.environmentBlendMode === 'opaque';
      for (const id of VIRTUAL_ROOM_NODE_IDS) {
        const object = world.getSceneObject(id);
        if (object) object.visible = showRoom;
      }
      // The grab bar belongs to the world space panel, not to the desktop
      // overlay.
      world.getSystem(PanelGrabSystem)?.setVisible(immersive);
      if (immersive) {
        // The head only has its real transform once the XR reference space is
        // applied, and phones can take a few frames longer than headsets to
        // publish a settled camera pose, so the panel is placed on the first
        // frames of the session and then left alone for the user to grab.
        let frames = 0;
        let unsubscribe: (() => void) | undefined;
        unsubscribe = world.onXRFrame(() => {
          placePanelInFrontOfUser();
          frames += 1;
          if (frames >= PANEL_PLACEMENT_FRAMES) unsubscribe?.();
        });
      } else {
        const object = panelEntity.object3D;
        if (object) {
          // Scale, position and orientation all go back to the authored
          // desktop values: leaving it where a session drag left it would
          // strand the panel at an unexplained height after exiting XR.
          object.scale.copy(authoredPanelScale);
          object.position.copy(authoredPanelPosition);
          object.quaternion.copy(authoredPanelQuaternion);
          object.updateMatrixWorld(true);
        }
      }
      // In the browser emulator the arrow keys drive the emulated thumbstick,
      // so the keyboard locomotion would fight the XR locomotion (the stick
      // down aims a teleport while the same key slides the player off the
      // floor). Inside a session only the headset and controllers count.
      const keyboardBindings = world.input.actions.getBindings()
        .filter((binding) => binding.source === 'keyboard');
      for (const binding of keyboardBindings) {
        if (immersive) world.input.actions.removeBinding(binding);
        else world.input.actions.addBinding(binding);
      }
      render();
    };
    if (navigator.xr && world.xrEnabled) {
      void Promise.all([navigator.xr.isSessionSupported('immersive-ar'), navigator.xr.isSessionSupported('immersive-vr')]).then(([mr, vr]) => {
        if (disposed) return; supportsMR = mr; supportsVR = vr; render();
        if (!mr && !vr) feedback('This browser has no immersive MR/VR support. Desktop controls remain available.');
      }).catch(() => feedback('Immersive capability check unavailable. Desktop controls remain available.'));
    }
    disposers.push(agentState.onSettingsChanged((settings) => { draft = { ...settings, ...pending }; render(); }));
    disposers.push(agentState.onMemoriesChanged(refreshRecords));
    disposers.push(world.visibilityState.subscribe(updateMode));
    disposers.push(onSpeechStatus((status) => feedback(status)));
    disposers.push(onCharacterStatus(() => render()));
    disposers.push(onAvatarCue((next) => { cue = next; render(); }));
    disposers.push(onPerceptionStatus((status) => { cameraStatus = status; render(); }));
    void agentState.ready.then(() => { if (disposed) return; draft = { ...agentState.getSettings(), ...pending }; refreshRecords(); render(); });
    // Show the panel before anything cosmetic runs. updateMode is what clears
    // the authored `Visibility: false`, so nothing may throw ahead of it.
    render(); updateMode(world.visibilityState.value);
    if (getSpeechStatus()) feedback(getSpeechStatus());
    // The capability probe only decorates the panel; run it last so a browser
    // without WebXR cannot keep the interface hidden.
    if (!navigator.xr || !world.xrEnabled) {
      feedback('Immersive MR/VR is unavailable in this browser. Desktop controls remain available.');
    }
    this.cleanupFuncs.push(() => {
      disposed = true; editing = null; input.blur();
      cancelListening(); capture?.cancel();
      clearTimeout(pairingTimer); pairingGeneration++; recordGeneration++;
      window.removeEventListener('resize', resize);
      for (const dispose of disposers) dispose();
      document.body.classList.remove('workspace-immersive');
      bridge.remove();
    });
  }

  /**
   * UIKit draws the panel in the transparent pass without depth writes, and
   * the renderer sorts transparent objects near-to-far for UI readability, so
   * the room floor grid painted over the panel and it looked translucent.
   * Drawing the panel after the scene's transparent objects fixes that. Its
   * own layering is unchanged because every panel mesh shares the order.
   */
  update(): void {
    const panel = this.world.getSceneObject('agent-panel') as UIKitMLAsset | undefined;
    panel?.document?.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.renderOrder !== PANEL_RENDER_ORDER) mesh.renderOrder = PANEL_RENDER_ORDER;
    });
    // Remember which hand is driving the pointer, so a button press ticks on
    // the controller that pressed it.
    const gamepads = this.world.input.xr?.gamepads;
    for (const hand of ['left', 'right'] as const) {
      const pad = gamepads?.[hand];
      if (pad?.getButtonPressedByIdx(0)) this.lastHand = hand;
    }
  }
}
