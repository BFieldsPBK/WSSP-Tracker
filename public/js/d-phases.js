/* SCAP D-Form phases relevant to WSSP, per the handbooks' "D-Form Process"
 * section, with the WSSP submittal due at each phase.
 *
 * Single source of truth for both sides: the browser loads this via a
 * <script> tag before app.js (D_PHASES / normalizeDPhase become globals),
 * and server.js require()s it for storage normalization and validation. */
"use strict";

const D_PHASES = [
  { value: "pre-d3", code: "Pre-D-3", label: "Pre-D-3 — Planning / Early Design",
    note: "Before the project approval application. Plan the integrated design workshop and choose the high-performance standard." },
  { value: "d3", code: "D-3", label: "D-3 — Application for Project Approval",
    note: "Indicate WSSP as the high-performance standard pursued on the D-3 (or request an exemption with a letter to OSPI)." },
  { value: "d4", code: "D-4", label: "D-4 — OSPI Project Approval Issued",
    note: "Edition lock: SCAP projects apply the WSSP version in effect at D-4 approval. A newer edition may always be used." },
  { value: "d5", code: "D-5", label: "D-5 — Application for Preliminary Funding Status",
    note: "Due with D-5: preliminary design WSSP scorecard." },
  { value: "d7", code: "D-7", label: "D-7 — Proceed with Bid Opening / Negotiate MACC",
    note: "ELCCA (Energy Conservation Report) cost indicated on the D-7 with the DES review letter. No separate WSSP submittal." },
  { value: "d9", code: "D-9", label: "D-9 — Authorization to Sign Contracts / MACC Agreement",
    note: "Due with D-9: final design-phase WSSP scorecard, Sustainable Building Strategy narrative (2–4 pages), and ELCCA executive summary if applicable." },
  { value: "d11", code: "D-11", label: "D-11 — Application to Release Retainage",
    note: "Due with/before D-11: final WSSP scorecard, Post Occupancy Evaluation Plan, and certification letter committing to 5 years of annual reporting." },
  { value: "annual", code: "Reporting", label: "Annual Reporting (5 years)",
    note: "Report energy and water use through EPA Energy Star Portfolio Manager for five consecutive years after board acceptance." }
];

/* Normalize stored/legacy values ("D4", "d-5 ", "D11") to canonical keys;
 * anything unrecognized is kept as entered. */
function normalizeDPhase(v) {
  if (!v) return "";
  const k = String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
  const hit = D_PHASES.find(p =>
    p.value.replace(/[^a-z0-9]/g, "") === k ||
    p.code.toLowerCase().replace(/[^a-z0-9]/g, "") === k);
  return hit ? hit.value : v;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { D_PHASES, normalizeDPhase };
}
