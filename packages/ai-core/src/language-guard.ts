export type SupportedLanguage = "en" | "zh" | "ja" | "ko" | "es" | "fr" | "de" | "pt" | "ar" | "ru";

export interface LanguagePolicy {
  defaultLanguage: SupportedLanguage;
  allowedLanguages: SupportedLanguage[];
  strictMode: boolean;
  maxRepairAttempts: number;
}

export const DEFAULT_LANGUAGE_POLICY: LanguagePolicy = {
  defaultLanguage: "en",
  allowedLanguages: ["en"],
  strictMode: true,
  maxRepairAttempts: 2,
};

export interface LanguageDetectionResult {
  detected: SupportedLanguage;
  confidence: number;
  scripts: string[];
}

export interface LanguageGuardResult {
  passed: boolean;
  originalLanguage: SupportedLanguage | null;
  outputLanguage: SupportedLanguage | null;
  repaired: boolean;
  repairAttempts: number;
  content: string;
}

const CJK_RANGES = [
  { start: 0x4e00, end: 0x9fff, name: "CJK Unified" },
  { start: 0x3400, end: 0x4dbf, name: "CJK Extension A" },
  { start: 0x3040, end: 0x309f, name: "Hiragana" },
  { start: 0x30a0, end: 0x30ff, name: "Katakana" },
  { start: 0xac00, end: 0xd7af, name: "Hangul" },
];

function detectScripts(text: string): string[] {
  const scripts = new Set<string>();
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    for (const range of CJK_RANGES) {
      if (code >= range.start && code <= range.end) {
        scripts.add(range.name);
        break;
      }
    }
    if (code >= 0x0600 && code <= 0x06ff) scripts.add("Arabic");
    if (code >= 0x0400 && code <= 0x04ff) scripts.add("Cyrillic");
    if ((code >= 0x0041 && code <= 0x007a) || (code >= 0x00c0 && code <= 0x024f)) {
      scripts.add("Latin");
    }
  }
  return [...scripts];
}

export function detectLanguage(text: string): LanguageDetectionResult {
  const scripts = detectScripts(text);
  if (scripts.includes("Hiragana") || scripts.includes("Katakana")) {
    return { detected: "ja", confidence: 0.9, scripts };
  }
  if (scripts.includes("Hangul")) {
    return { detected: "ko", confidence: 0.9, scripts };
  }
  if (scripts.includes("CJK Unified")) {
    if (scripts.includes("Hiragana") || scripts.includes("Katakana")) {
      return { detected: "ja", confidence: 0.85, scripts };
    }
    return { detected: "zh", confidence: 0.7, scripts };
  }
  if (scripts.includes("Arabic")) {
    return { detected: "ar", confidence: 0.8, scripts };
  }
  if (scripts.includes("Cyrillic")) {
    return { detected: "ru", confidence: 0.8, scripts };
  }
  return { detected: "en", confidence: 0.6, scripts };
}

function isProtectedToken(word: string): boolean {
  return /^https?:\/\//.test(word) ||
    /^[\w.-]+@[\w.-]+\.\w+$/.test(word) ||
    /^@\w+$/.test(word) ||
    /^\d+[\d.,]*$/.test(word) ||
    /^[A-Z_]{2,}$/.test(word) ||
    /^`[^`]+`$/.test(word);
}

export function languageGuard(
  content: string,
  policy: LanguagePolicy,
): LanguageGuardResult {
  if (!content.trim()) {
    return {
      passed: true,
      originalLanguage: null,
      outputLanguage: null,
      repaired: false,
      repairAttempts: 0,
      content,
    };
  }

  const detection = detectLanguage(content);
  const isAllowed = policy.allowedLanguages.includes(detection.detected);

  if (isAllowed) {
    return {
      passed: true,
      originalLanguage: detection.detected,
      outputLanguage: detection.detected,
      repaired: false,
      repairAttempts: 0,
      content,
    };
  }

  if (!policy.strictMode) {
    return {
      passed: true,
      originalLanguage: detection.detected,
      outputLanguage: detection.detected,
      repaired: false,
      repairAttempts: 0,
      content,
    };
  }

  const repaired = repairLanguageContent(content, policy);
  return {
    passed: repaired.success,
    originalLanguage: detection.detected,
    outputLanguage: repaired.success ? policy.defaultLanguage : detection.detected,
    repaired: repaired.success,
    repairAttempts: repaired.attempts,
    content: repaired.success ? repaired.content : content,
  };
}

function repairLanguageContent(
  content: string,
  policy: LanguagePolicy,
): { success: boolean; content: string; attempts: number } {
  const lines = content.split("\n");
  const repairedLines: string[] = [];

  for (const line of lines) {
    const words = line.split(/(\s+)/);
    const repairedWords: string[] = [];
    let hasNonProtectedContent = false;

    for (const word of words) {
      if (isProtectedToken(word)) {
        repairedWords.push(word);
      } else {
        const detection = detectLanguage(word);
        if (detection.detected !== policy.defaultLanguage && detection.confidence > 0.5) {
          hasNonProtectedContent = true;
          repairedWords.push(`[${policy.defaultLanguage}]`);
        } else {
          repairedWords.push(word);
        }
      }
    }

    if (hasNonProtectedContent) {
      repairedLines.push(repairedWords.join(""));
    } else {
      repairedLines.push(line);
    }
  }

  const result = repairedLines.join("\n");
  const finalDetection = detectLanguage(result);
  const success = policy.allowedLanguages.includes(finalDetection.detected);

  return { success, content: result, attempts: 1 };
}

export function configureLanguagePolicy(overrides: Partial<LanguagePolicy>): LanguagePolicy {
  return { ...DEFAULT_LANGUAGE_POLICY, ...overrides };
}
