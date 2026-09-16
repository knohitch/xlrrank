export type SupportedLanguage = "en" | "zh" | "ja" | "ko" | "es" | "fr" | "de" | "pt" | "ar" | "ru";

export interface LanguagePolicy {
  defaultLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  allowedLanguages: SupportedLanguage[];
  enforcementEnabled: boolean;
  strictMode: boolean;
  maxRepairAttempts: number;
  maxRetryAttempts: number;
  minimumTextCharacters: number;
  minimumConfidence: number;
  allowFallback: boolean;
}

export const DEFAULT_LANGUAGE_POLICY: LanguagePolicy = {
  defaultLanguage: "en",
  targetLanguage: "en",
  allowedLanguages: ["en"],
  enforcementEnabled: true,
  strictMode: true,
  maxRepairAttempts: 2,
  maxRetryAttempts: 2,
  minimumTextCharacters: 24,
  minimumConfidence: 0.55,
  allowFallback: true,
};

export interface LanguageDetectionResult {
  detected: SupportedLanguage;
  confidence: number;
  scripts: string[];
  meaningfulCharacters: number;
}

export interface LanguageGuardResult {
  passed: boolean;
  originalLanguage: SupportedLanguage | null;
  outputLanguage: SupportedLanguage | null;
  repaired: false;
  repairAttempts: number;
  content: string;
  targetLanguage: SupportedLanguage;
  confidence: number;
  reason?: string;
}

const SCRIPT_RANGES = [
  { start: 0x4e00, end: 0x9fff, name: "CJK Unified" },
  { start: 0x3400, end: 0x4dbf, name: "CJK Extension A" },
  { start: 0x3040, end: 0x309f, name: "Hiragana" },
  { start: 0x30a0, end: 0x30ff, name: "Katakana" },
  { start: 0xac00, end: 0xd7af, name: "Hangul" },
  { start: 0x0600, end: 0x06ff, name: "Arabic" },
  { start: 0x0400, end: 0x04ff, name: "Cyrillic" },
  { start: 0x0041, end: 0x007a, name: "Latin" },
  { start: 0x00c0, end: 0x024f, name: "Latin" },
] as const;

function stripProtectedContent(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, " ")
    .replace(/@[A-Za-z0-9_]+/g, " ")
    .replace(/\b[A-Z_]{2,}\b/g, " ");
}

function scriptCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    for (const range of SCRIPT_RANGES) {
      if (code >= range.start && code <= range.end) {
        counts.set(range.name, (counts.get(range.name) ?? 0) + 1);
        break;
      }
    }
  }
  return counts;
}

const LATIN_LANGUAGE_MARKERS: Record<Extract<SupportedLanguage, "en" | "es" | "fr" | "de" | "pt">, {
  words: Set<string>;
  fragments: RegExp[];
}> = {
  en: {
    words: new Set(["the", "and", "this", "that", "with", "for", "from", "will", "should", "answer", "clearly", "written", "english", "result", "ready", "because", "language"]),
    fragments: [/\b(?:tion|ing|ed|ly)\b/i],
  },
  es: {
    words: new Set(["el", "la", "los", "las", "un", "una", "este", "esta", "que", "con", "para", "por", "respuesta", "claramente", "espanol", "español", "debe", "idioma", "porque", "gracias"]),
    fragments: [/[áéíóúñ¿¡]/i, /\b(?:ción|mente|dad|ado|ada|idos|idas)\b/i],
  },
  fr: {
    words: new Set(["le", "la", "les", "un", "une", "des", "ce", "cette", "que", "avec", "pour", "par", "reponse", "réponse", "clairement", "francais", "français", "doit", "langue", "parce", "merci"]),
    fragments: [/[àâçéèêëîïôûùüÿœ]/i, /\b(?:tion|ment|ique|eurs|euse)\b/i],
  },
  de: {
    words: new Set(["der", "die", "das", "ein", "eine", "und", "ist", "mit", "fur", "für", "antwort", "klar", "deutsch", "sollte", "sprache", "weil", "danke", "nicht"]),
    fragments: [/[äöüß]/i, /\b(?:ung|keit|lich|isch|chen)\b/i],
  },
  pt: {
    words: new Set(["o", "a", "os", "as", "um", "uma", "este", "esta", "que", "com", "para", "por", "resposta", "claramente", "portugues", "português", "deve", "idioma", "porque", "obrigado"]),
    fragments: [/[áâãàçéêíóôõú]/i, /\b(?:ção|ções|mente|dade|ado|ada)\b/i],
  },
};

function detectLatinLanguage(text: string, latinRatio: number): Pick<LanguageDetectionResult, "detected" | "confidence"> {
  const tokens = text
    .toLocaleLowerCase("und")
    .normalize("NFC")
    .match(/[\p{L}']+/gu) ?? [];
  if (tokens.length < 3 || latinRatio < 0.4) {
    return { detected: "en", confidence: Math.max(0.1, latinRatio * 0.5) };
  }

  const scores = new Map<SupportedLanguage, number>();
  for (const [language, markers] of Object.entries(LATIN_LANGUAGE_MARKERS) as Array<[SupportedLanguage, typeof LATIN_LANGUAGE_MARKERS["en"]]>) {
    let score = 0;
    for (const token of tokens) {
      if (markers.words.has(token)) score += 2;
    }
    for (const fragment of markers.fragments) {
      if (fragment.test(text)) score += 1.5;
    }
    scores.set(language, score);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [bestLanguage, bestScore] = ranked[0] ?? ["en", 0];
  const secondScore = ranked[1]?.[1] ?? 0;
  if (bestScore <= 0) return { detected: "en", confidence: 0.35 };
  const confidence = Math.min(0.98, Math.max(0.45, (bestScore - secondScore + bestScore / Math.max(tokens.length, 1)) / 4));
  return { detected: bestLanguage, confidence };
}

export function detectLanguage(text: string): LanguageDetectionResult {
  const normalized = stripProtectedContent(text);
  const counts = scriptCounts(normalized);
  const meaningfulCharacters = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const scripts = [...counts.entries()].filter(([, count]) => count > 0).map(([script]) => script);

  if (meaningfulCharacters === 0) {
    return { detected: "en", confidence: 0, scripts, meaningfulCharacters };
  }

  const ratio = (script: string): number => (counts.get(script) ?? 0) / meaningfulCharacters;
  if (ratio("Hiragana") + ratio("Katakana") >= 0.15) {
    return { detected: "ja", confidence: ratio("Hiragana") + ratio("Katakana") + ratio("CJK Unified") * 0.5, scripts, meaningfulCharacters };
  }
  if (ratio("Hangul") >= 0.25) {
    return { detected: "ko", confidence: ratio("Hangul"), scripts, meaningfulCharacters };
  }
  if (ratio("CJK Unified") + ratio("CJK Extension A") >= 0.25) {
    return { detected: "zh", confidence: ratio("CJK Unified") + ratio("CJK Extension A"), scripts, meaningfulCharacters };
  }
  if (ratio("Arabic") >= 0.25) {
    return { detected: "ar", confidence: ratio("Arabic"), scripts, meaningfulCharacters };
  }
  if (ratio("Cyrillic") >= 0.25) {
    return { detected: "ru", confidence: ratio("Cyrillic"), scripts, meaningfulCharacters };
  }
  const latin = detectLatinLanguage(normalized, ratio("Latin"));
  return { ...latin, scripts, meaningfulCharacters };
}

export function languageGuard(
  content: string,
  policy: LanguagePolicy,
): LanguageGuardResult {
  const targetLanguage = policy.targetLanguage ?? policy.defaultLanguage;
  if (!policy.enforcementEnabled || !policy.strictMode || !content.trim()) {
    return {
      passed: true,
      originalLanguage: null,
      outputLanguage: null,
      repaired: false,
      repairAttempts: 0,
      content,
      targetLanguage,
      confidence: 0,
    };
  }

  const detection = detectLanguage(content);
  if (detection.meaningfulCharacters < policy.minimumTextCharacters) {
    return {
      passed: true,
      originalLanguage: detection.detected,
      outputLanguage: detection.detected,
      repaired: false,
      repairAttempts: 0,
      content,
      targetLanguage,
      confidence: detection.confidence,
      reason: "below_minimum_text_threshold",
    };
  }

  const allowed = new Set(policy.allowedLanguages.length > 0 ? policy.allowedLanguages : [targetLanguage]);
  allowed.add(targetLanguage);
  const passed = allowed.has(detection.detected) || detection.confidence < policy.minimumConfidence;
  return {
    passed,
    originalLanguage: detection.detected,
    outputLanguage: detection.detected,
    repaired: false,
    repairAttempts: 0,
    content,
    targetLanguage,
    confidence: detection.confidence,
    ...(passed ? {} : { reason: "target_language_mismatch" }),
  };
}

export function configureLanguagePolicy(overrides: Partial<LanguagePolicy>): LanguagePolicy {
  const targetLanguage = overrides.targetLanguage ?? overrides.defaultLanguage ?? DEFAULT_LANGUAGE_POLICY.targetLanguage;
  return {
    ...DEFAULT_LANGUAGE_POLICY,
    ...overrides,
    targetLanguage,
    defaultLanguage: overrides.defaultLanguage ?? targetLanguage,
    allowedLanguages: overrides.allowedLanguages ?? [targetLanguage],
  };
}
