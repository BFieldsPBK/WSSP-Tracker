/* WSSP scoring — pure functions shared by the browser and the test suite.
 *
 * These functions contain the non-trivial scoring rules (point-spec
 * interpretation, claimed-point tallying, and the achievable-maximum
 * brute force) and touch no DOM, so they can be unit-tested directly under
 * Node. The browser loads this via a <script> tag before app.js (the
 * functions become globals); the tests and any Node code require() it. It
 * depends only on point-spec.js. */
"use strict";

/* In Node, pull the parser in; in the browser parsePointSpec is already a
 * global from the point-spec.js <script> that loads first. */
var _parsePointSpec = typeof parsePointSpec !== "undefined"
  ? parsePointSpec
  : require("./point-spec.js").parsePointSpec;

/* Point spec strings: "R", "1", "1-2", "R-1", "2-7", "35", "1, 2-3", "1 + 2-3".
 * required = leading R; header = null spec. `allowed` is the exact list of
 * claimable point values. Core parsing lives in point-spec.js; this wrapper
 * adds the UI-facing header / max / min / label fields:
 *   "2-7" -> 2..7 · "1, 2-3" -> 1,2,3 · "R-3" -> tiers 1..3 · "1 + 2-3" -> 1..4 */
function parsePoints(spec) {
  if (spec === null || spec === undefined) return { header: true, required: false, max: 0, min: 0, allowed: [] };
  const { required, allowed } = _parsePointSpec(spec);
  const max = allowed.length ? allowed[allowed.length - 1] : 0;
  const min = allowed.length ? allowed[0] : 0;
  return { header: false, required, max, min, allowed, label: spec };
}

function threshold(protocol, project) {
  const t = protocol.thresholds[project.projectType];
  return t ? t[project.districtClass] : null;
}

/* Walk every scoreable credit of a protocol. */
function eachCredit(protocol, fn) {
  for (const cat of protocol.categories)
    for (const g of cat.groups)
      for (const [id, name, spec] of g.credits) {
        const pts = parsePoints(spec);
        if (!pts.header) fn({ id, name, pts, category: cat });
      }
}

/* Points actually claimed for one credit entry (yes / maybeYes earn).
 * For R-n credits (a requirement plus optional points), Yes means the
 * requirement is satisfied — points above the requirement are opt-in. */
function entryPoints(entry, pts) {
  if (!entry || entry.status === "no" || entry.status === "maybeNo") return 0;
  if (pts.max === 0) return 0;
  if (entry.points !== undefined) return entry.points;
  if (pts.required) return 0;
  return pts.allowed.length === 1 ? pts.allowed[0] : 0;
}

function computeScore(protocol, project) {
  const blank = () => ({
    yes: 0, maybeYes: 0,                    // claimed points
    maybeNoMax: 0, noMax: 0,                // possible points in leaning-no / no credits
    nYes: 0, nMaybeYes: 0, nMaybeNo: 0, nNo: 0, nNA: 0,
    reqTotal: 0, reqMet: 0
  });
  const s = { ...blank(), byCategory: {} };
  const exemptions = project.exemptions || {};
  const notApplicable = project.notApplicable || {};
  eachCredit(protocol, ({ id, pts, category }) => {
    const c = s.byCategory[category.id] || (s.byCategory[category.id] = blank());
    if (notApplicable[id]) { s.nNA++; c.nNA++; return; }   // out of scope per Table 1
    const entry = project.credits[id];
    if (pts.required) {
      s.reqTotal++; c.reqTotal++;
      // an OSPI exemption (E / V / EX) deems a required credit compliant
      if ((entry && entry.status === "yes") || exemptions[id]) { s.reqMet++; c.reqMet++; }
    }
    const p = entryPoints(entry, pts);
    if (!entry) return;
    if (entry.status === "yes")      { s.yes += p;      c.yes += p;      s.nYes++;      c.nYes++; }
    if (entry.status === "maybeYes") { s.maybeYes += p; c.maybeYes += p; s.nMaybeYes++; c.nMaybeYes++; }
    if (entry.status === "maybeNo")  { s.maybeNoMax += pts.max; c.maybeNoMax += pts.max; s.nMaybeNo++; c.nMaybeNo++; }
    if (entry.status === "no")       { s.noMax += pts.max;      c.noMax += pts.max;      s.nNo++;      c.nNo++; }
  });
  return s;
}

/* Achievable maximum points, per category and overall, for one project.
 *
 * The official scorecard totals sum every credit's maximum, but that
 * overcounts: alternate pathways (exclusiveSets — E1.1/E1.2/E1.3) allow only
 * one choice, and the handbook bars some combinations outright
 * (conflictSets — "Points in E3.1.1–E3.1.3 may not be combined with points
 * in E1.3"). The real ceiling is the best valid combination.
 *
 * Only a handful of credits carry constraints, so we brute-force every
 * subset of the constrained credits in a category, keep the valid ones, and
 * take the highest-scoring — honoring the project's own commitments (a
 * pathway already marked Yes / Maybe Yes locks the choice) and skipping
 * Table 1 N/A credits. Results never exceed the official category total
 * (where OSPI prints a lower number, OSPI wins). */
function achievablePoints(protocol, project) {
  const notApplicable = (project && project.notApplicable) || {};
  const committed = id => {
    const st = project && project.credits && project.credits[id]?.status;
    return st === "yes" || st === "maybeYes";
  };
  const conflicts = {};
  for (const [a, list] of protocol.conflictSets || [])
    for (const b of list) {
      (conflicts[a] || (conflicts[a] = new Set())).add(b);
      (conflicts[b] || (conflicts[b] = new Set())).add(a);
    }
  const exclusiveOf = {};
  (protocol.exclusiveSets || []).forEach((set, i) => set.forEach(c => { exclusiveOf[c] = i; }));
  const isConstrained = id => conflicts[id] !== undefined || exclusiveOf[id] !== undefined;

  const out = { total: 0, listedTotal: 0, byCategory: {} };
  for (const cat of protocol.categories) {
    let base = 0;       // unconstrained credits always count their maximum
    const cons = [];    // constrained credits in this category
    for (const g of cat.groups) for (const [cid, , spec] of g.credits) {
      const pts = parsePoints(spec);
      if (pts.header || notApplicable[cid]) continue;
      if (isConstrained(cid)) cons.push({ id: cid, max: pts.max });
      else base += pts.max;
    }
    let bestAny = 0, bestCommitted = -1;
    /* Brute-forces every subset of this category's constrained credits:
     * 2^(cons.length) combinations. With current data that's a handful of
     * credits per category (trivial). If a future protocol edition ever puts
     * many constrained credits in one category, cap the search so the UI
     * can't hang, and fall back to summing their maxima (an upper bound). */
    const CONSTRAINED_LIMIT = 20; // 2^20 ≈ 1M iterations — well under a frame
    if (cons.length > CONSTRAINED_LIMIT) {
      const sumMax = cons.reduce((t, c) => t + c.max, 0);
      const capped = cat.total !== undefined ? Math.min(base + sumMax, cat.total) : base + sumMax;
      out.byCategory[cat.id] = capped;
      out.total += capped;
      out.listedTotal += cat.total ?? base + sumMax;
      continue;
    }
    for (let m = 0; m < (1 << cons.length); m++) {
      const ids = cons.filter((_, i) => m & (1 << i)).map(c => c.id);
      const sum = cons.reduce((t, c, i) => t + ((m & (1 << i)) ? c.max : 0), 0);
      let ok = true;
      const usedSet = {};
      for (const cid of ids) {
        const si = exclusiveOf[cid];
        if (si !== undefined) {
          if (usedSet[si]) { ok = false; break; }
          usedSet[si] = true;
        }
        if (conflicts[cid] && ids.some(o => conflicts[cid].has(o))) { ok = false; break; }
      }
      if (!ok) continue;
      bestAny = Math.max(bestAny, sum);
      if (cons.every((c, i) => !committed(c.id) || (m & (1 << i)))) {
        bestCommitted = Math.max(bestCommitted, sum);
      }
    }
    // If stored data holds an (older, now-invalid) combination, fall back to
    // the unrestricted best rather than showing nothing sensible.
    const best = bestCommitted >= 0 ? bestCommitted : bestAny;
    const capped = cat.total !== undefined ? Math.min(base + best, cat.total) : base + best;
    out.byCategory[cat.id] = capped;
    out.total += capped;
    out.listedTotal += cat.total ?? base + best;
  }
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { parsePoints, threshold, eachCredit, entryPoints, computeScore, achievablePoints };
}
