/* PEP and adverse media, for a vendor later.

   This sits beside server/src/idv/provider.ts. Nothing in the desk calls
   a vendor through it. Tiers 1 and 2 record the client's own answer.
   There is no network call here. */

export type ScreeningSubject = {
  name: string;
  dateOfBirth?: string | null;
};

export type VendorScreen = {
  status: "clear" | "possible" | "unavailable";
};

export interface ScreeningProvider {
  readonly name: string;
  screenPep(subject: ScreeningSubject): Promise<VendorScreen>;
  screenAdverseMedia(subject: ScreeningSubject): Promise<VendorScreen>;
}
