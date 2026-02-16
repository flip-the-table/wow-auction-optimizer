# Development Workflow

## Incremental Commits

Commit after each meaningful change using this format:
```
<type>(<scope>): <summary>
```

Types: `chore`, `docs`, `feat`, `fix`, `perf`, `refactor`, `test`

Scopes: `schema`, `ingest`, `compute`, `meta`, `api`, `web`, `infra`, `docs`

## Documentation Update Rules

1. **Architecture/data flow/API shape changes** --> update `docs/ARCHITECTURE.md` in the same commit.
2. **Significant decisions** --> add an ADR in `docs/ADR/NNNN-<slug>.md` in the same commit.
3. **User-visible behavior changes** --> add `docs/CHANGELOG.md` entry in the same commit.
4. **Ops/config changes** --> update `docs/OPERATIONS.md` in the same commit.

## Living Docs

These docs must stay current as code evolves:
- `docs/ARCHITECTURE.md` -- services, data flow, rate limiting, caching, failure modes
- `docs/ADR/NNNN-<slug>.md` -- significant decisions
- `docs/CHANGELOG.md` -- user-visible changes
- `docs/OPERATIONS.md` -- env vars, running locally, debugging, recovery
- `docs/WORKFLOW.md` -- this document

## Code Organization

- `packages/shared/` -- shared Python code (Blizzard client, config, models). Changes here affect all services.
- `services/api/` -- FastAPI read-only API. No heavy compute here.
- `services/jobs/` -- Background jobs. All heavy computation happens here.
- `apps/web/` -- Next.js frontend. Consumes the API.
- `migrations/` -- SQL migrations. Always add new migrations, never modify existing ones.
- `infra/terraform/` -- Infrastructure as code.
