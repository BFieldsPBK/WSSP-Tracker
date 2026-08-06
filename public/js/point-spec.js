/* WSSP credit point-spec parser — single source of truth for both sides.
 *
 * A "point spec" is the short string printed on the scorecard for a credit:
 *   "R", "1", "1-2", "R-1", "2-7", "35", "1, 2-3", "1 + 2-3"
 * `required` is true for a leading R; `allowed` is the exact ascending list
 * of point values the credit can legally claim:
 *   "2-7"    -> 2,3,4,5,6,7
 *   "1, 2-3" -> 1,2,3
 *   "R-3"    -> tiers 1..3
 *   "1 + 2-3"-> 1..4 (sum of each part's maximum)
 *
 * The browser loads this via a <script> tag before app.js (parsePointSpec
 * becomes a global), and server.js require()s it — so the parsing rules live
 * in exactly one place and can't drift between client and server. */
"use strict";

function parsePointSpec(spec) {
  const required = /^R/i.test(spec);
  const body = spec.replace(/^R[-–]?\s*/i, "");
  let allowed = [];
  if (body.includes("+")) {
    const partMax = s => Math.max(0, ...(s.match(/\d+/g) || []).map(Number));
    const total = body.split("+").reduce((t, x) => t + partMax(x), 0);
    for (let n = 1; n <= total; n++) allowed.push(n);
  } else if (required && /^\d+$/.test(body.trim())) {
    for (let n = 1; n <= Number(body.trim()); n++) allowed.push(n);   // "R-3" -> tiers 1..3
  } else {
    for (const part of body.split(",")) {
      const m = part.match(/(\d+)\s*[-–]\s*(\d+)/);
      if (m) { for (let n = Number(m[1]); n <= Number(m[2]); n++) allowed.push(n); }
      else { const s = part.match(/\d+/); if (s) allowed.push(Number(s[0])); }
    }
  }
  allowed = [...new Set(allowed)].sort((a, b) => a - b);
  return { required, allowed };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parsePointSpec };
}
