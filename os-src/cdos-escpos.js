/* ESC/POS bytes for a receipt printer.
   Text, a logo raster, a QR command, a cut, and a cash-drawer pulse.
   Lines the printer's code page cannot draw are rasters, not question marks,
   when the caller supplies a bitmap. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    root.CDOS = root.CDOS || {};
    root.CDOS.escpos = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  function concat(parts) {
    var n = 0;
    var i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n);
    var at = 0;
    for (i = 0; i < parts.length; i++) {
      out.set(parts[i], at);
      at += parts[i].length;
    }
    return out;
  }

  function bytes(list) {
    return new Uint8Array(list);
  }

  function needsRaster(text) {
    var s = String(text || "");
    var i;
    for (i = 0; i < s.length; i++) if (s.charCodeAt(i) > 126) return true;
    return false;
  }

  function textLine(text) {
    var s = String(text || "");
    var list = [0x1b, 0x74, 0x00];
    var i;
    for (i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      list.push(c >= 32 && c <= 126 ? c : 0x3f);
    }
    list.push(0x0a);
    return bytes(list);
  }

  function rasterCommand(bmp) {
    var widthBytes = bmp.widthBytes | 0;
    var height = bmp.height | 0;
    var head = bytes([
      0x1d, 0x76, 0x30, 0x00,
      widthBytes & 0xff, (widthBytes >> 8) & 0xff,
      height & 0xff, (height >> 8) & 0xff,
    ]);
    return concat([head, bmp.data]);
  }

  function qrCommand(url) {
    var s = String(url || "");
    var data = [];
    var i;
    for (i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 32 && c <= 126) data.push(c);
    }
    var len = data.length + 3;
    return concat([
      bytes([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
      bytes([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06]),
      bytes([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]),
      bytes([0x1d, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30].concat(data)),
      bytes([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
    ]);
  }

  function drawerPulse() {
    return bytes([0x1b, 0x70, 0x00, 0x19, 0x19]);
  }

  function lineBytes(line, rasterize) {
    if (needsRaster(line)) {
      var bmp = rasterize ? rasterize(line) : null;
      if (bmp && bmp.data) return rasterCommand(bmp);
      return null;
    }
    return textLine(line);
  }

  function encodeReceipt(model, hooks) {
    var src = model || {};
    var rasterize = hooks && hooks.rasterize;
    var parts = [bytes([0x1b, 0x40]), bytes([0x1b, 0x61, 0x01])];
    if (src.logo && src.logo.data) parts.push(rasterCommand(src.logo));
    var lines = src.lines || [];
    var i;
    for (i = 0; i < lines.length; i++) {
      var piece = lineBytes(lines[i], rasterize);
      if (piece) parts.push(piece);
    }
    if (src.qrUrl) parts.push(qrCommand(src.qrUrl));
    parts.push(bytes([0x0a, 0x0a, 0x0a]));
    if (src.drawer) parts.push(drawerPulse());
    if (src.cut !== false) parts.push(bytes([0x1d, 0x56, 0x42, 0x00]));
    return concat(parts);
  }

  return {
    needsRaster: needsRaster,
    drawerPulse: drawerPulse,
    qrCommand: qrCommand,
    rasterCommand: rasterCommand,
    encodeReceipt: encodeReceipt,
  };
});
