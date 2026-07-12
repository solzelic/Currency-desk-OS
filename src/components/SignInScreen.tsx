import type { StaffUser } from "../domain/types";

export function SignInScreen({ staff, onSignIn }: { staff: StaffUser[]; onSignIn: (staffId: string) => void }) {
  return (
    <main className="auth-screen">
      <section className="auth-panel">
        <p className="eyebrow">CurrencyDesk OS</p>
        <h1>Desk workspace</h1>
        <p className="muted">Choose a staff account to enter the TypeScript frontend foundation.</p>
        <div className="staff-list">
          {staff.map((user) => (
            <button key={user.id} className="staff-button" onClick={() => onSignIn(user.id)} data-testid={`signin-${user.id}`}>
              <span>{user.name}</span>
              <small>{user.role}</small>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
