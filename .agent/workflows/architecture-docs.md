---
description: How to update architecture docs when making code changes
---

# Architecture Documentation Workflow

When making changes to the codebase, follow these rules to keep documentation current.

## When to Update

| Change Type | Files to Update |
|-------------|-----------------|
| Architecture/data flow/API shape | `docs/ARCHITECTURE.md` in same commit |
| Significant design decisions | Add new `docs/ADR/NNNN-<slug>.md` in same commit |
| User-visible behavior changes | `docs/CHANGELOG.md` in same commit |
| Ops/config/env var changes | `docs/OPERATIONS.md` in same commit |
| New workflow or process | `docs/WORKFLOW.md` in same commit |

## Steps

1. **Identify** which docs are affected by your code change

2. **Update** the docs as part of the same commit:
   - For `ARCHITECTURE.md`: update the services diagram, data flow, caching, or failure modes sections as needed
   - For ADRs: create a new `docs/ADR/NNNN-<slug>.md` with Status, Context, Decision, Rationale, Consequences
   - For `CHANGELOG.md`: add entry under the current date with Features/Fixes/Breaking Changes
   - For `OPERATIONS.md`: update env vars table, commands, or debugging queries
   - For `WORKFLOW.md`: update commit conventions or documentation rules

3. **Commit** both code and doc changes together:
```bash
git add <code-files> <doc-files>
git commit -m "<type>(<scope>): <summary>"
```

## ADR Template

```markdown
# ADR NNNN: Title

## Status
Proposed | Accepted | Deprecated | Superseded

## Context
What is the issue that is motivating this decision?

## Decision
What is the decision and the change being proposed?

## Rationale
Why is this the best approach?

## Consequences
What becomes easier or harder?
```

## Quick Reference -- Current Architecture

The app consists of:
- **Frontend + API**: Next.js on Netlify (API Route Handlers query Neon Postgres directly)
- **Background Jobs**: Python scripts run via GitHub Actions hourly
  - `services/jobs/ingest.py` -- fetch auction data from Blizzard
  - `services/jobs/compute.py` -- calculate baselines, z-scores, hotness
  - `services/jobs/meta_resolve.py` -- resolve item names + icons
- **Database**: Neon.tech serverless Postgres (or any Postgres)
- **Shared Python**: `packages/shared/` (Blizzard client, config, ORM models)

When adding or modifying any of these, update `docs/ARCHITECTURE.md` accordingly.
