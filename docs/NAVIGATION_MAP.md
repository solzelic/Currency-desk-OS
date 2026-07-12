# Navigation Map

## Prototype navigation

```text
Top menu / tenant strip / dock
  -> Rate Board
  -> Ledger -> new transaction -> receipt, customer profile, compliance, till, cheques
  -> Transfers
  -> Cheques
  -> Clients and KYC -> customer ledger
  -> Compliance -> transaction, customer, ledger references, transfers, settings
  -> Dashboard -> ledger, customer, any application
  -> Till Drawer -> day close, reports
  -> Cash on Hand / Vault
  -> Branch Network -> Till Drawer
  -> Audit Trail
  -> Calculator / Loan Centre / AI Assistant / Tagged
  -> Reports / Pricing and Rates / Settings / Store
```

The legacy `cdos-os.jsx` window manager owns focus, close, minimize, zoom, resize, duplicate, and desktop tiling. These behaviors are the visual-shell interaction reference.

## React visual shell navigation

```text
Root URL (/)
  -> lock/sign-in screen
  -> CurrencyDesk desktop
       -> Exchange Desk (opens by default)
            -> Customer panel
            -> Quote and compliance
            -> Post transaction
                 -> Receipt window
                 -> Ledger window
                 -> Till window
       -> Ledger (dock)
       -> Till Drawer (dock)
       -> Compliance (dock; current checklist view)
       -> Clients (dock; current customer view)
       -> Other prototype applications (dock; migration marker)
```

Windows can be focused, minimized, closed, and reopened from the dock. Closing a window does not mutate domain records. Posting opens and focuses the receipt while retaining the shared state used by Ledger and Till.
