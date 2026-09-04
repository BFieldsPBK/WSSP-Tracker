"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  parsePoints, threshold, eachCredit, entryPoints, computeScore, achievablePoints
} = require("../public/js/scoring.js");

/* A small synthetic protocol exercising every scoring path: a header row, a
 * required-only credit, a fixed-value credit, a variable range, and two
 * mutually-exclusive alternate pathways. */
const PROTOCOL = {
  id: "test",
  thresholds: { new: { I: 30, II: 20 } },
  exclusiveSets: [["E1.1", "E1.2"]],
  conflictSets: [],
  categories: [{
    id: "E",
    total: 10,
    groups: [{
      name: "Energy",
      credits: [
        ["E0", "Header", null],
        ["E1", "Required only", "R"],
        ["E2", "Fixed one point", "1"],
        ["E3", "Variable range", "2-4"],
        ["E1.1", "Pathway A", "3"],
        ["E1.2", "Pathway B", "5"]
      ]
    }]
  }]
};

test("parsePoints marks null spec as a header", () => {
  assert.equal(parsePoints(null).header, true);
  assert.equal(parsePoints("2-4").header, false);
  assert.equal(parsePoints("2-4").max, 4);
  assert.equal(parsePoints("2-4").min, 2);
});

test("threshold reads the project type + district class, null when unknown", () => {
  assert.equal(threshold(PROTOCOL, { projectType: "new", districtClass: "I" }), 30);
  assert.equal(threshold(PROTOCOL, { projectType: "new", districtClass: "II" }), 20);
  assert.equal(threshold(PROTOCOL, { projectType: "modernization", districtClass: "I" }), null);
});

test("eachCredit skips headers and visits every scoreable credit", () => {
  const seen = [];
  eachCredit(PROTOCOL, ({ id }) => seen.push(id));
  assert.deepEqual(seen, ["E1", "E2", "E3", "E1.1", "E1.2"]);
});

test("entryPoints: no/maybeNo/absent entries score zero", () => {
  const range = parsePoints("2-4");
  assert.equal(entryPoints(undefined, range), 0);
  assert.equal(entryPoints({ status: "no" }, range), 0);
  assert.equal(entryPoints({ status: "maybeNo" }, range), 0);
});

test("entryPoints: explicit points are honored for yes/maybeYes", () => {
  const range = parsePoints("2-4");
  assert.equal(entryPoints({ status: "yes", points: 3 }, range), 3);
  assert.equal(entryPoints({ status: "maybeYes", points: 4 }, range), 4);
});

test("entryPoints: fixed single-value credit defaults to that value", () => {
  assert.equal(entryPoints({ status: "yes" }, parsePoints("1")), 1);
});

test("entryPoints: a range credit Yes with no point value scores 0 (the export footgun)", () => {
  assert.equal(entryPoints({ status: "yes" }, parsePoints("2-4")), 0);
});

test("entryPoints: required-only credit never contributes points", () => {
  assert.equal(entryPoints({ status: "yes" }, parsePoints("R")), 0);
});

test("computeScore tallies claimed points and required-credit completion", () => {
  const project = {
    credits: {
      E1: { status: "yes" },            // required met
      E2: { status: "yes" },            // +1
      E3: { status: "yes", points: 4 }, // +4
      "E1.1": { status: "maybeYes", points: 3 } // maybeYes +3
    }
  };
  const s = computeScore(PROTOCOL, project);
  assert.equal(s.reqTotal, 1);
  assert.equal(s.reqMet, 1);
  assert.equal(s.yes, 5);        // E2 (1) + E3 (4)
  assert.equal(s.maybeYes, 3);   // E1.1
  assert.equal(s.nYes, 3);
});

test("computeScore counts an OSPI exemption as a met requirement", () => {
  const project = { credits: {}, exemptions: { E1: "E" } };
  const s = computeScore(PROTOCOL, project);
  assert.equal(s.reqMet, 1);
});

test("computeScore excludes Table 1 not-applicable credits", () => {
  const project = { credits: { E2: { status: "yes" } }, notApplicable: { E2: true } };
  const s = computeScore(PROTOCOL, project);
  assert.equal(s.nNA, 1);
  assert.equal(s.yes, 0); // E2 is out of scope, not counted
});

test("achievablePoints picks the best single alternate pathway (exclusive set)", () => {
  // base = E2 (1) + E3 (4) = 5; alternates E1.1 (3) / E1.2 (5) -> take 5.
  const out = achievablePoints(PROTOCOL, {});
  assert.equal(out.byCategory.E, 10); // 5 + 5, capped at cat.total 10
});

test("achievablePoints honors a committed pathway even if it's the smaller one", () => {
  // Committing E1.1 (3) locks out E1.2 (5): base 5 + 3 = 8.
  const out = achievablePoints(PROTOCOL, { credits: { "E1.1": { status: "yes" } } });
  assert.equal(out.byCategory.E, 8);
});

test("achievablePoints never exceeds the category's listed total", () => {
  const out = achievablePoints(PROTOCOL, {});
  assert.ok(out.total <= out.listedTotal);
});

/* Sanity check against the real shipped protocol definitions: scoring the
 * empty project must run cleanly and stay within the official totals. */
const PROTO_DIR = path.join(__dirname, "..", "config", "protocols");
for (const f of fs.readdirSync(PROTO_DIR).filter(f => f.endsWith(".json"))) {
  const proto = JSON.parse(fs.readFileSync(path.join(PROTO_DIR, f), "utf8"));
  test(`real protocol ${proto.id}: achievablePoints is finite and within listed total`, () => {
    const out = achievablePoints(proto, { credits: {} });
    assert.ok(Number.isFinite(out.total));
    assert.ok(out.total > 0);
    assert.ok(out.total <= out.listedTotal);
  });
  test(`real protocol ${proto.id}: computeScore on empty project is all-zero`, () => {
    const s = computeScore(proto, { credits: {} });
    assert.equal(s.yes, 0);
    assert.equal(s.maybeYes, 0);
    assert.ok(s.reqTotal > 0);
    assert.equal(s.reqMet, 0);
  });
}
