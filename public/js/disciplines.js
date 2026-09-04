/* Project-team disciplines a credit task can be assigned to.
 *
 * Single source of truth for both sides: the browser loads this via a
 * <script> tag before app.js (DISCIPLINES / disciplineLabel / isDiscipline
 * become globals), and server.js require()s it to validate task assignments.
 *
 * To adjust the list, edit the array below — values are the stored keys
 * (keep them stable so existing task assignments don't break) and labels are
 * what users see. Adding, renaming a label, or reordering is safe; changing a
 * value orphans tasks already assigned to the old value. */
"use strict";

const DISCIPLINES = [
  { value: "owner",         label: "Owner" },
  { value: "architect",     label: "Architect" },
  { value: "landscape",     label: "Landscape Architect" },
  { value: "civil",         label: "Civil Engineer" },
  { value: "structural",    label: "Structural Engineer" },
  { value: "mechanical",    label: "Mechanical Engineer" },
  { value: "electrical",    label: "Electrical Engineer" },
  { value: "plumbing",      label: "Plumbing Engineer" },
  { value: "interiors",     label: "Interior Designer" },
  { value: "commissioning", label: "Commissioning Agent" },
  { value: "energy",        label: "Energy Modeler" },
  { value: "contractor",    label: "Contractor / CM" },
  { value: "consultant",    label: "Consultant" }
];

/* Label for a stored discipline value, or "" if unknown/unassigned. */
function disciplineLabel(v) {
  const hit = DISCIPLINES.find(d => d.value === v);
  return hit ? hit.label : "";
}

/* True when v is a recognized discipline key (used for server validation). */
function isDiscipline(v) {
  return DISCIPLINES.some(d => d.value === v);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { DISCIPLINES, disciplineLabel, isDiscipline };
}
