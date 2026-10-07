/* Plain steps for a printer. No drivers ship with the desk.
   Browser print stays the default. Direct ESC/POS is an extra path. */
export const PRINTER_HELP = [
  "Browser print is the default. It works with any printer the computer already has, including a receipt printer installed as a normal printer.",
  "USB or network receipt printer (Epson TM-T20, TM-m30, Star TSP100):",
  "1. Install the printer with the maker's driver so it shows up as a printer on this computer.",
  "2. Set the paper to 80mm (or 58mm if that is the roll in the printer).",
  "3. In the print dialog, turn headers and footers off, and set margins to none.",
  "4. Star printers must be set to ESC/POS mode. Many Star printers, including the TSP100, ship in StarPRNT mode. Change that in the printer's memory switch or in Star Quick Setup. This desk sends ESC/POS, not StarPRNT.",
  "Office printer:",
  "1. Choose A4 or Letter under Receipts.",
  "2. Print from the dialog. To keep a file, choose Save as PDF in that same dialog.",
  "iPhone or iPad:",
  "Safari cannot open a USB or Bluetooth printer from a web page. Use AirPrint. Put the printer and the iPad on the same Wi-Fi, then tap Print and pick the printer.",
  "Direct printing (Chrome or Edge on a computer):",
  "1. Under Printer setup, choose USB, serial, or Bluetooth.",
  "2. Pair the printer and print a test.",
  "3. Epson, Bixolon, and other ESC/POS printers can use USB. The browser asks you to pick the device.",
  "4. A serial cable uses the serial port, usually at 9600 baud.",
  "5. Bluetooth here is Bluetooth Low Energy. Many receipt printers use classic Bluetooth (SPP), which a web page cannot open. Pair those in the operating system and print with the browser dialog, or use a serial port if the printer offers one.",
  "6. The cash drawer plugs into the printer's DK port, not into the computer. Open cash drawer sends the ESC/POS pulse. Test it before a customer is at the counter.",
  "This desk does not send raw bytes to a network port (TCP 9100). A page that could send bytes to any address could reach devices it should not. A print agent for port 9100 is not part of this desk.",
  "If a direct print fails, the ordinary print dialog opens. The deal is already posted. A printer problem never undoes it.",
].join("\n");
