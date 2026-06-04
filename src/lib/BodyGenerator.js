// ============================================================================
//  BodyGenerator — build creep body arrays that fit the available energy.
//  template : minimum viable body (always included if affordable)
//  extra    : repeating unit appended while energy + part-limit allow
//  max      : cap on how many times `extra` repeats
//  energy   : energy budget (usually room.energyCapacityAvailable)
// ============================================================================
export function bodyFromTemplate(template, { extra = [], max = 0, energy } = {}) {
  const cost = (parts) => parts.reduce((s, p) => s + BODYPART_COST[p], 0);

  let body = [...template];
  let budget = energy - cost(body);

  // If we can't even afford the template, fall back to the cheapest worker.
  if (budget < 0) return [WORK, CARRY, MOVE];

  const unitCost = cost(extra);
  let added = 0;
  while (extra.length && added < max && budget >= unitCost && body.length + extra.length <= 50) {
    body.push(...extra);
    budget -= unitCost;
    added++;
  }

  // Screeps spawns parts in array order; MOVE parts mixed in is fine for early game.
  return body;
}

// Energy cost of a body array — the price the spawn pays for it. Shared so callers
// reason about affordability without re-summing BODYPART_COST by hand.
export function bodyCost(body) {
  return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}
