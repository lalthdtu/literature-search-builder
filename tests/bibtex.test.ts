import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyBibtexDiagnosticFix, parseBibtex } from "../src/lib/bibtex.ts";

test("parses nested braces, quoted fields, and hyphenated field names", () => {
  const result = parseBibtex(`@article{alpha,
    title = {A {Nested} Title},
    author = "Doe, Jane",
    unique-id = {source-1},
    year = 2025
  }`);
  assert.equal(result.hasBlockingErrors, false);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].fields.title, "A {Nested} Title");
  assert.equal(result.records[0].fields.author, "Doe, Jane");
  assert.equal(result.records[0].fields["unique-id"], "source-1");
});

test("blocks embedded entry headers and unbalanced records", () => {
  const embedded = parseBibtex("@article{one, title={Broken} @article{two, title={Two}} }");
  assert.equal(embedded.hasBlockingErrors, true);
  assert.equal(embedded.diagnostics.some((item) => item.code === "embedded_entry"), true);

  const unbalanced = parseBibtex("@article{one, title={Broken}");
  assert.equal(unbalanced.hasBlockingErrors, true);
  assert.equal(unbalanced.diagnostics.some((item) => item.code === "unbalanced_entry"), true);
});

test("warns about cite-key collisions while retaining independently identified records", () => {
  const result = parseBibtex("@article{same, title={One}}\n@article{same, title={Two}}");
  assert.equal(result.hasBlockingErrors, false);
  assert.equal(result.records.length, 2);
  assert.equal(result.diagnostics.some((item) => item.code === "citekey_collision" && item.severity === "warning"), true);
  assert.notEqual(result.records[0].internalId, result.records[1].internalId);
  assert.equal(result.records[0].range.startLine, 1);
  assert.equal(result.records[1].range.startLine, 2);
});

test("returns actionable source ranges for structural diagnostics", () => {
  const result = parseBibtex("@article{one, title={Broken}\n@article{two, title={Two}}}");
  const diagnostic = result.diagnostics.find((item) => item.code === "embedded_entry");
  assert.ok(diagnostic);
  assert.equal(diagnostic.range.startLine, 1);
  assert.equal(diagnostic.range.endLine, 1);
  assert.match(diagnostic.guidance, /Close/);
  assert.ok(diagnostic.fix);
  const repaired = parseBibtex(applyBibtexDiagnosticFix("@article{one, title={Broken}\n@article{two, title={Two}}}", diagnostic));
  assert.equal(repaired.hasBlockingErrors, false);
  assert.equal(repaired.records.length, 2);
});

test("uses content fingerprints that are independent of cite keys", () => {
  const result = parseBibtex("@article{databaseA, title={Same}, year={2024}}\n@article{databaseB, title={Same}, year={2024}}");
  assert.equal(result.records[0].fingerprint, result.records[1].fingerprint);
  assert.notEqual(result.records[0].internalId, result.records[1].internalId);
});

test("rejects the supplied malformed example fixture", () => {
  const source = readFileSync(new URL("../example_bib/all_combined_deduplicated.bib", import.meta.url), "utf8");
  const result = parseBibtex(source);
  assert.equal(result.hasBlockingErrors, true);
  assert.equal(result.discoveredHeaders, 3496);
  assert.equal(result.diagnostics.filter((item) => item.code === "embedded_entry").length, 5);
  assert.equal(result.diagnostics.some((item) => item.code === "entry_count_mismatch"), true);
});
