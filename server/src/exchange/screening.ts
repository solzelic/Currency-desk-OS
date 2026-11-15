/* Sanctions screening is CD-217. This draft does not run a name check
   and does not hold cash for one. */
export type ScreeningStatus = {
  state: "not_connected";
  blocksHandover: false;
};

export async function screeningStatus(): Promise<ScreeningStatus> {
  return { state: "not_connected", blocksHandover: false };
}
