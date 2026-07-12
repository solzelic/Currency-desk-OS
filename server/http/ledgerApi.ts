import type { AuthenticatedLedgerActor, PostExchangeRequest, ReverseTransactionRequest } from "../ledger/contracts";
import { LedgerApiError } from "../ledger/errors";
import { LedgerPostingService } from "../ledger/service";

export type AuthenticateRequest = (request: Request) => Promise<AuthenticatedLedgerActor | null>;

export class LedgerApi {
  constructor(private readonly service: LedgerPostingService, private readonly authenticate: AuthenticateRequest) {}

  async postExchange(request: Request): Promise<Response> {
    return this.handle(request, (actor, body) => this.service.post(actor, body as PostExchangeRequest));
  }

  async reverseTransaction(request: Request, transactionId: string): Promise<Response> {
    return this.handle(request, (actor, body) => this.service.reverse(actor, transactionId, body as ReverseTransactionRequest));
  }

  private async handle(request: Request, action: (actor: AuthenticatedLedgerActor, body: unknown) => Promise<unknown>): Promise<Response> {
    try {
      const actor = await this.authenticate(request);
      if (!actor) throw new LedgerApiError("AUTHENTICATION_REQUIRED", "An authenticated server session is required.");
      const body = await request.json();
      const result = await action(actor, body);
      return Response.json(result, { status: 201 });
    } catch (error) {
      if (error instanceof LedgerApiError) {
        const status = error.code === "AUTHENTICATION_REQUIRED" ? 401 : error.code === "AUTHORIZATION_DENIED" || error.code === "SCOPE_DENIED" ? 403 : error.code === "IDEMPOTENCY_IN_PROGRESS" ? 409 : 422;
        return Response.json({ code: error.code, message: error.message }, { status });
      }
      return Response.json({ code: "INTERNAL_ERROR", message: "Unexpected server error." }, { status: 500 });
    }
  }
}
