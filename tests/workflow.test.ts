import test from "node:test";
import assert from "node:assert/strict";
import { parseBibtex, sourceSignature } from "../src/lib/bibtex.ts";
import { createImportSnapshot, createProjectFile, generateBooleanQuery, importReadiness, parseProjectFile, validateQueryConfig, type QueryConfig } from "../src/lib/workflow.ts";

const source = "@article{a, title={Complete}, abstract={Text}}\n@article{b, title={Also complete}}";
const config: QueryConfig = { blocks: [{ id: "one", name: "Population", terms: ["adult"] }], operators: [], caseInsensitive: true, searchFields: { title: true, abstract: true, keywords: false } };

test("structural validity and source signatures gate import readiness", () => {
  const snapshot = createImportSnapshot(source, parseBibtex(source));
  assert.equal(importReadiness(snapshot, source).ready, true);
  assert.equal(importReadiness(snapshot, `${source}\n`).ready, false);
  assert.deepEqual(snapshot.fieldCounts.title, { present: 2, missing: 0 });
  assert.deepEqual(snapshot.fieldCounts.author, { present: 0, missing: 2 });
});

test("validates empty terms and regexes and generates the authoritative expression", () => {
  assert.deepEqual(validateQueryConfig(config), []);
  assert.equal(generateBooleanQuery(config), "(adult)");
  assert.equal(validateQueryConfig({ ...config, blocks: [{ ...config.blocks[0], isRegex: true, terms: ["["] }] }).some((item) => item.includes("invalid regex")), true);
});

test("version-2 project files round-trip", () => {
  const project = createProjectFile({ sourceName: "input.bib", bibtex: source, metadataRequirements: { requiredFields: ["title", "author"], confirmed: true }, queryString: "(adult)", queryConfig: config, duplicateResolutions: {} });
  const result = parseProjectFile(project);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.project.metadataRequirements.requiredFields, ["title", "author"]);
  assert.equal(parseProjectFile({ ...project, bibtex: `${source} changed` }).ok, false);
  assert.equal(parseProjectFile({ ...project, metadataRequirements: { requiredFields: ["unknown"], confirmed: true } }).ok, false);
});

test("version-1 projects migrate 100 percent rules and report ignored partial thresholds", () => {
  const legacy = {
    kind: "literature-search-project",
    version: 1,
    sourceName: "input.bib",
    bibtex: source,
    sourceSignature: sourceSignature(source),
    thresholds: { title: 100, abstract: 50, keywords: 0 },
    requirementsConfirmed: true,
    queryString: "(adult)",
    queryConfig: config,
    duplicateResolutions: {},
  };
  const result = parseProjectFile(legacy);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.project.metadataRequirements, { requiredFields: ["title"], confirmed: false });
  assert.match(result.migrationNotice || "", /abstract 50%/);
});
