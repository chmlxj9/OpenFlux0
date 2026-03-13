# OpenFlux0 Audit Validation

Validated against the current working tree on 2026-03-13.

## Summary

The original audit was directionally useful, but it mixed confirmed bugs with a few overstated claims. The highest-risk findings were real:

1. `POST /tasks/post` could debit bounty funds before task creation failed.
2. Auth nonce pruning ran a write-heavy `DELETE` on every authenticated request.
3. Overdue task expiry ran synchronously inside `GET /tasks/available`.
4. Task settlement could fail if `NODE_OPERATOR_PUBKEY` was configured but not registered.

Those issues are now fixed in the working tree and covered by tests.

## Confirmed Findings

### 1. Task posting could strand held funds

**Previous behavior**

- `src/routes/tasks.ts` called `hold()` first.
- The subsequent `INSERT INTO tasks` ran outside the same transaction.
- A foreign-key failure on `source_cuid` left the user's balance reduced with no task created.

**Validation**

- Reproduced locally by posting a task with a nonexistent `source_cuid`.
- Result before fix: HTTP `500`, no task row, persisted `task_bounty_hold` ledger entry, reduced balance.

**Fix**

- Task hold and task insert now run inside a single outer transaction.
- Added regression test for rollback on task creation failure.

### 2. Replay nonce pruning caused unnecessary write contention

**Previous behavior**

- `src/auth.ts` deleted expired rows from `auth_nonces` on every authenticated request.
- SQLite WAL still allows only one writer, so this added avoidable contention on the hot path.

**Fix**

- Request auth now only inserts the nonce.
- Expired nonce pruning moved to a background timer in `src/index.ts`.

### 3. Task expiry work was coupled to a read endpoint

**Previous behavior**

- `GET /tasks/available` ran overdue-task expiry before listing open tasks.
- Expiry scanned overdue claimed tasks and refunded them inline.
- Under backlog, a read endpoint could turn into unbounded maintenance work.

**Fix**

- Expiry moved out of the request path into a background worker.
- Added a dedicated index for claimed-task deadline scans.
- Added regression coverage for the expiry worker path.

### 4. Missing operator account could wedge task settlement

**Previous behavior**

- If `NODE_OPERATOR_PUBKEY` was set but the operator agent was not registered, settlement tried to credit a nonexistent agent.
- That caused a foreign-key failure and left the task stuck at `claimed`.

**Fix**

- Fee collection is now conditional on the operator account existing.
- If no operator account exists, the claimer receives the full bounty and settlement still completes.
- Added regression coverage for this path.

## Findings That Were Overstated

### `credit()` failure mode

This was real in general, but the original audit overreached on where it applied.

- The ledger helper could fail if asked to credit a nonexistent agent.
- That was a real bug in task settlement with a misconfigured operator.
- It was not accurately described for T0 delivery flow, which used different code paths.

### Nested transaction concern

- Nested `db.transaction()` usage existed.
- That was mostly a maintainability issue, not a proven partial-commit bug.
- The concrete user-funds issue came from missing outer transactional scope in task creation, not from savepoint semantics themselves.

## Additional Hardening Included

- Content payment fee handling now avoids burning fee value when an operator pubkey is configured but not registered.
- Ledger mutations were refactored to support explicit reuse inside one outer transaction.

## Verification

- `bun test` passes after the fixes.
- Current result: `53 pass`, `0 fail`.
