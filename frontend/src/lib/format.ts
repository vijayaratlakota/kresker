/** Small shared formatters. Duplicated formatting is how two screens end up
 *  disagreeing about the same number. */

/**
 * Every language the product dubs into.
 *
 * ONE LIST, AND IT IS THIS ONE. The picker, the marquee on the homepage, the dot
 * colours, the Library search and the job rows all derive from here, so a language
 * added here appears everywhere without further edits.
 *
 * IT MUST MATCH THE BACKEND. `backend/app/media.py` holds two maps keyed by these
 * same codes: `ISO1_TO_ISO2`, which supplies the ISO-639-2 tag written into the MP4
 * audio track, and `LANG_NAMES`, which supplies the word in the download filename.
 * A code here with no entry there does not fail — it ships a track tagged with a
 * non-standard string that players show as "Undetermined", and a file called
 * `dubbed_xx_…` instead of `dubbed_odia_…`. Silent and permanent, which is why
 * `backend/_test_langs.py` compares the two and fails if they drift.
 *
 * WHY THE ENGINE NEEDS NO CHANGE FOR ANY OF THESE. The tuned VoiceStudio pipeline is
 * not language-switched. `preset.py` sends the code as `language_code`, and the engine
 * uses it only as a per-track cache key and as the ffmpeg metadata tag — the voice
 * model itself is called with `language=None` and is conditioned on the reference
 * audio cut from the speaker plus the already-translated text. So the set of languages
 * we can offer is bounded by translation and by our own metadata tables, not by the
 * box. Nothing in `pipeline/`, `_box_src/` or the preset changes to add one.
 *
 * `group` exists only to section the picker. Indian languages first because that is
 * the market this is built for, not because they behave differently.
 */
export const LANGUAGES = [
  // ── Indian languages ──────────────────────────────────────────────────────
  { code: 'te', label: 'Telugu', native: 'తెలుగు', group: 'india' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी', group: 'india' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்', group: 'india' },
  { code: 'kn', label: 'Kannada', native: 'ಕನ್ನಡ', group: 'india' },
  { code: 'ml', label: 'Malayalam', native: 'മലയാളം', group: 'india' },
  { code: 'bn', label: 'Bengali', native: 'বাংলা', group: 'india' },
  { code: 'mr', label: 'Marathi', native: 'मराठी', group: 'india' },
  { code: 'gu', label: 'Gujarati', native: 'ગુજરાતી', group: 'india' },
  { code: 'pa', label: 'Punjabi', native: 'ਪੰਜਾਬੀ', group: 'india' },
  { code: 'ur', label: 'Urdu', native: 'اردو', group: 'india' },
  { code: 'or', label: 'Odia', native: 'ଓଡ଼ିଆ', group: 'india' },
  { code: 'as', label: 'Assamese', native: 'অসমীয়া', group: 'india' },
  { code: 'ne', label: 'Nepali', native: 'नेपाली', group: 'india' },
  { code: 'si', label: 'Sinhala', native: 'සිංහල', group: 'india' },

  // ── everywhere else ───────────────────────────────────────────────────────
  { code: 'en', label: 'English', native: 'English', group: 'world' },
  { code: 'es', label: 'Spanish', native: 'Español', group: 'world' },
  { code: 'fr', label: 'French', native: 'Français', group: 'world' },
  { code: 'de', label: 'German', native: 'Deutsch', group: 'world' },
  { code: 'it', label: 'Italian', native: 'Italiano', group: 'world' },
  { code: 'pt', label: 'Portuguese', native: 'Português', group: 'world' },
  { code: 'nl', label: 'Dutch', native: 'Nederlands', group: 'world' },
  { code: 'sv', label: 'Swedish', native: 'Svenska', group: 'world' },
  { code: 'da', label: 'Danish', native: 'Dansk', group: 'world' },
  { code: 'no', label: 'Norwegian', native: 'Norsk', group: 'world' },
  { code: 'fi', label: 'Finnish', native: 'Suomi', group: 'world' },
  { code: 'pl', label: 'Polish', native: 'Polski', group: 'world' },
  { code: 'cs', label: 'Czech', native: 'Čeština', group: 'world' },
  { code: 'hu', label: 'Hungarian', native: 'Magyar', group: 'world' },
  { code: 'ro', label: 'Romanian', native: 'Română', group: 'world' },
  { code: 'el', label: 'Greek', native: 'Ελληνικά', group: 'world' },
  { code: 'ru', label: 'Russian', native: 'Русский', group: 'world' },
  { code: 'uk', label: 'Ukrainian', native: 'Українська', group: 'world' },
  { code: 'tr', label: 'Turkish', native: 'Türkçe', group: 'world' },
  { code: 'ar', label: 'Arabic', native: 'العربية', group: 'world' },
  { code: 'fa', label: 'Persian', native: 'فارسی', group: 'world' },
  { code: 'he', label: 'Hebrew', native: 'עברית', group: 'world' },
  { code: 'zh', label: 'Chinese', native: '中文', group: 'world' },
  { code: 'ja', label: 'Japanese', native: '日本語', group: 'world' },
  { code: 'ko', label: 'Korean', native: '한국어', group: 'world' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt', group: 'world' },
  { code: 'th', label: 'Thai', native: 'ไทย', group: 'world' },
  { code: 'id', label: 'Indonesian', native: 'Bahasa Indonesia', group: 'world' },
  { code: 'ms', label: 'Malay', native: 'Bahasa Melayu', group: 'world' },
] as const;

export type Language = (typeof LANGUAGES)[number];

/**
 * How many languages one press may queue.
 *
 * DELIBERATELY FAR BELOW THE CATALOGUE. Offering forty-three languages and letting
 * somebody pick all forty-three in one click are different things, and only the first
 * one is a feature.
 *
 * The reason is the box. There is ONE GPU and the dubs run one after another, so a
 * batch is not parallel work — it is a queue whose wall-clock length is the number of
 * languages times the length of the video. Forty-three dubs of a 90-second clip is
 * hours of GPU time nobody is watching, and the instance bills for every one of them.
 * It is also a forty-three-times charge from a single click, taken up front, on a
 * batch that is atomic and therefore cannot be trimmed once it starts.
 *
 * WHY EIGHT AND NOT FIVE. Eight is the first eight entries of the catalogue — Telugu,
 * Hindi, Tamil, Kannada, Malayalam, Bengali, Marathi, Gujarati — which is the release
 * set for this market. A cap of five would split that into two batches, two waits and
 * two ledger entries for one intent, and would not save the GPU anything: the same
 * eight dubs still run, just across two requests.
 *
 * THIS NUMBER IS ENFORCED ON THE SERVER, NOT HERE. `MAX_LANGS_PER_REQUEST` in
 * `backend/app/routers/jobs.py` is the limit; this copy exists only so the picker can
 * stop you at the ceiling instead of letting you build a request that comes back 400.
 * A client-side cap alone would be decoration - anyone can post the array themselves.
 * `backend/_test_langs.py` fails if the two numbers disagree.
 */
export const MAX_LANGS_PER_BATCH = 8;

export const LANGUAGE_GROUPS = [
  { id: 'india', label: 'Indian languages' },
  { id: 'world', label: 'More languages' },
] as const;

export const languageLabel = (code: string) =>
  LANGUAGES.find((l) => l.code === code)?.label ?? code.toUpperCase();

/**
 * Does this language match what somebody typed?
 *
 * Matches the code, the English name AND the native name, so "te", "telugu" and
 * "తెలుగు" all find Telugu. Accent- and case-insensitive on the Latin side, because
 * "espanol" should find Español — somebody searching in a hurry will not reach for
 * the ñ key.
 */
const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function languageMatches(l: Language, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  return (
    l.code.startsWith(q) ||
    fold(l.label).includes(q) ||
    l.native.toLowerCase().includes(query.trim().toLowerCase())
  );
}

export function bytes(n: number | null | undefined): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m === 0) return `${rem}s`;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export function minutes(n: number | null | undefined): string {
  if (n == null) return '—';
  return n < 1 ? `${(n * 60).toFixed(0)}s` : `${n.toFixed(2)} min`;
}

/** The backend writes one format everywhere: UTC, ISO-8601, second precision. */
function parseUtc(iso: string): Date {
  return new Date(iso.endsWith('Z') ? iso : `${iso}Z`);
}

export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = parseUtc(iso);
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function onDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  return parseUtc(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const secs = (Date.now() - parseUtc(iso).getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/**
 * Time left until a deletion deadline.
 *
 * Stated as a countdown AND an absolute date at the call site, because the plan's
 * point about retention is that a duration reads as a suggestion where a date
 * reads as a fact.
 */
export function until(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = parseUtc(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days >= 1) return `${days}d ${hours % 24}h`;
  const mins = Math.floor(ms / 60_000) % 60;
  return `${hours}h ${mins}m`;
}

export const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** Stage labels. The backend's state names are accurate but not customer-facing:
 *  "exporting" means nothing to somebody waiting for a video. */
export const STAGE_LABEL: Record<string, string> = {
  queued: 'Waiting to start',
  claimed: 'Starting',
  preparing: 'Separating speech from background',
  transcribing: 'Listening and cloning the voice',
  translating: 'Translating',
  rendering: 'Speaking in the new language',
  exporting: 'Finishing the video',
  done: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const STAGE_ORDER = [
  'preparing',
  'transcribing',
  'translating',
  'rendering',
  'exporting',
] as const;

/**
 * A colour per state, defined ONCE.
 *
 * A hue means a stage, not a shape: whatever draws `rendering` — a bar, a dot, a
 * row border — draws it pink. That is the whole value of it. If each screen picked
 * its own colours, colour would stop carrying information and become decoration.
 *
 * Classes rather than raw hex, because Tailwind needs the literal string present
 * to emit the utility. Text and fill are kept separate so a caller takes only what
 * it needs.
 */
export const STAGE_COLOR: Record<string, { text: string; bg: string; ring: string }> = {
  queued: { text: 'text-fg-subtle', bg: 'bg-fg-subtle', ring: 'ring-fg-subtle/30' },
  claimed: { text: 'text-sky', bg: 'bg-sky', ring: 'ring-sky/30' },
  preparing: { text: 'text-stage-prepare', bg: 'bg-stage-prepare', ring: 'ring-stage-prepare/30' },
  transcribing: { text: 'text-stage-listen', bg: 'bg-stage-listen', ring: 'ring-stage-listen/30' },
  translating: { text: 'text-stage-translate', bg: 'bg-stage-translate', ring: 'ring-stage-translate/30' },
  rendering: { text: 'text-stage-speak', bg: 'bg-stage-speak', ring: 'ring-stage-speak/30' },
  exporting: { text: 'text-stage-deliver', bg: 'bg-stage-deliver', ring: 'ring-stage-deliver/30' },
  done: { text: 'text-good', bg: 'bg-good', ring: 'ring-good/30' },
  failed: { text: 'text-bad', bg: 'bg-bad', ring: 'ring-bad/30' },
  cancelled: { text: 'text-warn', bg: 'bg-warn', ring: 'ring-warn/30' },
};

export const stageColor = (state: string) => STAGE_COLOR[state] ?? STAGE_COLOR.queued;

/**
 * A stable hue per language, so Telugu is the same colour in every list. Derived
 * from the position in LANGUAGES rather than a hash, because a hash makes the
 * palette change whenever the list does.
 */
const LANG_DOTS = [
  'bg-stage-speak', 'bg-stage-translate', 'bg-cyan', 'bg-good',
  'bg-sky', 'bg-warn', 'bg-pink', 'bg-violet',
  'bg-iris', 'bg-cyan', 'bg-stage-translate', 'bg-good',
] as const;

export const languageDot = (code: string) => {
  const i = LANGUAGES.findIndex((l) => l.code === code);
  return i < 0 ? 'bg-fg-subtle' : LANG_DOTS[i % LANG_DOTS.length];
};

export const isTerminal = (state: string) =>
  state === 'done' || state === 'failed' || state === 'cancelled';
