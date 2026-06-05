import { Guard } from "./Guard.js";

// ============================================================================
//  Escort — a guard that bodyguards a scout to clear a persistent harasser
//  blocking a valuable room (#147 escort half).
//
//  A dumb FOLLOW-role: it has no pathfinding/route of its own — each tick it just
//  travels to its assigned scout's live position. When a hostile is in the room it
//  switches to combat (reusing Guard.engage — the shared ranged-kite/clear nucleus).
//  ScoutOverlord (which owns both the "scout" and "escort" roles) spawns it, sized to
//  the blocker's threat, and links it via `memory.escortScout`.
//
//  Sync is free: the scout flees home (#148) when hit, which retreats it toward the
//  escort (the escort sits home-ward of it, following), so they meet, the escort kills
//  the harasser, and the scout re-enters. No border-wait handshake needed. If the scout
//  is gone (died / mission cleared and it was recycled), the escort recycles too.
// ============================================================================
export class Escort extends Guard {
  static run(creep, colony) {
    const scout = Game.creeps[creep.memory.escortScout];
    if (!scout) return this.recycleAtHome(creep, colony); // no scout to guard → go home

    // Combat takes priority over following: if there are hostiles wherever we are, fight
    // them (this is how the blocker actually gets cleared); otherwise tail the scout.
    if (this.engage(creep)) return;
    this.note(creep, "escort:follow");
    creep.travelTo(scout, { range: 1 });
  }
}
