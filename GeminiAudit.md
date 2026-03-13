# OpenFlux0 Code Audit (Post-Remediation Review)

## Executive Summary

`OpenFlux0` previously had several valid denial-of-service and business-logic concerns around unbounded request bodies, task-claim griefing, anchor verification lookups, and FTS query error handling.

Those findings have now been implemented and verified in the current working tree.

**Current verdict:** previous NO-GO blockers from the final Gemini review are resolved in this repo revision.

## Resolved Findings

### 1. Missing body limits on non-publish POST routes

**Previous state**

- Only `/content/publish` had `bodyLimit(...)`.
- Other JSON-ingesting routes could parse unbounded payloads in memory.

**Resolution**

- Body-size middleware now applies across authenticated route groups in `src/index.ts`.
- This covers `/agents/*`, `/content/*`, `/author/*`, and `/tasks/*`.

**Verification**

- Added regression coverage for oversized `/tasks/post` payloads.
- Existing `/content/publish` 413 coverage still passes.

### 2. Task claim starvation / griefing

**Previous state**

- A claimer could hold arbitrary numbers of tasks without any concurrency cap.

**Resolution**

- Added `MAX_CONCURRENT_TASK_CLAIMS` configuration in `src/config.ts`.
- `POST /tasks/:taskId/claim` now rejects claims once the agent reaches the configured active-claim limit.

**Verification**

- Added a regression test showing the third concurrent claim is rejected when the limit is set to `2`.

### 3. O(N) anchor verification lookup

**Previous state**

- Anchor membership lookups depended on `json_each(hash_anchors.cuid_list)`.
- That required repeated JSON expansion for verification and anchor selection logic.

**Resolution**

- Added normalized `anchor_items(anchor_id, cuid)` via migration.
- `src/routes/content.ts` now resolves anchor membership through `anchor_items`.
- `src/anchor.ts` now uses `anchor_items` when deciding which content still needs anchoring.

**Verification**

- Existing anchor verification tests continue to pass after the schema change.
- The migration backfills valid historical anchor memberships from `hash_anchors.cuid_list`.

### 4. Unhandled FTS5 syntax errors

**Previous state**

- Invalid FTS expressions could bubble up as SQLite driver errors.

**Resolution**

- `GET /content/query` now catches FTS execution failures and returns `400 Invalid full-text search query` instead of a generic `500`.

**Verification**

- Added regression coverage for the invalid query `q=%22`.

## Existing Notes

### Daily spend window remains rolling, not calendar-based

- `resetDailyIfNeeded()` still uses a rolling 24-hour window.
- This is a UX issue, not a newly introduced correctness issue.

### Single-node architecture remains a product constraint

- The system still centers on a single embedded SQLite node.
- That is an architectural limitation, but not an unmitigated bug in the current v0 scope.

## Verification Summary

- `bun test` passes on the current tree.
- Current result: `56 pass`, `0 fail`.
