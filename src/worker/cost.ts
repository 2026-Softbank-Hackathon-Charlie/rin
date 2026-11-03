/**
 * The SDK's `total_cost_usd` covers the whole session: a resumed session starts from what its earlier turns spent.
 * Subtract the total the thread recorded after its last run to get this run's cost.
 * A total below that means the session started over, so the total is this run's cost.
 */
export function runCost(total: number | null, before: number): number | null {
  if (total == null) return null;
  return total >= before ? total - before : total;
}
