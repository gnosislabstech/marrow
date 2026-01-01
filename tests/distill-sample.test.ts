// Search-fix kernel: selectDistillationSample must sample ACROSS the session
// (not just endpoints), always keep marker-bearing chunks, cap long sessions,
// and distill short sessions whole. This is the recall-critical primitive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectDistillationSample } from "../src/analytics/distill-sample.js";

const make = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ turn_index: i, content: `turn ${i}` }));

test("distill: a short session is kept whole", () => {
  const r = selectDistillationSample(make(30), { maxChunks: 12, threshold: 40 });
  assert.equal(r.length, 30);
});

test("distill: a long session is capped, includes endpoints, sorted, no dups", () => {
  const r = selectDistillationSample(make(100), { maxChunks: 10, threshold: 40 });
  assert.ok(r.length <= 10, `expected <=10, got ${r.length}`);
  assert.equal(r[0].turn_index, 0, "must include the first turn");
  assert.equal(r[r.length - 1].turn_index, 99, "must include the last turn");
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i].turn_index > r[i - 1].turn_index, "must be sorted ascending with no duplicates");
  }
});

test("distill: a marker-bearing chunk mid-session is ALWAYS kept (the recall point)", () => {
  const chunks = make(100);
  chunks[50] = { turn_index: 50, content: "[Tool error] something blew up here" };
  const r = selectDistillationSample(chunks, { maxChunks: 10, threshold: 40 });
  assert.ok(r.some((c) => c.turn_index === 50), "the mid-session error chunk must survive sampling");
});
