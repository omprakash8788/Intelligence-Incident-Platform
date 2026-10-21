# Module 3 — Lecture 20: Capstone — Production-Grade Leader and Worker Coordination

## Table of Contents

1. Capstone objectives
2. The system we are building
3. Final architecture
4. Responsibility of each component
5. The leader lifecycle
6. The worker lifecycle
7. Failure and recovery scenarios
8. Fencing, idempotency, and database safety
9. Graceful shutdown
10. Integration plan for the existing project
11. Capstone test plan
12. Build, test, and verify
13. Intentional failure exercise
14. Production-readiness checklist
15. Module 3 completion criteria
16. What comes next

---

## 1. Capstone objectives

In this capstone, we combine the distributed-systems concepts studied throughout Module 3:

- At-least-once processing and idempotency.
- Distributed locks and leader election.
- Lease expiration and renewal.
- Fencing tokens.
- Clock drift, timeouts, and lease safety.
- Safe leader runtime.
- Concurrent execution and stale-leader recovery.
- Atomic fencing enforcement in PostgreSQL.
- Cancellation and graceful shutdown.
- Transactional outbox and saga compensation.
- Crash-window analysis and failure-injection testing.

The goal is not merely to make a worker start and process a job. The goal is to define what happens when the system encounters failures.

By the end, you should be able to answer:

1. What prevents two instances from believing they are the active leader?
2. What happens if a leader loses its lease while processing work?
3. How does PostgreSQL reject a stale leader's write?
4. How does the application handle retries without duplicating business effects?
5. How does the process stop without leaving untracked work behind?
6. How do we prove these guarantees with tests?

**Important distinction:** the architecture in this document describes the target system. Because the current contents and test results of every proposed lecture file have not been verified here, this capstone does not claim that your existing repository already satisfies these guarantees.

## 2. The system we are building

Imagine that several instances of the same backend application are running.

```text
                    PostgreSQL
                 /      |      \
                /       |       \
          Instance A  Instance B  Instance C
              |           |           |
           Follower      Leader     Follower
                          |
                    Lease renewal
                          |
                   Protected work
                          |
                   Fencing validation
                          |
                  Idempotent effects
                          |
                   Transactional outbox
                          |
                   Event publication
```

The system has several independent responsibilities:

- PostgreSQL stores durable state.
- Leader election determines which instance currently holds leadership.
- Lease renewal maintains leadership while the instance remains healthy.
- Fencing prevents an older leadership tenure from performing protected writes.
- Idempotency protects business operations from duplicate execution.
- Workers process asynchronous tasks.
- Graceful shutdown stops new work and coordinates the termination of existing work.
- Recovery logic handles uncertain outcomes after failures.

A key architectural rule is that **leadership, work execution, and database authorization are separate concerns**.

Being the current leader in application memory is not sufficient authorization for a database write.

## 3. Final architecture

### 3.1 Target component diagram

```text
Application startup
        |
        v
Dependency readiness
        |
        v
Leader election
        |
        +--------------------+
        |                    |
        v                    v
    Follower              Leader
        |                    |
        |              Lease renewal
        |                    |
        |              Start protected work
        |                    |
        |              Execute with scope
        |                    |
        |              Validate fencing token
        |                    |
        |              Commit durable effect
        |                    |
        |              Record outbox event
        |                    |
        +--------------------+
                 |
                 v
          Failure recovery
                 |
                 v
        Graceful shutdown
```

This is a logical architecture, not a guarantee that your current files are wired together in this order.

### 3.2 Core invariants

An invariant is a condition that must remain true even when the system encounters failures.

| Invariant | Required behavior |
|---|---|
| Leadership ownership | An instance must not treat an expired lease as valid leadership. |
| Fencing | A stale fencing token must not authorize a protected database write. |
| Idempotency | Repeating the same logical operation must not repeat its protected business effect. |
| Transactional consistency | A business update and its outbox record must commit or roll back together when they belong to the same transaction. |
| Lease loss | Work that no longer has authority must stop or become unable to commit protected effects. |
| Shutdown | The application must stop accepting new work and close resources in a controlled order. |
| Recovery | A crash must not cause the system to silently lose durable work or assume an uncertain effect never happened. |

These guarantees need both implementation and tests. A checklist alone does not enforce them.

## 4. Responsibility of each component

The following names refer to the intended responsibilities of the Module 3 exercises. Confirm the actual exports and implementation in your repository before integrating them.

### 4.1 Leader election

Expected responsibility:

- Acquire leadership if no valid leader currently holds the lease.
- Renew the current lease.
- Release leadership when appropriate.
- Issue or preserve a monotonically increasing fencing token across leadership tenures.

The election mechanism should use an authoritative shared store. For this project, PostgreSQL is the intended durable authority for lease and fencing state.

### 4.2 Leader runtime

Expected responsibility:

- Coordinate acquisition and renewal.
- Start protected work when leadership is obtained.
- Detect loss of leadership.
- Stop or cancel the work scope when leadership is lost.
- Avoid starting a second protected runtime while the first runtime is still active.

A runtime should not silently interpret a failed renewal as a successful renewal.

### 4.3 Fencing enforcement

Expected responsibility:

- Carry the fencing token associated with a leadership tenure.
- Validate that token inside the same database operation that performs the protected write.
- Reject writes from older leadership tenures.

The important part is atomic enforcement. Checking the token in application code and then issuing an unrelated SQL update leaves a race window.

### 4.4 Idempotency

Expected responsibility:

- Identify the logical operation using a stable idempotency key.
- Detect reuse of a key with a different request.
- Store the result durably.
- Return the prior result when a legitimate retry repeats the same operation.

The key must identify the logical operation, not merely a single attempt.

### 4.5 Transactional outbox

Expected responsibility:

- Persist an event in the same transaction as the corresponding business update.
- Publish pending events asynchronously.
- Track publication attempts and outcomes.
- Allow safe recovery when publication succeeds but acknowledgement recording fails.

The outbox reduces the risk of losing an event between a database commit and an external publish. It does not eliminate duplicate delivery.

### 4.6 Graceful shutdown

Expected responsibility:

- Stop accepting new work.
- Signal active work to stop where supported.
- Release or allow expiry of leadership according to the lease design.
- Close workers, queue events, database connections, and Redis connections in a safe order.
- Avoid reporting successful shutdown while important cleanup remains unfinished.

Do not assume that requesting cancellation instantly stops an external operation already in flight.

## 5. The leader lifecycle

A safe leader lifecycle can be described as a state machine.

```text
             Start
               |
               v
          Initializing
               |
               v
           Follower
               |
         Acquire lease
               |
               v
            Leader
               |
         Renew lease
          /         \
      Success       Failure
         |              |
         v              v
      Leader       Leadership lost
                        |
                        v
                  Cancel work scope
                        |
                        v
                  Stop protected work
                        |
                        v
                     Follower
```

Shutdown is a separate transition that can be initiated from multiple states.

### 5.1 Acquiring leadership

When an instance acquires leadership, it should receive the lease identity and fencing token associated with that tenure.

The runtime must not start protected work until acquisition has been confirmed.

### 5.2 Renewing leadership

Renewal should be scheduled using a safe interval relative to the lease duration. The interval must leave enough time for transient latency, database contention, and scheduling delays.

Do not treat a successful renewal from a previous cycle as proof that the current lease is still valid.

### 5.3 Losing leadership

When renewal fails or the lease is known to have expired:

1. Stop authorizing new protected work.
2. Signal the current work scope to cancel.
3. Prevent stale work from committing protected database changes.
4. Wait for local work to stop where appropriate.
5. Return to a follower or stopped state.

Cancellation improves resource management. Fencing protects durable state if cancellation arrives too late.

### 5.4 Reacquiring leadership

A former leader should acquire a new valid tenure before resuming leadership work. The new tenure must use the fencing semantics defined by the authoritative lease store.

Never assume that restarting a local timer restores leadership.

## 6. The worker lifecycle

Leader coordination and BullMQ worker processing are related but distinct.

A BullMQ worker may process ordinary asynchronous jobs without being the cluster leader. If a particular job requires leadership, that requirement must be enforced explicitly.

### 6.1 Normal processing

```text
Job received
     |
     v
Validate job input
     |
     v
Check authorization and execution conditions
     |
     v
Execute idempotent operation
     |
     v
Commit durable effects
     |
     v
Acknowledge job completion
```

The exact ordering depends on whether the job's side effect is in PostgreSQL, an external service, or another system.

### 6.2 Failure during processing

Suppose a worker updates a database record and then crashes before BullMQ records the job as complete.

BullMQ may deliver the job again.

The second execution must not blindly repeat the business effect. Use transactionally enforced idempotency or another appropriate deduplication strategy.

### 6.3 A job that requires the active leader

If a job must only execute under leadership, checking a local boolean such as `isLeader` is not sufficient.

The job's protected write must be fenced at the authoritative data store. Otherwise, a worker that has lost leadership may continue after a pause, timeout, or delayed cancellation.

## 7. Failure and recovery scenarios

A production-oriented design should explicitly reason through these failures.

### Scenario A — Two instances attempt to become leader

**Expected behavior:**

- The authoritative store serializes competing acquisitions.
- Only a valid lease holder is treated as leader.
- Leadership transitions use the correct fencing-token semantics.
- Concurrent tests verify that the protected effect cannot be committed by a stale tenure.

Do not test only a single process with mocked timers. Include concurrent operations against the actual store.

### Scenario B — The leader loses database connectivity

**Expected behavior:**

- The runtime must not continue to assume it can renew its lease.
- If lease validity cannot be established, it must stop authorizing new protected work.
- Fencing must reject stale writes when the database becomes available again.
- Recovery must not depend on a local in-memory leader flag alone.

### Scenario C — The lease expires during a slow task

**Expected behavior:**

- The old task receives a cancellation signal if supported.
- A new leader may begin work after acquiring a valid tenure.
- The old task must be unable to commit a protected write with a stale fencing token.
- Any external effect already performed must be handled using idempotency or reconciliation.

### Scenario D — The process crashes after committing an update

**Expected behavior:**

- The durable database state remains authoritative.
- A retried logical operation must not duplicate the business effect.
- If an outbox event was written in the same transaction, it remains available for publication.

### Scenario E — The destination accepts an event, but the publisher crashes

**Expected behavior:**

- The outbox event may be delivered again.
- The destination must deduplicate the logical event if repeated effects are unacceptable.
- The publisher must not assume that a missing acknowledgement means the destination rejected the event.

### Scenario F — Shutdown occurs while work is active

**Expected behavior:**

- No new work is accepted after shutdown begins.
- Cancellation is signaled to active work.
- Protected writes remain fenced.
- Resources are closed in a controlled order.
- Shutdown errors are surfaced rather than silently ignored.

## 8. Fencing, idempotency, and database safety

These mechanisms solve different problems.

| Mechanism | What it protects |
|---|---|
| Distributed lease | Coordinates temporary ownership. |
| Fencing token | Rejects stale leadership tenures at the protected resource. |
| Idempotency key | Prevents repeated logical operations from repeating a protected effect. |
| Database transaction | Groups related database changes atomically. |
| Transactional outbox | Keeps event intent consistent with the business transaction. |
| Cancellation | Requests that active work stop. |
| Reconciliation | Resolves uncertain outcomes using durable evidence. |

No single mechanism replaces all the others.

### 8.1 Why fencing must be enforced atomically

Consider this unsafe pattern:

```text
Application checks token
          |
          v
Application is paused
          |
          v
Another leader acquires a newer token
          |
          v
Old application resumes
          |
          v
Old application writes
```

The check and write are separated by a race window.

The safe design validates the fencing token and applies the protected update in one atomic database operation or transaction, using the schema's actual fencing rules.

The exact SQL must match your existing lease and resource tables. Do not copy a generic SQL statement into your project without inspecting the real migrations and schema.

### 8.2 Why idempotency must be durable

An in-memory set of completed IDs is lost when the process restarts.

If a business effect must survive restarts, the deduplication state must be stored durably and coordinated atomically with the effect it protects.

### 8.3 Why the outbox is not exactly-once delivery

A publisher can crash after the destination accepts an event but before the database records publication. Recovery may redeliver the event.

The practical guarantee is usually at-least-once delivery plus idempotent handling—not universal exactly-once delivery.

## 9. Graceful shutdown

Graceful shutdown should be designed as an ordered process, not a collection of unrelated `close()` calls.

A reasonable target sequence is:

1. Mark the application as shutting down.
2. Stop accepting new application requests or work according to the server lifecycle.
3. Stop accepting new jobs or initiating new protected tasks.
4. Signal active work to cancel.
5. Stop or relinquish leadership according to the lease contract.
6. Await active work and worker shutdown within a bounded deadline.
7. Close queue-event listeners and queues.
8. Close Redis and database resources after their dependents have stopped.
9. Exit with an appropriate status if cleanup succeeded or failed.

The actual order must respect the dependencies in your repository. For example, do not close a database pool before a worker that still requires it has stopped.

A timeout during shutdown also needs an explicit policy: the application may need to stop waiting and exit, but the database must still reject stale protected writes.

**Do not replace your existing shutdown implementation in `src/workers.ts` during this lecture without first reviewing the complete file and its current tests.**

## 10. Integration plan for the existing project

Project root:

`D:\Production-Intelligence-Incident-Platform\production-intelligence-platform`

Your existing migrations are under:

`src/database/migrations/`

Keep them there. Do not create a root-level `database/` directory, rename migrations, or introduce a duplicate table.

### Phase 1 — Inventory the repository

Before wiring components together, inspect the actual files.

From PowerShell, run:

```powershell
Get-Location

Get-ChildItem src/services -File |
  Select-Object Name

Get-ChildItem src/database/migrations -File |
  Sort-Object Name |
  Select-Object Name

Get-ChildItem tests -File |
  Select-Object Name

Get-Content package.json
```

These commands inspect filenames and scripts; they do not modify the project.

Next, inspect the relevant files individually:

```powershell
Get-Content src/workers.ts
Get-Content src/database/pool.ts
Get-Content src/database/transaction.ts
```

If a path does not exist, do not create a replacement automatically. First establish which implementation the project currently uses.

### Phase 2 — Establish the current baseline

Run the existing build and test scripts before making integration changes:

```powershell
npm run build
npm run test:run
```

If `test:run` is not defined in your `package.json`, use the test command that already exists.

Record:

- Which commands passed.
- Which tests failed before the capstone changes.
- Whether integration tests require a running PostgreSQL instance or environment variables.
- Whether the working tree contains uncommitted changes.

Do not attribute a pre-existing failure to the capstone.

### Phase 3 — Audit each responsibility

For every existing component, answer the following questions.

**Leader election**

- Is lease acquisition atomic?
- Can an expired lease be acquired by another instance?
- Are renewal and release conditional on the correct leader identity and token?
- Is the fencing token monotonically increasing across new tenures?

**Leader runtime**

- Does it avoid starting protected work before acquisition succeeds?
- Does it handle renewal failure?
- Can it accidentally start duplicate local runtimes?
- Does it await cancellation and cleanup?

**Fencing**

- Is the token checked atomically with the protected write?
- Does the database reject a stale token?
- Are concurrent leader transitions covered by tests?

**Idempotency**

- Is the key stable across retries?
- Is a reused key with a different request rejected?
- Is the stored result committed atomically with the business effect?

**Outbox**

- Is the event written in the same transaction as the business change?
- Can claims be recovered after a publisher crash?
- Are duplicate deliveries handled?
- Is publication state updated only by the appropriate claim owner?

**Shutdown**

- Are new tasks prevented from starting?
- Is active work cancelled or awaited?
- Are resources closed in dependency order?
- Are cleanup failures visible?

Mark a responsibility as verified only when the actual implementation and tests support the claim.

### Phase 4 — Integrate incrementally

Do not combine every component into one large edit.

Use this order:

1. Verify the lease and fencing implementation.
2. Verify stale-token rejection against PostgreSQL.
3. Verify the leader runtime's acquisition, renewal, and loss transitions.
4. Verify cancellation of active work.
5. Verify idempotent business effects.
6. Verify transactional outbox recovery.
7. Integrate only the components needed by the existing worker architecture.
8. Test startup failure and graceful shutdown.
9. Run the full regression suite.

After each phase, run the relevant targeted tests and build before proceeding.

### Phase 5 — Decide whether `src/workers.ts` must change

Do not edit `src/workers.ts` simply because this is a capstone.

An integration change is justified only if the verified architecture requires the worker entry point to start, supervise, or stop a component that is not already managed.

If changes are required, first establish:

- The current startup order.
- The existing cleanup order.
- Which resources are already closed by the current implementation.
- How startup failure is handled.
- Which tests cover the worker lifecycle.

Then modify the smallest necessary section and show the complete revised file when making that change.

**No worker integration is performed by the commands or exercises in this document.**

## 11. Capstone test plan

A production-oriented test plan should include the following layers.

### Layer 1 — Unit tests

Test pure logic:

- Lease timing decisions.
- Leader state transitions.
- Retry policies.
- Crash-window recovery decisions.
- Cancellation behavior.
- Idempotency-key validation.

These tests should be fast and deterministic.

### Layer 2 — PostgreSQL integration tests

Use a dedicated test database.

Verify:

- Atomic lease acquisition.
- Lease renewal and release.
- Fencing-token advancement.
- Rejection of stale writes.
- Transaction rollback.
- Idempotency under concurrent requests.
- Atomic business update plus outbox insertion.

Do not run destructive integration tests against production data.

### Layer 3 — Redis and BullMQ integration tests

Use a dedicated Redis instance and isolated queue names.

Verify:

- Jobs can be enqueued and processed.
- Failed jobs follow the configured retry policy.
- Workers close cleanly.
- Job retries do not duplicate protected business effects.
- Worker recovery behaves as expected after a controlled restart.

### Layer 4 — Multi-instance tests

Run at least two independent instances.

Verify:

- Competing leaders cannot both commit protected writes using valid authority.
- A stale leader's write is rejected after a newer tenure takes control.
- Lease expiry and reacquisition behave correctly.
- Concurrent operations do not violate idempotency constraints.

### Layer 5 — Crash-window tests

Inject failures at precise points:

- After a business transaction commits.
- After an outbox event is claimed.
- After destination acceptance but before publication is recorded.
- After lease loss but before local work exits.
- During graceful shutdown.

For every test, inspect durable state after recovery. A log message alone is not proof of correctness.

## 12. Build, test, and verify

From the project root, run the existing commands:

### Step 1 — Build

```powershell
npm run build
```

### Step 2 — Run the unit tests

```powershell
npm run test:run
```

### Step 3 — Run the existing integration tests

Use the integration-test command already configured in your repository. Confirm that the test environment points to a dedicated database and Redis instance.

Do not invent a new script or environment variable without checking the current test configuration.

### Step 4 — Review the results

Record each result as one of:

- **Passed:** the command completed successfully.
- **Failed:** the command returned an error or test failures.
- **Not run:** the required environment was unavailable or the test has not yet been executed.

Do not claim the capstone is verified merely because the TypeScript build succeeds.

## 13. Intentional failure exercise

This final exercise is a test-design exercise, not a request to break the production worker.

### Failure to simulate

The destination accepts an outbox event, but the publisher crashes before marking it published.

### Expected recovery behavior

1. The outbox record remains pending or otherwise recoverable.
2. A later publisher can reclaim the event according to the lease policy.
3. The event may be delivered again.
4. The destination recognizes the same logical event identifier.
5. The business effect is not applied twice.
6. The publisher records successful delivery after receiving the appropriate confirmation.

### Required assertions

Your eventual integration test should assert:

- The business effect exists.
- The business effect has occurred only once.
- The event is eventually marked published.
- Duplicate delivery attempts, if any, are observable.
- No permanent pending record remains after successful recovery.

Do not implement this test by merely mocking the publisher's success response. To prove the end-to-end behavior, use the actual persistence layer and a destination test double that records accepted event identifiers durably for the duration of the test.

If the destination itself is PostgreSQL, make the deduplication record and business update part of the same transaction. If the destination is external, use its idempotency contract or a reconciliation mechanism appropriate to that system.

## 14. Production-readiness checklist

Use this as a review checklist, not as a claim that the repository has already passed it.

### Leadership and fencing

- [ ] Lease acquisition is atomic.
- [ ] Renewal cannot revive an expired tenure incorrectly.
- [ ] Release is conditional on the correct owner and tenure.
- [ ] Fencing tokens advance correctly across new tenures.
- [ ] PostgreSQL rejects stale protected writes atomically.
- [ ] Concurrent leader tests cover the relevant races.

### Work execution

- [ ] Work does not begin before required authorization is confirmed.
- [ ] Lease loss stops new protected work.
- [ ] Active work receives cancellation where supported.
- [ ] Stale work cannot commit protected effects.
- [ ] Retries do not duplicate business effects.

### Durable operations

- [ ] Idempotency state survives restarts.
- [ ] Business changes and outbox records are committed atomically.
- [ ] Outbox claims are recoverable.
- [ ] Duplicate delivery is handled safely.
- [ ] Uncertain outcomes have a defined reconciliation strategy.

### Lifecycle and observability

- [ ] Startup failures clean up already-opened resources.
- [ ] Shutdown prevents new work from starting.
- [ ] Shutdown waits for required cleanup within a bounded deadline.
- [ ] Database and Redis connections close after their dependents stop.
- [ ] Logs and metrics distinguish retries, lease loss, stale-write rejection, and recovery.
- [ ] Tests verify durable outcomes, not just logs.

## 15. Module 3 completion criteria

Module 3 is complete when the relevant implementations have been verified—not merely proposed—and the following can be demonstrated:

1. Two instances compete for leadership safely.
2. Lease loss is detected and handled.
3. Fencing prevents stale writes.
4. Retried business operations do not duplicate protected effects.
5. Transactional outbox events survive publisher crashes.
6. Workers and leader runtimes stop safely.
7. Integration tests reproduce important crash windows.
8. Build and test results are recorded accurately.

Some of the earlier lectures introduced isolated examples and policies. They should not be treated as a fully integrated system until the real files, migrations, and test results have been reviewed.

## 16. What comes next

**Module 3 is now complete as a learning sequence.**

The next practical step is a repository audit and integration pass: inspect your actual `src/services/`, `src/database/migrations/`, `src/workers.ts`, and `tests/` files, identify which lecture implementations exist, run the baseline build and tests, and then integrate only the missing pieces.

That approach is safer than replacing the worker entry point or adding new migrations based on assumptions about the current repository.