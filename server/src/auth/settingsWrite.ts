/* Who may write a desk setting.
   This table is today's default. The owner will be able to change it.
   There is no screen for that yet, and nothing is stored.
   The owner is always allowed, so a saved row can never lock them out. */
export const CHEQUE_FEE_SCHEDULE_KEY = "cdos_cheque_schedule_v1";

/* Owner and a manager. A compliance officer is a manager on this desk,
   the same label the screen already uses. Everyone else is refused. */
const DEFAULT_WRITERS: Readonly<Record<string, readonly string[]>> = {
  [CHEQUE_FEE_SCHEDULE_KEY]: ["branch_manager", "compliance_officer"],
};

export function canWriteSetting(role: string, key: string): boolean {
  if (role === "administrator") return true;
  const allowed = DEFAULT_WRITERS[key];
  return !!allowed && allowed.includes(role);
}
