# SQLite enforces dispatch idempotency

Pi Conductor will rely on SQLite transactions and uniqueness constraints to prevent duplicate active runs for the same work item. It will not add a separate process lock in v1; command implementations must treat the database as the local concurrency boundary.
