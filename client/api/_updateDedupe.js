// Best-effort update deduplication within a warm serverless instance.
// Cross-instance durability would require a database-backed idempotency key.
const processedUpdates = new Map();
const UPDATE_DEDUPE_TTL_MS = 10 * 60 * 1000;
const UPDATE_DEDUPE_MAX = 2000;

export function isDuplicateUpdate(updateId, now = Date.now()) {
  if (updateId === undefined || updateId === null) return false;
  for (const [id, expiresAt] of processedUpdates) {
    if (expiresAt <= now) processedUpdates.delete(id);
  }
  const key = String(updateId);
  if (processedUpdates.has(key)) return true;
  processedUpdates.set(key, now + UPDATE_DEDUPE_TTL_MS);
  if (processedUpdates.size > UPDATE_DEDUPE_MAX) {
    const oldest = processedUpdates.keys().next().value;
    if (oldest !== undefined) processedUpdates.delete(oldest);
  }
  return false;
}
