/* Staging "Start a fresh shop" on the sign-in page.
   Absent unless the door is open. The staff id and the one-time
   password stay on the card only. Continuing keeps the email and
   the signup code for the real code screen, and drops the password.
   Nothing here is written to storage, the address bar, or the log. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) {
    var cdos = root.CDOS || (root.CDOS = {});
    cdos.freshShopButton = api.freshShopButton;
    cdos.freshShopMessage = api.freshShopMessage;
    cdos.freshShopNotice = api.freshShopNotice;
    cdos.acceptFreshShop = api.acceptFreshShop;
    cdos.leaveFreshCard = api.leaveFreshCard;
    cdos.freshShopCode = api.freshShopCode;
    cdos.afterFreshVerify = api.afterFreshVerify;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var NOTICE = "Shown once. Write it down.";
  var CODE_LINE = "Type this code. It is shown here.";

  function freshShopButton(enabled) {
    return enabled === true ? [{ label: "Start a fresh shop" }] : [];
  }

  function freshShopMessage(status) {
    if (status === 429 || status === "slow") return "Slow down. Try again in a little while.";
    if (status === 0 || status === "network") return "The desk did not answer. Check your connection and try again.";
    return "Something went wrong. Try again.";
  }

  function six(code) {
    return typeof code === "string" && /^[0-9]{6}$/.test(code);
  }

  function acceptFreshShop(body) {
    var staffId = body && typeof body.email === "string" ? body.email.trim() : "";
    var password = body && typeof body.password === "string" ? body.password : "";
    var code = body && typeof body.code === "string" ? body.code.trim() : "";
    if (!staffId || !password || !six(code)) return null;
    return { staffId: staffId, password: password, code: code };
  }

  /* The password is not on the next screen. The caller shows the code
     and then throws this object away. */
  function leaveFreshCard(held) {
    if (!held || !held.staffId || !six(held.code)) return null;
    return { email: held.staffId, code: held.code };
  }

  function freshShopCode(code) {
    var value = typeof code === "string" ? code.trim() : "";
    if (!six(value)) return null;
    return { code: value, line: CODE_LINE };
  }

  /* A fresh shop owner has to sign in and replace the one-time password.
     Any other verify still opens the desk the way it does today. */
  function afterFreshVerify(user) {
    return user && user.mustChangePassword === true ? "signin" : "desk";
  }

  return {
    freshShopButton: freshShopButton,
    freshShopMessage: freshShopMessage,
    freshShopNotice: NOTICE,
    acceptFreshShop: acceptFreshShop,
    leaveFreshCard: leaveFreshCard,
    freshShopCode: freshShopCode,
    afterFreshVerify: afterFreshVerify,
  };
});
