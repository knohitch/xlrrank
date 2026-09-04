# ADR-0001 — Monorepo and tooling

Status: Accepted.

## Context

The prompt pack mandates a monorepo with four apps (web, api, worker, extension) and eleven
packages, TypeScript everywhere, and reproducible installs on machines without Docker.

## Decision

- **pnpm workspaces** over npm/yarn for install speed, strictness, and workspace ergonomics.
- One root `tsconfig.base.json` with strict mode; every package extends it.
- Package names scoped `@xlrrank/*`.
- Node `>=20.19.0`, package manager pinned via `packageManager: pnpm@11.23.0`.
- Root scripts: `lint:constitution`, `test:constitution`, `typecheck`, `test`, `lint`.

## Consequences

- Shared configuration can be hoisted to `packages/config` as tooling matures.
- Future phases (UI, lint, format, test harness) extend the same workspace root without restructuring.