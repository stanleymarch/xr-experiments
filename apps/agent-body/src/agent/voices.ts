/**
 * Browser/OS speech voices.
 *
 * The panel speaks through SpeechSynthesis, which exposes the voices installed
 * in the operating system (localService === true) and, on some systems, a few
 * network voices. The default OS voice is often male, so the picker prefers a
 * female-sounding voice for the current language and reports what it chose.
 */

export interface VoiceInfo {
  name: string;
  lang: string;
  uri: string;
  local: boolean;
  default: boolean;
  female: boolean;
}

interface VoiceLike {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
  default: boolean;
}

/** Voice names that are female in the common OS/Chrome voice sets. */
const FEMALE_MARKERS = [
  'aria', 'zira', 'jenny', 'sonia', 'milena', 'katya', 'katerina', 'katarina', 'elena', 'irina',
  'yulia', 'julia', 'svetlana', 'marina', 'natalia', 'natalie', 'anastasia', 'tanya', 'tatiana',
  'olga', 'polina', 'ksenia', 'daria', 'alina', 'alice', 'samantha', 'victoria', 'tessa', 'fiona',
  'moira', 'allison', 'susan', 'vicki', 'karen', 'mozelle', 'heather', 'salli', 'kimberly', 'emily',
  'emma', 'olivia', 'jennifer', 'nancy', 'female', 'woman', 'женск', 'алиса', 'елена', 'ирина',
  'юлия', 'светлана', 'марина', 'наташа', 'анастасия', 'татьяна', 'ольга', 'полина', 'ксения',
  'даша', 'алина', 'милена', 'катя', 'зера',
];

/** Voice names that are male; they are only used when nothing else matches. */
const MALE_MARKERS = [
  'david', 'mark', 'george', 'james', 'richard', 'guy', 'daniel', 'rishi', 'fred', 'thomas',
  'mikhail', 'yuri', 'dmitry', 'dmitrii', 'pavel', 'aleksey', 'alexey', 'vladimir', 'sergey',
  'gonzalo', 'diego', 'miguel', 'juan', 'pedro', 'aleksandr', 'male', 'man', 'boy', 'мужск',
  'давид', 'марк', 'дмитрий', 'павел', 'алексей', 'юрий',
];

export function isFemaleVoiceName(name: string): boolean {
  const lower = name.toLowerCase();
  return FEMALE_MARKERS.some((marker) => lower.includes(marker));
}

/** Voice names that are known to be male; used for the label only. */
export function isMaleVoiceName(name: string): boolean {
  const lower = name.toLowerCase();
  return MALE_MARKERS.some((marker) => lower.includes(marker));
}

function toInfo(voice: VoiceLike): VoiceInfo {
  return {
    name: voice.name,
    lang: voice.lang,
    uri: voice.voiceURI,
    local: voice.localService,
    default: voice.default,
    female: isFemaleVoiceName(voice.name),
  };
}

/** All voices the runtime exposes, waiting for the first voiceschanged event. */
export async function listVoices(timeoutMs = 2000): Promise<VoiceInfo[]> {
  const synthesis = typeof window === 'undefined' ? undefined : window.speechSynthesis;
  if (!synthesis) return [];
  let voices = synthesis.getVoices();
  if (!voices.length) {
    await new Promise<void>((resolve) => {
      const complete = () => { clearTimeout(timer); synthesis.removeEventListener('voiceschanged', complete); resolve(); };
      const timer = setTimeout(complete, timeoutMs);
      synthesis.addEventListener('voiceschanged', complete);
    });
    voices = synthesis.getVoices();
  }
  return voices.map(toInfo);
}

function languageScore(voice: VoiceInfo, language: string): number {
  const wanted = language.toLowerCase();
  const current = voice.lang.toLowerCase();
  if (current === wanted) return 3;
  if (current.split('-')[0] === wanted.split('-')[0]) return 2;
  return 0;
}

/**
 * Pick a voice: an explicit choice wins, then a female OS voice for the
 * requested language, then any female voice, and only then the OS default.
 */
export function pickVoice(voices: VoiceInfo[], language: string, preferredUri = ''): VoiceInfo | null {
  if (!voices.length) return null;
  const chosen = preferredUri ? voices.find((voice) => voice.uri === preferredUri) : undefined;
  if (chosen) return chosen;
  const scored = voices
    .map((voice) => ({
      voice,
      score: languageScore(voice, language) * 4 + (voice.female ? 2 : 0) + (voice.local ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.voice ?? null;
}

/** Female voices for the language first, then every other voice. */
export function voiceCycle(voices: VoiceInfo[], language: string, currentUri = ''): VoiceInfo[] {
  const matching = voices.filter((voice) => languageScore(voice, language) > 0);
  const female = matching.filter((voice) => voice.female);
  const others = matching.filter((voice) => !voice.female);
  const fallbackFemale = voices.filter((voice) => voice.female && languageScore(voice, language) === 0);
  const rest = voices.filter((voice) => !voice.female && languageScore(voice, language) === 0);
  const ordered = [...female, ...others, ...fallbackFemale, ...rest];
  const index = ordered.findIndex((voice) => voice.uri === currentUri);
  if (index < 0) return ordered;
  return [...ordered.slice(index + 1), ...ordered.slice(0, index + 1)];
}

export function describeVoice(voice: VoiceInfo | null): string {
  if (!voice) return 'no voice available';
  const kind = voice.local ? 'OS voice' : 'network voice';
  const gender = voice.female ? 'female' : isMaleVoiceName(voice.name) ? 'male' : 'unknown gender';
  return `${voice.name} (${voice.lang}, ${kind}, ${gender})`;
}
