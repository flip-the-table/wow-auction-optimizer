---
description: How to make incremental commits with proper format
---
// turbo-all

# Incremental Commits

Commit after each meaningful change using this format:
```
<type>(<scope>): <summary>
```

## Types
- `chore` - build, CI, deps, configuration
- `docs` - documentation only
- `feat` - new feature
- `fix` - bug fix
- `perf` - performance improvement
- `refactor` - code change that neither fixes a bug nor adds a feature
- `test` - adding or updating tests

## Scopes
- `schema` - database schema or migrations
- `ingest` - ingest background job
- `compute` - compute background job
- `meta` - metadata resolver job
- `api` - API routes (Next.js API Route Handlers)
- `web` - frontend UI components and pages
- `infra` - Terraform, Netlify config, GitHub Actions
- `docs` - documentation files
- `shared` - packages/shared Python modules

## Steps

1. Stage the relevant files:
```bash
git add <files>
```

2. Commit with the conventional format:
```bash
git commit -m "<type>(<scope>): <summary>"
```

3. Push:
```bash
git push origin main
```

## Examples
```bash
git add packages/shared/models.py migrations/001_initial.sql
git commit -m "feat(schema): add 7-table schema with indexes and constraints"

git add services/jobs/ingest.py
git commit -m "feat(ingest): add auction data ingestion with ETag caching and demand proxy"

git add apps/web/src/app/page.tsx apps/web/src/app/globals.css
git commit -m "feat(web): add Hot Items Radar with sortable table and premium dark theme"

git add docs/ARCHITECTURE.md docs/ADR/0001-demand-proxy-via-snapshot-churn.md
git commit -m "docs(docs): add architecture doc and demand proxy ADR"
```

## Batch Commit (all current changes)

To commit everything at once with a summary message:
```bash
git add -A
git commit -m "feat: initial WoW Auction Optimizer implementation"
git push origin main
```
