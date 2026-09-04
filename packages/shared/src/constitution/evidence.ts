/**
 * Architectural Law #4 — Raw data, facts and AI inference are different.
 * Architectural Law #5 — Provenance.
 *
 * Every significant piece of intelligence must carry an evidence source kind and
 * must remain explainable: what evidence, which scoring version, which AI model,
 * which prompt version, and when it was generated.
 */

export const EVIDENCE_SOURCE_KINDS = [
  "OBSERVED",
  "USER_PROVIDED",
  "DERIVED",
  "INFERRED",
] as const;

export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

export interface EvidenceRef {
  id: string;
  kind: EvidenceSourceKind;
  source: {
    type: "SYSTEM" | "CONNECTOR" | "USER" | "AI_MODEL";
    connectorId?: string;
    modelId?: string;
  };
  capturedAt: string;
}

export interface Provenance {
  evidenceRefs: EvidenceRef[];
  scoringVersion?: string;
  aiConfig?: {
    modelId: string;
    promptVersion: string;
  };
  generatedAt: string;
}

export type Confidence = number;

export const IDENTITY_CONFIDENCE = [
  "confirmed",
  "probable",
  "uncertain",
  "rejected",
] as const;

export type IdentityConfidence = (typeof IDENTITY_CONFIDENCE)[number];