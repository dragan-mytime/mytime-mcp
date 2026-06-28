import type { Pool, Role } from "@mytime/shared";

export interface AuthorizedUser {
  role: Role;
  active: boolean;
}

/**
 * Layer 2 lookup: the email must have an active row in `authorized_users`
 * (managed in the Supabase table editor). Returns null if absent.
 */
export async function lookupAuthorizedUser(
  pool: Pool,
  email: string,
): Promise<AuthorizedUser | null> {
  const { rows } = await pool.query<{ role: Role; active: boolean }>(
    "SELECT role, active FROM authorized_users WHERE lower(email) = lower($1)",
    [email],
  );
  const row = rows[0];
  return row ? { role: row.role, active: row.active } : null;
}

/** List the allowlist (admin tool). Management itself is done in Supabase. */
export async function listAuthorizedUsers(pool: Pool): Promise<unknown> {
  const { rows } = await pool.query(
    "SELECT email, role, active, name, created_at FROM authorized_users ORDER BY email",
  );
  return { users: rows, note: "Manage entries in the Supabase table editor (authorized_users)." };
}
