/**
 * Languages a video can get a language version in. Only facts checked against the engines' own
 * docs are encoded here:
 *  - kokoro: the language code kokoro-onnx takes (hexgrad/kokoro supports American/British English,
 *    Spanish, French, Hindi, Italian, Japanese, Brazilian Portuguese, Mandarin; NOT German or Urdu).
 *  - whisper: the code python/transcribe.py passes to faster-whisper (--language).
 *  - decimalComma: the language writes 4,5 instead of 4.5.
 * A language without Kokoro needs Piper (PIPER_MODEL_<CODE>), XTTS (own voice) or a cloud voice.
 */
export interface LanguageSpec {
  code: string;
  name: string;
  /** Name in the language itself (shown in the picker). */
  native: string;
  whisper: string;
  kokoro: string | null;
  decimalComma: boolean;
}

export const LANGUAGES: Record<string, LanguageSpec> = {
  en: { code: "en", name: "English", native: "English", whisper: "en", kokoro: "en-us", decimalComma: false },
  de: { code: "de", name: "German", native: "Deutsch", whisper: "de", kokoro: null, decimalComma: true },
  es: { code: "es", name: "Spanish", native: "Español", whisper: "es", kokoro: "es", decimalComma: true },
  fr: { code: "fr", name: "French", native: "Français", whisper: "fr", kokoro: "fr-fr", decimalComma: true },
  it: { code: "it", name: "Italian", native: "Italiano", whisper: "it", kokoro: "it", decimalComma: true },
  pt: { code: "pt", name: "Portuguese (Brazil)", native: "Português", whisper: "pt", kokoro: "pt-br", decimalComma: true },
  hi: { code: "hi", name: "Hindi", native: "हिन्दी", whisper: "hi", kokoro: "hi", decimalComma: false },
  ur: { code: "ur", name: "Urdu", native: "اردو", whisper: "ur", kokoro: null, decimalComma: false },
};

export function languageSpec(code: string | undefined | null): LanguageSpec {
  const c = String(code ?? "en").toLowerCase();
  return LANGUAGES[c] ?? LANGUAGES.en;
}

export const isLanguage = (code: unknown): code is string => typeof code === "string" && code.toLowerCase() in LANGUAGES;
