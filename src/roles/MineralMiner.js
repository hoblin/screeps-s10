import { Miner } from "./Miner.js";

// ============================================================================
//  MineralMiner — a static miner for the room's MINERAL (#19, Stage 4).
//
//  Mechanically a Miner: it parks on the container tile beside the mineral and harvests forever, its
//  yield dropping into the container below for a MineralHauler to drain (the same drop-mining setup as
//  source mining). The ONE difference is the harvest target — it digs the mineral, not a source — so it
//  only overrides `harvestTargetId`. `creep.harvest()` is the same call for a Mineral (the room just
//  needs a built Extractor on it, which MineralMiningOverlord places).
//
//  No empty-state handling here: a depleted mineral (mineralAmount === 0) just makes `harvest` a no-op
//  for the ~regen window — harmless. The overlord requests 0 miners while the mineral is empty, so a
//  dying miner isn't replaced until it regenerates (no churn). Body/movement/park logic inherit from Miner.
// ============================================================================
export class MineralMiner extends Miner {
  static harvestTargetId(creep) {
    return creep.memory.mineralId;
  }
}
