/* What a log may say about a failed operation.

   A database error carries its SQL and every bound value in its message,
   its stack, its enumerable `params` and its cause's `detail`: an owner's
   email, a password or PIN hash, a full CurrencyDesk ID. None of that may
   reach a log (standards §6, sign-up build doc §9.8). So a log names the
   error's class and, for a database failure, the Postgres SQLSTATE, and
   takes nothing else from the error. */
import { DrizzleQueryError } from "drizzle-orm";

/** A failed Drizzle query: its message and params hold the bound values. */
export const isDatabaseError = (err: unknown): err is DrizzleQueryError => err instanceof DrizzleQueryError;

// node-postgres and PGlite both put the five-character SQLSTATE on `code`.
const sqlStateOf = (value: unknown): string | undefined => {
  const code = typeof value === "object" && value !== null ? (value as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
};

/** The bounded, loggable reason for an error: its class name and SQLSTATE. */
export function errorReason(err: unknown): { name: string; sqlState?: string } {
  // DrizzleQueryError leaves `name` as "Error", so the class says more.
  const type = err instanceof Error ? err.constructor.name : "";
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(type) ? type : "Error";
  const sqlState = err instanceof Error ? sqlStateOf(err.cause) ?? sqlStateOf(err) : undefined;
  return sqlState ? { name, sqlState } : { name };
}
