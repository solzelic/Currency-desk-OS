/* The teller's face-match words. One source for the server and the desk.
   The server requires this file. The shell loads it too. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.faceMatchAttestation = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  return {
    version: "face-match-v1",
    statement: "The customer is in front of me. I compared their face with the photo on this ID and they are the same person.",
  };
});
