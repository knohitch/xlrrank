# Evidence and Provenance

Laws 4 and 5. Reference implementation: `packages/shared/src/constitution/evidence.ts`.

## Evidence source kinds

| Kind | Meaning | Example |
| --- | --- | --- |
| `OBSERVED` | Retrieved through an official API or source system | follower count from the platform API |
| `USER_PROVIDED` | Stated by the user | "I am an angel investor" in profile settings |
| `DERIVED` | Computed deterministically from other facts | engagement rate, relationship momentum |
| `INFERRED` | Produced by an AI model or probabilistic process | "likely fintech investor" (Social DNA attribute) |

`OBSERVED`/`USER_PROVIDED` are facts. `DERIVED` is mathematics over facts. `INFERRED` is
interpretation. The three are stored separately and never mixed.

## Provenance

Every significant recommendation carries a provenance record answering:

- **Evidence**: which evidence objects produced this result (ids + kinds).
- **Scoring version**: which deterministic scoring configuration/version was used.
- **AI model + prompt version**: for any inference that influenced the result.
- **Time**: when the result was generated.

The `Provenance` type in `evidence.ts` is the contract. Explanations for "why this person",
"why this opportunity", etc. must be buildable purely from stored evidence and provenance.

## Confidence

Inference quality is tracked as `Confidence` (0..1). Identity matching uses the discrete ladder:
`confirmed`, `probable`, `uncertain`, `rejected`. Uncertain or probable identities are never merged
automatically (see identity resolution phase).