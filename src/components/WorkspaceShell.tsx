import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { money } from "../domain/rates";
import type { StaffUser, TillPosition, Workspace } from "../domain/types";

export type DeskAppId = "exchange" | "clients" | "compliance" | "ledger" | "receipt" | "till";

export interface DeskApplication {
  id: DeskAppId;
  title: string;
  detail: string;
  icon: string;
  accent: string;
  content: ReactNode;
}

interface DesktopWindow {
  id: DeskAppId;
  minimized: boolean;
  z: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const initialBoxes: Record<DeskAppId, Omit<DesktopWindow, "id" | "minimized" | "z">> = {
  exchange: { x: 28, y: 28, width: 850, height: 680 },
  clients: { x: 72, y: 74, width: 470, height: 640 },
  compliance: { x: 118, y: 118, width: 480, height: 530 },
  ledger: { x: 98, y: 374, width: 710, height: 350 },
  receipt: { x: 900, y: 44, width: 390, height: 465 },
  till: { x: 850, y: 515, width: 390, height: 265 }
};

function makeWindow(id: DeskAppId, z: number): DesktopWindow {
  return { id, minimized: false, z, ...initialBoxes[id] };
}

export function WorkspaceShell({
  activeUser,
  workspace,
  ledgerCount,
  receiptCount,
  till,
  applications,
  postVersion,
  onSignOut
}: {
  activeUser: StaffUser;
  workspace: Workspace;
  ledgerCount: number;
  receiptCount: number;
  till: TillPosition;
  applications: DeskApplication[];
  postVersion: number;
  onSignOut: () => void;
}) {
  const topZ = useRef(3);
  const processedPost = useRef(0);
  const [windows, setWindows] = useState<DesktopWindow[]>(() => [
    makeWindow("exchange", 3),
    { ...makeWindow("ledger", 1), minimized: true },
    { ...makeWindow("receipt", 1), minimized: true },
    { ...makeWindow("till", 1), minimized: true }
  ]);
  const [activeId, setActiveId] = useState<DeskAppId>("exchange");

  const applicationById = new Map(applications.map((app) => [app.id, app]));

  function focusApp(id: DeskAppId) {
    setWindows((current) => {
      const nextZ = ++topZ.current;
      const existing = current.find((window) => window.id === id);
      if (existing) {
        return current.map((window) => (window.id === id ? { ...window, minimized: false, z: nextZ } : window));
      }
      return [...current, makeWindow(id, nextZ)];
    });
    setActiveId(id);
  }

  function closeApp(id: DeskAppId) {
    setWindows((current) => current.filter((window) => window.id !== id));
    if (activeId === id) setActiveId("exchange");
  }

  function minimizeApp(id: DeskAppId) {
    setWindows((current) => current.map((window) => (window.id === id ? { ...window, minimized: true } : window)));
  }

  function moveWindow(id: DeskAppId, event: React.PointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    const current = windows.find((window) => window.id === id);
    if (!current) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = current.x;
    const originY = current.y;

    function move(pointerEvent: PointerEvent) {
      setWindows((items) => items.map((item) => (
        item.id === id
          ? { ...item, x: Math.max(8, originX + pointerEvent.clientX - startX), y: Math.max(8, originY + pointerEvent.clientY - startY) }
          : item
      )));
    }

    function stop() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  useEffect(() => {
    if (!postVersion || processedPost.current === postVersion) return;
    processedPost.current = postVersion;
    focusApp("ledger");
    focusApp("till");
    focusApp("receipt");
  }, [postVersion]);

  return (
    <main className="os-workspace">
      <header className="os-menubar">
        <div className="os-brand" aria-label="CurrencyDesk OS">
          <span className="os-brand-mark" aria-hidden="true"><i /></span>
          <strong>CurrencyDesk</strong>
          <span>OS</span>
        </div>
        <span className="os-menu-separator" />
        <span className="os-active-app">{applicationById.get(activeId)?.title ?? "Desktop"}</span>
        <div className="os-menubar-right">
          <span className="os-live-status"><i /> Desk online</span>
          <span className="os-time">{workspace.businessDate}</span>
          <div className="os-account"><b>{activeUser.name}</b><span>{activeUser.role.replace("_", " ")}</span></div>
          <button className="os-icon-button os-power" onClick={onSignOut} aria-label="Sign out" title="Sign out" />
        </div>
      </header>

      <section className="os-tenantbar" aria-label="Workspace context">
        <div className="os-tenant-ident">
          <span className="os-building" aria-hidden="true" />
          <div>
            <span className="os-tenant-label">Your logo</span>
            <h1>{workspace.branchName}</h1>
          </div>
          <span className="os-station">{workspace.tillId} · Open</span>
        </div>
        <div className="os-rate-ticker" aria-label="Desk rates">
          <span>USD <b>0.7244</b></span>
          <span>EUR <b>0.6778</b></span>
          <span>GBP <b>0.5751</b></span>
          <span className="ticker-positive">Rates live</span>
        </div>
      </section>

      <nav className="os-appbar" aria-label="CurrencyDesk applications">
        {applications.map((application) => {
          const window = windows.find((item) => item.id === application.id);
          const active = activeId === application.id && !window?.minimized;
          return (
            <button
              key={application.id}
              className={`os-app-button${active ? " is-active" : ""}${window ? " is-open" : ""}${window?.minimized ? " is-minimized" : ""}`}
              style={{ "--app-accent": application.accent } as CSSProperties}
              onClick={() => focusApp(application.id)}
              data-testid={`open-${application.id}`}
            >
              <img src={application.icon} alt="" />
              <span>{application.title}</span>
            </button>
          );
        })}
        <div className="os-appbar-stats">
          <span>{ledgerCount} ledger</span>
          <span>{receiptCount} receipts</span>
          <span>{money(till.CAD || 0)}</span>
        </div>
      </nav>

      <section className="os-desktop" aria-label="CurrencyDesk desktop">
        <div className="os-watermark"><b>CD·OS</b><span>the operating system for exchange houses</span></div>
        {windows.map((window) => {
          const application = applicationById.get(window.id);
          if (!application) return null;
          return (
            <article
              key={window.id}
              className={`os-window${activeId === window.id ? " is-active" : ""}${window.minimized ? " is-minimized" : ""}`}
              style={{ left: window.x, top: window.y, width: window.width, height: window.height, zIndex: window.z } as CSSProperties}
              onMouseDown={() => focusApp(window.id)}
            >
              <div className="os-window-bar" onPointerDown={(event) => moveWindow(window.id, event)}>
                <div className="os-window-controls">
                  <button className="window-control close" onClick={() => closeApp(window.id)} aria-label={`Close ${application.title}`} title="Close" />
                  <button className="window-control minimize" onClick={() => minimizeApp(window.id)} aria-label={`Minimize ${application.title}`} title="Minimize" />
                  <button className="window-control zoom" onClick={() => focusApp(window.id)} aria-label={`Focus ${application.title}`} title="Focus" />
                </div>
                <div className="os-window-title"><img src={application.icon} alt="" /> <b>{application.title}</b><span>{application.detail}</span></div>
                <span className="os-window-grip" aria-hidden="true">···</span>
              </div>
              <div className="os-window-body">{application.content}</div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
