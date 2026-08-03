import test from "node:test";
import assert from "node:assert/strict";
import { parseBibtex } from "../src/lib/bibtex.ts";
import { applyDuplicateResolutions, buildUniqueBibtex, findDuplicateGroups, normalizeDoi, normalizeTitle, toDuplicateAuditCSV } from "../src/lib/deduplication.ts";

const parsed = parseBibtex(`@article{a, title={A {Shared} Title}, doi={https://doi.org/10.1/ABC}, author={One}, year={2020}}
@article{b, title={A shared title!}, doi={doi: 10.1/abc}, abstract={Enrichment}}
@article{c, title={A Shared Title}, keywords={extra}}
@article{same, title={Distinct one}}
@article{same, title={Distinct two}}`).records;

test("normalizes DOI and title without using cite keys", () => {
  assert.equal(normalizeDoi("https://doi.org/10.1/ABC"), "10.1/abc");
  assert.equal(normalizeTitle("A {Shared} Title!"), "a shared title");
  const groups = findDuplicateGroups(parsed);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].recordIds.length, 3);
  assert.equal(groups[0].evidence.some((item) => item.kind === "doi"), true);
  assert.equal(groups[0].evidence.some((item) => item.kind === "title"), true);
});

test("merges only missing canonical fields and writes one audit row per removed record", () => {
  const group = findDuplicateGroups(parsed)[0];
  const result = applyDuplicateResolutions(parsed, [group], { [group.id]: { action: "merge", canonicalId: parsed[0].internalId, enrichFromIds: [parsed[1].internalId] } });
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].fields.author, "One");
  assert.equal(result.records[0].fields.abstract, "Enrichment");
  assert.equal(result.audit.length, 2);
  assert.match(toDuplicateAuditCSV(result.audit), /deduplication/);
});

test("makes colliding export keys deterministic while preserving first key", () => {
  const colliding = parsed.slice(3);
  const exported = buildUniqueBibtex(colliding);
  assert.deepEqual(exported.mapping.map((item) => item.exportCiteKey), ["same", "same-2"]);
  assert.match(exported.bibtex, /@article\{same-2,/);
});

test("audits every candidate record including keep-all and canonical decisions", () => {
  const group = findDuplicateGroups(parsed)[0];
  const kept = applyDuplicateResolutions(parsed, [group], { [group.id]: { action: "keep_all" } });
  assert.equal(kept.decisionAudit.length, 3);
  assert.equal(kept.decisionAudit.every((row) => row.action === "kept_distinct"), true);

  const merged = applyDuplicateResolutions(parsed, [group], { [group.id]: { action: "merge", canonicalId: parsed[0].internalId, enrichFromIds: [parsed[1].internalId] } });
  assert.equal(merged.decisionAudit.filter((row) => row.action === "canonical").length, 1);
  assert.equal(merged.decisionAudit.filter((row) => row.action === "removed_duplicate").length, 2);
  assert.match(merged.decisionAudit.find((row) => row.action === "canonical")?.enrichmentProvenance || "", /b: abstract/);
});
