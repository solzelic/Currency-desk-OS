import type { StaffUser } from "../domain/types";

export function SignInScreen({ staff, onSignIn }: { staff: StaffUser[]; onSignIn: (staffId: string) => void }) {
  return (
    <main className="auth-screen os-paper">
      <section className="auth-panel">
        <div className="auth-brand"><span className="os-brand-mark" aria-hidden="true"><i /></span><strong>CurrencyDesk</strong></div>
        <p className="auth-kicker">Secure desk workspace</p>
        <h1>Open your workspace</h1>
        <p className="muted">Select a demo staff account to continue.</p>
        <div className="staff-list">
          {staff.map((user) => (
            <button key={user.id} className="staff-button" onClick={() => onSignIn(user.id)} data-testid={`signin-${user.id}`}>
              <span className="staff-avatar">{user.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2)}</span>
              <span><b>{user.name}</b><small>{user.role.replace("_", " ")}</small></span>
              <i aria-hidden="true">→</i>
            </button>
          ))}
        </div>
        <p className="auth-note">Demo session. Do not use production customer or financial data.</p>
      </section>
    </main>
  );
}
