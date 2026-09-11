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
    .replace(/\b[A-Z][A-Za-z0-9_.-]{1,}\b/g, " ")
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
  return { detected: "en", confidence: Math.max(0.6, ratio("Latin")), scripts, meaningfulCharacters };
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
