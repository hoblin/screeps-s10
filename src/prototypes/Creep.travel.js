// ============================================================================
//  Creep.travelTo — thin wrapper over moveTo with sane defaults.
//  This is a placeholder for a future custom pathing/Traveler integration.
//  For now it standardizes options (reusePath, visualization) so call sites
//  across roles stay DRY. Swap the body later without touching the roles.
// ============================================================================
Creep.prototype.travelTo = function (target, opts = {}) {
  return this.moveTo(target, {
    reusePath: 20,
    visualizePathStyle: { stroke: "#ffaa00", opacity: 0.3 },
    ...opts,
  });
};
