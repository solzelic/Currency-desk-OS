/* Receipt drawing, browser print, and direct ESC/POS.
   The closing line is receiptClosing(), the same sentence ReceiptModal
   already used. A printer failure must not throw out to the deal. */
(function () {
  var CLOSING = "Thank you \u2014 keep for your records";
  var HEADING = "CurrencyDesk \u2014 Exchange Receipt";
  var PRINTER_KEY = "local_printer_v1";
  var FONT = '"IBM Plex Mono","Noto Sans","Noto Naskh Arabic","Noto Sans CJK JP","Noto Sans JP","Hiragino Sans","Yu Gothic","Segoe UI",sans-serif';

  var PRINTER_GUIDE = {
    steps: [
      "Choose Browser print, or pair a USB receipt printer.",
      "Install the printer on this computer.",
      "Press Test print and turn headers and footers off.",
      "Press Open cash drawer if a drawer is plugged into the printer.",
    ],
    worksWith: [
      "Epson TM-T20III and TM-m30, by USB or the print dialog",
      "Star TSP100 in ESC/POS mode",
      "Print dialog, for a printer already installed on this computer",
      "AirPrint on iPhone and iPad",
    ],
    unsupported: "Direct classic Bluetooth and direct network port 9100 are not supported.",
    disclaimer: "Compatibility depends on the model, the driver, and the browser. Test it before a customer is here. A failed print never undoes a posted deal.",
    more: [
      "The paired printer stays on this device. It is not copied to the other tills.",
      "Star TSP100 printers often ship in StarPRNT mode. Switch to ESC/POS in the printer memory or in Star Quick Setup. This desk sends ESC/POS, not StarPRNT.",
      "Set the paper under Receipts. In the print dialog, set margins to none. To keep a file, choose Save as PDF.",
      "Safari on iPhone and iPad cannot open USB or Bluetooth from this page. Use AirPrint on the same Wi-Fi.",
      "Chrome and Edge can use USB, a serial port at 9600 baud, or Bluetooth Low Energy.",
      "Classic Bluetooth (SPP) cannot be opened from this page. Pair that printer in the operating system and use the print dialog.",
      "The cash drawer plugs into the printer, not the computer.",
      "This desk does not send raw bytes to TCP 9100.",
      "If a direct print fails, the print dialog opens.",
    ],
  };
  var PRINTER_HELP = ["Works with"].concat(PRINTER_GUIDE.steps, PRINTER_GUIDE.worksWith, [PRINTER_GUIDE.unsupported, PRINTER_GUIDE.disclaimer], PRINTER_GUIDE.more).join("\n");

  function receiptClosing(settings) {
    var s = settings || {};
    return s.receiptFooter || CLOSING;
  }

  function receiptHeading(settings, shopName) {
    var s = settings || {};
    if (s.receiptHeader) return s.receiptHeader;
    if (shopName) return shopName;
    return HEADING;
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function present(value) {
    if (value == null) return null;
    var s = String(value).trim();
    return s ? s : null;
  }

  var PAGE = { "80mm": "80mm auto", "58mm": "58mm auto", a4: "A4", letter: "letter" };
  var SHEET = { "80mm": "72mm", "58mm": "50mm", a4: "180mm", letter: "180mm" };

  function renderReceiptFragment(model) {
    var m = model || {};
    var paper = PAGE[m.paper] ? m.paper : "80mm";
    var rows = "";
    function row(label, value) {
      if (!value) return;
      rows += "<tr><td>" + esc(label) + "</td><td>" + esc(value) + "</td></tr>";
    }
    row("Receipt", m.receiptNumber);
    row("Date", m.when);
    row("Client", m.clientName);
    row("Paid", m.paid);
    row("Rate", m.rate);
    row("Fee", m.fee);
    row("Received", m.received);
    var logo = m.showLogo && m.logo ? '<img class="logo" alt="" src="' + esc(m.logo) + '">' : "";
    var qr = m.qrDataUrl ? '<img class="qr" alt="" src="' + esc(m.qrDataUrl) + '">' : "";
    return '<style>'
      + ".cd-receipt{box-sizing:border-box;width:" + SHEET[paper] + ";max-width:100%;margin:0 auto;padding:8mm 5mm 10mm;background:#fff !important;color:#111 !important;font-family:" + FONT + "}"
      + ".cd-receipt h1{font-size:15px;margin:0 0 4px;text-align:center;color:#111 !important}"
      + ".cd-receipt .muted{font-size:12px;text-align:center;margin:0;color:#222 !important}"
      + ".cd-receipt table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}"
      + ".cd-receipt td{padding:3px 0;vertical-align:top;color:#111 !important} .cd-receipt td:last-child{text-align:right;font-weight:600}"
      + ".cd-receipt .rule{border-top:1px dashed #000;margin:10px 0}"
      + ".cd-receipt .closing{text-align:center;font-size:13px;margin:12px 0 0;color:#111 !important}"
      + ".cd-receipt .fine{text-align:center;font-size:11px;margin:8px 0 0;color:#222}"
      + ".cd-receipt .sample{text-align:center;font-size:10px;letter-spacing:.12em;margin:0 0 6px}"
      + ".cd-receipt img.logo{display:block;max-height:42px;margin:0 auto 8px}"
      + ".cd-receipt img.qr{display:block;width:96px;height:96px;margin:10px auto 0}"
      + "</style>"
      + '<article class="cd-receipt" data-receipt-paper="' + paper + '">'
      + (m.sample ? '<p class="sample">SAMPLE. NOT A POSTED DEAL.</p>' : "")
      + logo
      + "<h1>" + esc(m.heading || "") + "</h1>"
      + (m.address ? '<p class="muted">' + esc(m.address) + "</p>" : "")
      + (m.phone ? '<p class="muted">' + esc(m.phone) + "</p>" : "")
      + (m.licence ? '<p class="muted">' + esc(m.licence) + "</p>" : "")
      + '<p class="muted">' + esc(m.cdIdLine || "No CurrencyDesk ID issued yet") + "</p>"
      + '<div class="rule"></div><table>' + rows + "</table>"
      + '<div class="rule"></div>'
      + '<p class="closing" data-receipt-closing="1">' + esc(m.closing || CLOSING) + "</p>"
      + (m.disclaimer ? '<p class="fine">' + esc(m.disclaimer) + "</p>" : "")
      + qr
      + (m.rateUrl ? '<p class="fine">' + esc(m.rateUrl) + "</p>" : "")
      + "</article>";
  }

  function renderReceiptHtml(model, opts) {
    var m = model || {};
    var paper = PAGE[m.paper] ? m.paper : "80mm";
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt ' + esc(m.receiptNumber || "") + '</title>'
      + '<link rel="stylesheet" href="/web/fonts/fonts.css">'
      + "<style>@page{size:" + PAGE[paper] + ";margin:0} html,body{margin:0;padding:0;background:#fff;color:#000}</style></head><body>"
      + renderReceiptFragment(model)
      + (opts && opts.autoprint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},40)})</script>' : "")
      + "</body></html>";
  }

  function loadPrinter() {
    try {
      var raw = localStorage.getItem(PRINTER_KEY);
      return raw ? JSON.parse(raw) : { connection: "browser", autoDrawer: false, baud: 9600 };
    } catch (e) {
      return { connection: "browser", autoDrawer: false, baud: 9600 };
    }
  }

  function savePrinter(next) {
    var cur = loadPrinter();
    var merged = Object.assign({}, cur, next || {});
    try { localStorage.setItem(PRINTER_KEY, JSON.stringify(merged)); } catch (e) {}
    return merged;
  }

  function rasterizeLine(text) {
    if (typeof document === "undefined") return null;
    var canvas = document.createElement("canvas");
    var ctx = canvas.getContext("2d");
    if (!ctx) return null;
    var font = "22px " + FONT;
    ctx.font = font;
    var width = Math.max(8, Math.ceil(ctx.measureText(String(text)).width) + 8);
    var height = 32;
    canvas.width = width;
    canvas.height = height;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#000";
    ctx.font = font;
    ctx.textBaseline = "top";
    ctx.fillText(String(text), 4, 4);
    var img = ctx.getImageData(0, 0, width, height);
    var widthBytes = Math.ceil(width / 8);
    var data = new Uint8Array(widthBytes * height);
    var y, x;
    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++) {
        var i = (y * width + x) * 4;
        var dark = img.data[i] < 160;
        if (dark) data[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return { widthBytes: widthBytes, height: height, data: data };
  }

  function linesOf(model) {
    var m = model || {};
    var lines = [];
    function add(value) { if (value) lines.push(String(value)); }
    add(m.heading);
    add(m.address);
    add(m.phone);
    add(m.licence);
    add(m.cdIdLine);
    add(m.receiptNumber ? "Receipt " + m.receiptNumber : "");
    add(m.when);
    add(m.clientName ? "Client " + m.clientName : "");
    add(m.paid ? "Paid " + m.paid : "");
    add(m.rate ? "Rate " + m.rate : "");
    add(m.fee ? "Fee " + m.fee : "");
    add(m.received ? "Received " + m.received : "");
    add(m.closing);
    return lines;
  }

  var USB_FILTERS = [
    { vendorId: 0x04b8 },
    { vendorId: 0x0519 },
    { vendorId: 0x1504 },
    { classCode: 0x07 },
  ];
  var BLE = [
    "000018f0-0000-1000-8000-00805f9b34fb",
    "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
    "49535343-fe7d-4ae5-8fa9-9fafd205e455",
  ];

  function directAvailable() {
    var nav = typeof navigator !== "undefined" ? navigator : {};
    return {
      usb: !!nav.usb,
      serial: !!nav.serial,
      bluetooth: !!nav.bluetooth,
    };
  }

  async function writeUsb(pref, data) {
    var list = await navigator.usb.getDevices();
    var device = null;
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].vendorId === pref.vendorId && list[i].productId === pref.productId) device = list[i];
    }
    if (!device) device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
    await device.open();
    if (device.configuration == null) await device.selectConfiguration(1);
    var iface = device.configuration.interfaces[0];
    await device.claimInterface(iface.interfaceNumber);
    var alt = iface.alternate || iface.alternates[0];
    var ep = null;
    var endpoints = alt.endpoints || [];
    for (i = 0; i < endpoints.length; i++) if (endpoints[i].direction === "out") ep = endpoints[i];
    if (!ep) throw new Error("This printer has no output endpoint.");
    await device.transferOut(ep.endpointNumber, data);
    savePrinter({
      connection: "usb",
      label: device.productName || "USB printer",
      vendorId: device.vendorId,
      productId: device.productId,
    });
  }

  async function writeSerial(pref, data) {
    var ports = await navigator.serial.getPorts();
    var port = ports[0];
    if (!port) port = await navigator.serial.requestPort();
    if (!port.readable && !port.writable) await port.open({ baudRate: pref.baud || 9600 });
    var writer = port.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();
    savePrinter({ connection: "serial", label: "Serial printer", baud: pref.baud || 9600 });
  }

  async function writeBle(pref, data) {
    var device = pref._device;
    if (!device) {
      device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE });
    }
    var server = await device.gatt.connect();
    var service = null;
    var i;
    for (i = 0; i < BLE.length; i++) {
      try { service = await server.getPrimaryService(BLE[i]); break; } catch (e) {}
    }
    if (!service) throw new Error("This Bluetooth printer did not offer a known print service. Classic Bluetooth (SPP) cannot be opened from a page.");
    var chars = await service.getCharacteristics();
    var ch = null;
    for (i = 0; i < chars.length; i++) {
      if (chars[i].properties.write || chars[i].properties.writeWithoutResponse) ch = chars[i];
    }
    if (!ch) throw new Error("This Bluetooth printer has nowhere to write.");
    var size = 20;
    for (i = 0; i < data.length; i += size) {
      await ch.writeValue(data.slice(i, i + size));
    }
    savePrinter({ connection: "bluetooth", label: device.name || "Bluetooth printer" });
    var stored = loadPrinter();
    stored._device = device;
    return stored;
  }

  async function sendDirect(pref, data) {
    if (!pref || pref.connection === "browser") throw new Error("browser");
    if (pref.connection === "usb") return writeUsb(pref, data);
    if (pref.connection === "serial") return writeSerial(pref, data);
    if (pref.connection === "bluetooth") return writeBle(pref, data);
    throw new Error("browser");
  }

  function openBrowserPrint(model) {
    var html = renderReceiptHtml(model, { autoprint: true });
    var w = window.open("", "cdos-receipt-print", "noopener,width=480,height=720");
    if (!w) {
      window.print();
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  async function printModel(model) {
    var pref = loadPrinter();
    var thermal = model.paper === "58mm" || model.paper === "80mm" || !model.paper;
    if (pref && pref.connection && pref.connection !== "browser" && thermal && window.CDOS.escpos) {
      try {
        var bytes = window.CDOS.escpos.encodeReceipt({
          lines: linesOf(model),
          qrUrl: model.rateUrl || null,
          drawer: !!pref.autoDrawer,
          cut: true,
        }, { rasterize: rasterizeLine });
        await sendDirect(pref, bytes);
        return { via: pref.connection };
      } catch (e) {
        openBrowserPrint(model);
        return { via: "browser", fallback: true };
      }
    }
    openBrowserPrint(model);
    return { via: "browser" };
  }

  async function pulseDrawer() {
    var pref = loadPrinter();
    if (!window.CDOS.escpos) return { ok: false, message: "Direct printing is not loaded." };
    if (!pref || !pref.connection || pref.connection === "browser") {
      return { ok: false, message: "Pair a receipt printer first. The drawer plugs into the printer, not the computer." };
    }
    try {
      await sendDirect(pref, window.CDOS.escpos.drawerPulse());
      return { ok: true, message: "Drawer pulse sent." };
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : "The drawer did not open. The deal is unchanged." };
    }
  }

  function amountText(value) {
    if (value == null || value === "") return null;
    return String(value);
  }

  function modelFromRow(row, settings, desk) {
    var r = row || {};
    var s = settings || {};
    var d = desk || {};
    var idn = d.identity || {};
    var opt = d.options || {};
    var sr = r.serverReceipt || {};
    var la = r.ledgerAmounts || {};
    function pick(server, ledger, local) {
      var a = present(server);
      if (a) return a;
      var b = present(ledger);
      if (b) return b;
      return present(local);
    }
    var showRate = opt.showRate !== false && s.showRate !== false;
    var showFees = opt.showFees !== false && s.showFees !== false;
    var showClient = opt.showClientName !== false && s.showClientName !== false;
    var footer = opt.footer || s.receiptFooter || "";
    var header = opt.header || s.receiptHeader || "";
    var paper = opt.paper || s.receiptPaper || "80mm";
    var paid = pick(sr.inputAmount, la.inputAmount, r.inAmt);
    var got = pick(sr.outputAmount, la.outputAmount, r.outAmt);
    var from = pick(sr.fromCurrency, la.from, r.inCcy);
    var to = pick(sr.toCurrency, la.to, r.outCcy);
    var fee = pick(sr.feeCad, la.feeCad, r.fee);
    var rate = pick(sr.rate, la.rate, r.rate);
    return {
      sample: !!r.sample,
      paper: paper,
      heading: receiptHeading({ receiptHeader: header }, idn.shopName || s.operatingName || s.bizName),
      address: idn.address || [s.bizAddress, s.bizCity].filter(Boolean).join(", ") || null,
      phone: idn.phone || s.bizPhone || null,
      licence: (opt.showMsb !== false && s.showMsbOnReceipt !== false) ? (idn.licence || s.msbNumber || null) : null,
      cdIdLine: idn.cdId || "No CurrencyDesk ID issued yet",
      showLogo: opt.showLogo !== false && s.showLogoOnReceipt !== false,
      logo: opt.logo || s.logo || null,
      receiptNumber: pick(sr.transactionRef, null, r.ref),
      when: sr.postedAtLocal || r.date || null,
      clientName: showClient ? (sr.customerName || r.customer || null) : null,
      paid: paid && from ? paid + " " + from : null,
      received: got && to ? got + " " + to : null,
      rate: showRate ? amountText(rate) : null,
      fee: showFees ? amountText(fee) : null,
      closing: receiptClosing({ receiptFooter: footer }),
      disclaimer: opt.disclaimer || s.receiptDisclaimer || null,
      qrDataUrl: (opt.showQr !== false) ? (d.qrDataUrl || null) : null,
      rateUrl: (opt.showQr !== false) ? (idn.rateUrl || null) : null,
    };
  }

  function afterDealPosted(row, settings) {
    try {
      if (window.CDOS.openDealReceipt) window.CDOS.openDealReceipt(row || {});
      var opt = (settings && settings.receiptDesk && settings.receiptDesk.options) || {};
      var auto = !!(settings && settings.autoPrint) || opt.autoPrint === true;
      if (auto) {
        setTimeout(function () {
          try { printModel(modelFromRow(row, settings, settings && settings.receiptDesk)); }
          catch (e) { try { window.print(); } catch (e2) {} }
        }, 60);
      }
    } catch (e) {}
  }

  window.CDOS = Object.assign(window.CDOS || {}, {
    receiptClosing: receiptClosing,
    receiptHeading: receiptHeading,
    PRINTER_HELP: PRINTER_HELP,
    printerGuide: PRINTER_GUIDE,
    renderReceiptHtml: renderReceiptHtml,
    renderReceiptFragment: renderReceiptFragment,
    loadPrinter: loadPrinter,
    savePrinter: savePrinter,
    directAvailable: directAvailable,
    printModel: printModel,
    pulseDrawer: pulseDrawer,
    modelFromRow: modelFromRow,
    afterDealPosted: afterDealPosted,
    rasterizeLine: rasterizeLine,
  });
})();
