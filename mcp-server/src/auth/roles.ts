import type { Role } from "@mytime/shared";

// Role hierarchy for per-tool enforcement (Phase 5). admin ⊇ analyst ⊇ viewer.
const RANK: Record<Role, number> = { viewer: 0, analyst: 1, admin: 2 };

/** Whether `userRole` satisfies a tool's `requiredRole`. */
export function roleSatisfies(userRole: Role, requiredRole: Role): boolean {
  return RANK[userRole] >= RANK[requiredRole];
}
