/* A download the owner can open in a spreadsheet.
   Cells are text. A money column is checked with decimal.js and then
   written as the database stored it, so a float never rounds it. */
import Decimal from "decimal.js";

export function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function csvDocument(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/* Reject a value that is not a number. Return the stored text, not a
   new rounding of it. An empty cell stays empty. It is never zero. */
export function storedDecimal(value: unknown): string {
  if (value == null || value === "") return "";
  const text = String(value).trim();
  let decimal: Decimal;
  try {
    decimal = new Decimal(text);
  } catch {
    throw new Error("A money column was not a number.");
  }
  if (!decimal.isFinite()) throw new Error("A money column was not a number.");
  return text;
}
