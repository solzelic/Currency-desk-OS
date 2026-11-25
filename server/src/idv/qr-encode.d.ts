declare module "./qr-encode.mjs" {
  export function encode(data: string, options?: { ecc?: "L" | "M" | "Q" | "H"; border?: number }): {
    size: number;
    data: boolean[][];
  };
}
