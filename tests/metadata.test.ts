import test from "node:test";
import assert from "node:assert/strict";
import { parseBibtex } from "../src/lib/bibtex.ts";
import { applyDuplicateResolutions, findDuplicateGroups } from "../src/lib/deduplication.ts";
import { applyMetadataRequirements, calculateMetadataFieldCounts, canonicalMetadataValue, missingRequiredFields, toMetadataRemovalsCSV } from "../src/lib/metadata.ts";

test("resolves canonical aliases and treats empty or brace-only values as missing", () => {
  const records = parseBibtex(`@article{one, title={{ }}, author={Doe}, summary={Summary}, author_keywords={VR}, booktitle={Conference}}`).records;
  assert.equal(canonicalMetadataValue(records[0], "abstract"), "Summary");
  assert.equal(canonicalMetadataValue(records[0], "keywords"), "VR");
  assert.equal(canonicalMetadataValue(records[0], "venue"), "Conference");
  assert.deepEqual(missingRequiredFields(records[0], ["title", "author"]), ["title"]);
});

test("applies every selected rule and orders primary missing fields canonically", () => {
  const records = parseBibtex(`@article{one, year={2024}}\n@article{two, title={Title}, author={Author}}`).records;
  const result = applyMetadataRequirements(records, ["author", "title", "doi"]);
  assert.equal(result.retainedRecords.length, 0);
  assert.deepEqual(result.removals[0].missingFields, ["title", "author", "doi"]);
  assert.equal(result.removals[0].primaryMissingField, "title");
  assert.deepEqual(result.removals[1].missingFields, ["doi"]);
});

test("allows zero required fields and reports present and missing counts", () => {
  const records = parseBibtex(`@article{one, title={Title}}\n@article{two, author={Author}}`).records;
  assert.equal(applyMetadataRequirements(records, []).retainedRecords.length, 2);
  assert.deepEqual(calculateMetadataFieldCounts(records).title, { present: 1, missing: 1 });
});

test("evaluates requirements after duplicate enrichment", () => {
  const records = parseBibtex(`@article{one, title={Same}, doi={10.1/a}}\n@article{two, title={Same}, author={Author}, doi={10.1/a}}`).records;
  const group = findDuplicateGroups(records)[0];
  const deduplicated = applyDuplicateResolutions(records, [group], { [group.id]: { action: "merge", canonicalId: records[0].internalId, enrichFromIds: [records[1].internalId] } });
  const cleaned = applyMetadataRequirements(deduplicated.records, ["title", "author"]);
  assert.equal(cleaned.retainedRecords.length, 1);
  assert.equal(cleaned.removals.length, 0);
});

test("exports one automatic pre-screening audit row per removal", () => {
  const records = parseBibtex(`@article{one, title={Comma, "quote"}}`).records;
  const result = applyMetadataRequirements(records, ["title", "author"]);
  const csv = toMetadataRemovalsCSV(result.removals);
  assert.match(csv, /removed,pre_screening_cleanup,automatic/);
  assert.match(csv, /Author/);
  assert.match(csv, /"Comma, ""quote"""/);
  assert.equal(csv.split("\n").length, 2);
});
