/**
 * SillyTavern character card v3.
 *
 * The card is the portable form of the character: name, personality,
 * scenario, greeting and the system prompt. It is plain JSON, so it can be
 * imported into SillyTavern, TavernAI-style front ends or back into this app.
 */

export interface CharacterCardEntry {
  keys: string[];
  content: string;
  enabled: boolean;
  insertion_order: number;
  case_sensitive: boolean;
  name: string;
  priority: number;
  id: number;
  comment: string;
  selective: boolean;
  secondary_keys: string[];
  constant: boolean;
  position: 'before_char' | 'after_char';
  extensions: Record<string, unknown>;
}

export interface CharacterBook {
  name: string;
  description: string;
  scan_depth: number;
  token_budget: number;
  recursive_scanning: boolean;
  extensions: Record<string, unknown>;
  entries: CharacterCardEntry[];
}

export interface CharacterCardData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  character_book: CharacterBook | null;
  tags: string[];
  creator: string;
  character_version: string;
  extensions: Record<string, unknown>;
}

export interface CharacterCardV3 {
  spec: 'chara_card_v3';
  spec_version: '3.0';
  data: CharacterCardData;
}

export interface CharacterCardSource {
  name: string;
  prompt: string;
  scenario: string;
  model: string;
}

/** Build a v3 card from the app's character settings. */
export function buildCharacterCard(source: CharacterCardSource): CharacterCardV3 {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: source.name || 'Ava',
      description: [
        `${source.name || 'Ava'} is an embodied companion: a VRM avatar that lives in a mixed-reality room and a virtual room, and speaks through a shared dialogue panel.`,
        'The avatar is present but honest: it never claims to see what it cannot see, and it answers in the language of the person it talks to.',
      ].join('\n\n'),
      personality: 'Curious, calm, concise. Answers briefly and distinguishes observation from inference.',
      scenario: 'A one-on-one conversation in a shared space. The companion has a local memory of notes and facts, and can be asked to look at something through the camera when that is explicitly requested.',
      first_mes: 'Привет! Я на связи. Чем займёмся?',
      mes_example: '<START>\n{{user}}: Расскажи, что ты видишь.\n{{char}}: В комнате пусто — я не вижу ничего, кроме геометрии, и не буду додумывать. Скажи, на что посмотреть, и я попробую.',
      creator_notes: 'Exported from agent-body. The card carries the character prompt and the greeting; the 3D model, voice and providers stay in the app.',
      system_prompt: source.prompt,
      post_history_instructions: 'Reply in the user\'s language. Use 1-3 short sentences of plain prose. Do not use markdown or animation tags.',
      alternate_greetings: ['Hello! Good to see you. What shall we do?', 'Привет! Готов продолжать. Что делаем?'],
      character_book: {
        name: `${source.name || 'Ava'} facts`,
        description: 'Local knowledge of the shared space.',
        scan_depth: 4,
        token_budget: 512,
        recursive_scanning: false,
        extensions: {},
        entries: [
          {
            keys: ['комната', 'room', 'space', 'пространство'],
            content: 'The companion lives in a mixed-reality room and a virtual room. Room geometry is measured metadata, never an image.',
            enabled: true,
            insertion_order: 10,
            case_sensitive: false,
            name: 'Shared space',
            priority: 10,
            id: 1,
            comment: '',
            selective: true,
            secondary_keys: ['комната', 'room'],
            constant: false,
            position: 'before_char',
            extensions: {},
          },
        ],
      },
      tags: ['agent-body', 'vrm', 'embodied', 'russian', 'english'],
      creator: 'agent-body',
      character_version: '1.0',
      extensions: {
        agent_body: {
          model: source.model,
          card_spec: 'chara_card_v3',
        },
      },
    },
  };
}

export function serializeCharacterCard(card: CharacterCardV3): string {
  return JSON.stringify(card, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read a card into the fields this app can use. Both v3 (`data`) and the
 * older flat v2 layout are accepted, so cards exported from elsewhere still
 * import.
 */
export function parseCharacterCard(raw: string): CharacterCardSource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('This is not valid JSON.');
  }
  if (!isRecord(parsed)) throw new Error('A character card must be a JSON object.');
  const data = isRecord(parsed.data) ? parsed.data : parsed;
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const description = typeof data.description === 'string' ? data.description : '';
  const personality = typeof data.personality === 'string' ? data.personality : '';
  const scenario = typeof data.scenario === 'string' ? data.scenario : '';
  const systemPrompt = typeof data.system_prompt === 'string' ? data.system_prompt : '';
  const extensions = isRecord(data.extensions) ? data.extensions : {};
  const agentBody = isRecord(extensions.agent_body) ? extensions.agent_body : {};
  const model = typeof agentBody.model === 'string' ? agentBody.model : '';
  const prompt = [description, personality].filter(Boolean).join('\n\n') || systemPrompt;
  if (!name && !prompt) throw new Error('The card has no name and no description.');
  return { name, prompt, scenario, model };
}
