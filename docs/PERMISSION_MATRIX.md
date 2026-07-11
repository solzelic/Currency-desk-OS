# Permission Matrix

The React authorization layer checks both the named permission and tenant/legal-entity/branch scope. A listed permission is never a substitute for policy, approval, segregation of duties, or backend enforcement.

| Role | Post transaction | Override warning | Reverse transaction | View sensitive customer data | Export records | Change rates |
| --- | --- | --- | --- | --- | --- |
| Teller | Yes | No | No | Yes | No | No |
| Supervisor | Yes | Yes | Yes | Yes | No | Yes |
| Compliance officer | No | Yes | No | Yes | Yes | No |
| Branch manager | Yes | Yes | Yes | Yes | Yes | Yes |
| Administrator | Yes | Yes | Yes | Yes | Yes | Yes |
| Auditor | No | No | No | Yes | Yes | No |

## Enforcement points

- `src/security/authorization.ts` owns role-to-permission mapping and scope-aware authorization.
- `src/domain/posting.ts` requires an actor and checks `transaction:post` at the posting boundary.
- `src/state/useDeskStore.ts` records successful and failed sensitive actions in the audit stream.
- Future backend adapters must re-enforce the same permissions server-side; frontend checks are not sufficient for production security.

## Prototype mapping

The prototype exposes Owner, Teller, and related settings controls for visual demonstration. The React role model is more explicit and should govern new migration work. Prototype role labels are not evidence of an implemented production authorization model.
