/* Short printer copy for Settings. The steps stay on screen.
   Extra detail is behind More help. Do not claim every printer. */

export const PRINTER_STEPS = [
  "Choose Browser print, or pair a USB receipt printer.",
  "Install the printer on this computer.",
  "Press Test print and turn headers and footers off.",
  "Press Open cash drawer if a drawer is plugged into the printer.",
];

export const PRINTER_WORKS_WITH = [
  "Epson TM-T20III and TM-m30, by USB or the print dialog",
  "Star TSP100 in ESC/POS mode",
  "Print dialog, for a printer already installed on this computer",
  "AirPrint on iPhone and iPad",
];

export const PRINTER_UNSUPPORTED =
  "Direct classic Bluetooth and direct network port 9100 are not supported.";

export const PRINTER_DISCLAIMER =
  "Compatibility depends on the model, the driver, and the browser. Test it before a customer is here. A failed print never undoes a posted deal.";

export const PRINTER_MORE = [
  "The paired printer stays on this device. It is not copied to the other tills.",
  "Star TSP100 printers often ship in StarPRNT mode. Switch to ESC/POS in the printer memory or in Star Quick Setup. This desk sends ESC/POS, not StarPRNT.",
  "Set the paper under Receipts. In the print dialog, set margins to none. To keep a file, choose Save as PDF.",
  "Safari on iPhone and iPad cannot open USB or Bluetooth from this page. Use AirPrint on the same Wi-Fi.",
  "Chrome and Edge can use USB, a serial port at 9600 baud, or Bluetooth Low Energy.",
  "Classic Bluetooth (SPP) cannot be opened from this page. Pair that printer in the operating system and use the print dialog.",
  "The cash drawer plugs into the printer, not the computer.",
  "This desk does not send raw bytes to TCP 9100.",
  "If a direct print fails, the print dialog opens.",
];

export const PRINTER_GUIDE = {
  steps: PRINTER_STEPS,
  worksWith: PRINTER_WORKS_WITH,
  unsupported: PRINTER_UNSUPPORTED,
  disclaimer: PRINTER_DISCLAIMER,
  more: PRINTER_MORE,
};

export const PRINTER_HELP = [
  ...PRINTER_STEPS,
  "Works with",
  ...PRINTER_WORKS_WITH,
  PRINTER_UNSUPPORTED,
  PRINTER_DISCLAIMER,
  ...PRINTER_MORE,
].join("\n");
