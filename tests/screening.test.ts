import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBlockResults,
  normalizeOperators,
  toExclusionCSV,
  toExclusionSummaryCSV,
  type BlockResult,
  type ExcludedCsvRow,
} from "../src/lib/screening.ts";

function block(overrides: Partial<BlockResult> = {}): BlockResult {
  return {
    blockId: "block-1",
    blockIndex: 0,
    blockName: "Population",
    isExclusion: false,
    matched: true,
    configuredTerms: ["adult", "participant"],
    hits: { title: ["adult"] },
    ...overrides,
  };
}

function row(overrides: Partial<ExcludedCsvRow> = {}): ExcludedCsvRow {
  return {
    CiteKey: "study-1",
    Title: "A study",
    Authors: "Doe, Jane",
    Year: "2025",
    Venue: "Journal",
    URL: "https://example.test",
    PrimaryExclusionReason: "Required block not matched: Population",
    AllExclusionReasons: "Required block not matched: Population",
    Evidence: "Configured terms: adult | participant",
    ...overrides,
  };
}

test("keeps a record only when every required block matches and no exclusion block matches", () => {
  const result = classifyBlockResults([
    block(),
    block({ blockId: "block-2", blockIndex: 1, blockName: "Review article", isExclusion: true, matched: false, hits: {} }),
  ], true);

  assert.equal(result.kept, true);
  assert.deepEqual(result.reasons, []);
});

test("records every failed required block in configured order", () => {
  const result = classifyBlockResults([
    block({ matched: false, hits: {} }),
    block({ blockId: "block-2", blockIndex: 1, blockName: "Setting", matched: false, configuredTerms: ["remote"], hits: {} }),
  ], true);

  assert.equal(result.kept, false);
  assert.equal(result.primaryReason, "Required block not matched: Population");
  assert.deepEqual(result.reasons.map((reason) => reason.message), [
    "Required block not matched: Population",
    "Required block not matched: Setting",
  ]);
});

test("combines required-block failures and exclusion hits without merging duplicate names", () => {
  const result = classifyBlockResults([
    block({ blockId: "required", blockName: "Criterion", matched: false, hits: {} }),
    block({
      blockId: "excluded",
      blockIndex: 1,
      blockName: "Criterion",
      isExclusion: true,
      matched: true,
      configuredTerms: ["review"],
      hits: { abstract: ["review"] },
    }),
  ], true);

  assert.deepEqual(result.reasons.map((reason) => reason.blockId), ["required", "excluded"]);
  assert.equal(result.reasons[1].evidence, "Abstract: review");
});

test("uses the block-number fallback supplied by the matcher for unnamed blocks", () => {
  const result = classifyBlockResults([block({ blockName: "Block 1", matched: false, hits: {} })], true);
  assert.equal(result.primaryReason, "Required block not matched: Block 1");
});

test("uses one missing-data reason when selected fields contain no data", () => {
  const result = classifyBlockResults([block({ matched: false, hits: {} })], false);
  assert.equal(result.kept, false);
  assert.equal(result.primaryReason, "Missing searchable data");
  assert.equal(result.reasons.length, 1);
});

test("normalizes legacy inter-block operators to AND", () => {
  assert.deepEqual(normalizeOperators(4), ["AND", "AND", "AND"]);
  assert.deepEqual(normalizeOperators(0), []);
});

test("escapes detailed CSV values containing commas, quotes, and newlines", () => {
  const csv = toExclusionCSV([row({ Title: 'A "quoted", title\ncontinued' })]);
  assert.match(csv, /"A ""quoted"", title\ncontinued"/);
  assert.match(csv, /excluded,pre_full_text,automatic/);
});

test("summary counts each excluded record once by primary reason", () => {
  const csv = toExclusionSummaryCSV([
    row(),
    row({ CiteKey: "study-2" }),
    row({ CiteKey: "study-3", PrimaryExclusionReason: "Exclusion block matched: Review article" }),
  ]);

  assert.equal(csv, [
    "PrimaryExclusionReason,Count",
    "Required block not matched: Population,2",
    "Exclusion block matched: Review article,1",
  ].join("\n"));
});
