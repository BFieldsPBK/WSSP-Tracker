"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePointSpec } = require("../public/js/point-spec.js");

test("plain single point value", () => {
  assert.deepEqual(parsePointSpec("1"), { required: false, allowed: [1] });
  assert.deepEqual(parsePointSpec("35"), { required: false, allowed: [35] });
});

test("required-only credit (R) has no claimable points", () => {
  assert.deepEqual(parsePointSpec("R"), { required: true, allowed: [] });
});

test("range expands to every value inclusive", () => {
  assert.deepEqual(parsePointSpec("2-7"), { required: false, allowed: [2, 3, 4, 5, 6, 7] });
  assert.deepEqual(parsePointSpec("1-2"), { required: false, allowed: [1, 2] });
});

test("en-dash range is treated the same as hyphen range", () => {
  assert.deepEqual(parsePointSpec("2\u20137"), { required: false, allowed: [2, 3, 4, 5, 6, 7] });
});

test("comma list merges and de-dupes into sorted values", () => {
  assert.deepEqual(parsePointSpec("1, 2-3"), { required: false, allowed: [1, 2, 3] });
  assert.deepEqual(parsePointSpec("3, 1, 1"), { required: false, allowed: [1, 3] });
});

test("R-n required credit expands to tiers 1..n", () => {
  const r = parsePointSpec("R-3");
  assert.equal(r.required, true);
  assert.deepEqual(r.allowed, [1, 2, 3]);
});

test("'+' spec sums each part's maximum into a 1..total range", () => {
  // 1 (max of "1") + 3 (max of "2-3") = 4 -> 1..4
  assert.deepEqual(parsePointSpec("1 + 2-3"), { required: false, allowed: [1, 2, 3, 4] });
});

test("R prefix with a range keeps required flag", () => {
  const r = parsePointSpec("R-1");
  assert.equal(r.required, true);
});
