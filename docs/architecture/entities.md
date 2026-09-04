# Core Domain Entities

Law 1. Reference implementation: `packages/shared/src/constitution/entities.ts`.

## Principles

- No entity is named after a platform. A `SocialAccount` belongs to a `Platform` (a configuration
  record) — never to "twitter", "linkedin", etc.
- Platform fields that do not generalize live in connector metadata, not in core columns.
- Entities carry `id` and reference other core entities by id so connectors can evolve identifiers
  without core changes.

## Core entity kinds

| Kind | Meaning | Key relationships |
| --- | --- | --- |
| `Person` | Canonical human entity (see identity resolution) | owns zero or more `SocialAccount` |
| `SocialAccount` | A profile on a platform | belongs to a `Platform`, optionally to a `Person` |
| `Platform` | A social platform configuration | has zero or more `SocialAccount`, `Content`, `Interaction` |
| `Content` | A post/thread/media unit | authored by a `SocialAccount`, on a `Platform` |
| `Interaction` | An engagement event (like, mention, comment, repost, follow, DM boundary) | from/to `SocialAccount`, optional target `Content` |
| `Organization` | A company/institution external to the product | employed-by relations |
| `Community` | A group, subreddit, list, or shared audience | contains `SocialAccount` memberships where available |
| `Relationship` | A tie between two `Person` entities in a configurable pipeline | references pipeline + stage |
| `Topic` | A semantic label attached to content/people | linked by content analysis |
| `Opportunity` | A radiaried, evidence-backed action item | typed (conversation, commercial, content gap, …) |

## Rules

1. New platform needs (e.g. Threads, Bluesky, TikTok, YouTube, Mastodon, GitHub) are expressed as
   `Platform` records plus a connector, never as new core entities.
2. Provider-specific or extensible fields use per-platform metadata objects, not bespoke tables.
3. The extension is an interface to XLRrank, not a new source of core entities.