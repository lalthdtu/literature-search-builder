import test from "node:test";
import assert from "node:assert/strict";
import { parseBlockQuery } from "../src/lib/queryParser.ts";

const reviewQuery = `("immersive virtual reality" OR "virtual reality")
AND
("remote experiment" OR "remote participation" OR "remote study" OR "remote VR" OR
"online study" OR home* OR "participant-owned HMD" OR "participant-provided HMD" OR
"self-administered" OR "unsupervised" OR "participant-led" OR "self-conducted" OR
"web-based" OR crowdsourc* OR prolific OR "amazon mechanical turk" OR MTurk OR
"out-of-lab" OR "outside the lab" OR decentralized)
AND
("user" OR "online" OR "study" OR "experiment" OR "behavior" OR "cognition" OR
"evaluation" OR "empirical" OR "perception" OR "participant" OR "controlled" OR
"task performance" OR "human-subject" OR "data collection")
NOT
(review OR "systematic review" OR "literature review" OR survey OR "meta-analysis" OR
rehabilitation OR education OR training OR teleoperation OR collaboration)`;

test("parses the supplied review query into four blocks including standalone NOT", () => {
  const result = parseBlockQuery(reviewQuery);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.blocks.map((block) => block.terms.length), [2, 20, 14, 10]);
  assert.deepEqual(result.blocks.map((block) => block.exclude), [false, false, false, true]);
  assert.equal(result.blocks[1].terms.includes("home*"), true);
  assert.equal(result.blocks[1].terms.includes("participant-owned HMD"), true);
});

test("treats standalone NOT and AND NOT identically", () => {
  const standalone = parseBlockQuery("(alpha OR beta) NOT (review OR survey)");
  const explicit = parseBlockQuery("(alpha OR beta) AND NOT (review OR survey)");
  assert.equal(standalone.ok, true);
  assert.equal(explicit.ok, true);
  if (standalone.ok && explicit.ok) {
    assert.deepEqual(standalone.blocks.map(({ terms, exclude }) => ({ terms, exclude })), explicit.blocks.map(({ terms, exclude }) => ({ terms, exclude })));
  }
});

test("rejects malformed and unsupported expressions", () => {
  for (const query of ["(alpha OR beta", "(alpha AND beta)", "(alpha) OR (beta)", "(alpha) (beta)", "()"] ) {
    const result = parseBlockQuery(query);
    assert.equal(result.ok, false, query);
    if (!result.ok) assert.equal(result.errors.length > 0, true);
  }
});
