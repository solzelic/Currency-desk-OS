/* A one-page PDF of the receipt text.
   Money figures are ASCII. The em dash in the existing closing line is
   WinAnsi 0x97, so that sentence survives. Characters a simple PDF font
   cannot draw are left out of the page; the HTML email still has them. */
const WIN: Record<number, number> = {
  0x2014: 0x97,
  0x2013: 0x96,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x20ac: 0x80,
};

function winAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a) { out += "\n"; continue; }
    if (code >= 32 && code <= 126) { out += ch; continue; }
    const mapped = WIN[code];
    if (mapped != null) out += String.fromCharCode(mapped);
  }
  return out;
}

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function receiptPdf(text: string): Buffer {
  const lines = winAnsi(text).split("\n").slice(0, 48);
  const commands = ["BT", "/F1 11 Tf", "40 780 Td", "14 TL"];
  for (const line of lines) {
    commands.push(`(${pdfEscape(line)}) Tj`, "T*");
  }
  commands.push("ET");
  const stream = commands.join("\n");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
  ];
  let body = "%PDF-1.4\n";
  const xref: number[] = [0];
  for (const obj of objects) {
    xref.push(body.length);
    body += obj;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${xref.length}\n`;
  body += "0000000000 65535 f \n";
  for (const offset of xref.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer << /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(body, "latin1");
}
