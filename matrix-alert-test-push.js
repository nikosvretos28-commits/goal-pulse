"use strict";

function buildMatrixAlertTestPushPayload() {
  return {
    title: "🧩 GOALMATRIX · MATRIX ALERT TEST",
    body: "Αυτή είναι μόνο δοκιμαστική ειδοποίηση του ανεξάρτητου Matrix Alert. Δεν αντιστοιχεί σε πραγματικό αγώνα ή σήμα.",
    tag: "goalmatrix-matrix-alert-test",
    url: "/",
    matrixAlertTest: true
  };
}

module.exports = { buildMatrixAlertTestPushPayload };
