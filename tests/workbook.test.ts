import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { parseBibtex } from "../src/lib/bibtex.ts";
import { applyDuplicateResolutions, findDuplicateGroups } from "../src/lib/deduplication.ts";
import { applyMetadataRequirements } from "../src/lib/metadata.ts";
import { classifyBlockResults, createBlockMatcher, type ScreeningRow } from "../src/lib/screening.ts";
import { buildPrismaWorkbook, fullTextAssessmentCompleteness, prismaWorkbookFilename, type WorkbookRunSnapshot } from "../src/lib/workbook.ts";
import { generateBooleanQuery, type QueryConfig } from "../src/lib/workflow.ts";

const source = `@article{same,
  title={=Formula-like virtual reality study},
  author={Doe, Jane},
  abstract={A remote study},
  doi={10.1/example}
}
@article{duplicate,
  title={=Formula-like virtual reality study},
  author={Doe, Jane},
  abstract={A remote study},
  doi={https://doi.org/10.1/example},
  keywords={enrichment}
}
@article{missingAuthor,
  title={Virtual reality remote study}
}
@article{same,
  title={Unrelated review},
  author={Roe, Richard}
}`;

function snapshot(): WorkbookRunSnapshot {
  const parsed = parseBibtex(source);
  const groups = findDuplicateGroups(parsed.records);
  const resolutions = { [groups[0].id]: { action: "merge" as const, canonicalId: groups[0].recordIds[0], enrichFromIds: [groups[0].recordIds[1]] } };
  const dedup = applyDuplicateResolutions(parsed.records, groups, resolutions);
  const metadata = applyMetadataRequirements(dedup.records, ["title", "author"]);
  const config: QueryConfig = {
    caseInsensitive: true,
    searchFields: { title: true, abstract: true, keywords: true },
    blocks: [
      { id: "required", name: "Study", terms: ["virtual reality"] },
      { id: "excluded", name: "Study", terms: ["review"], exclude: true },
    ],
    operators: ["AND"],
  };
  const matcher = createBlockMatcher(config);
  const kept: ScreeningRow[] = [];
  const excluded: ScreeningRow[] = [];
  metadata.retainedRecords.forEach((record) => {
    const title = record.fields.title || "";
    const abstract = record.fields.abstract || "";
    const keywords = record.fields.keywords || "";
    const blockResults = matcher({ title, abstract, keywords }, config.searchFields);
    const decision = classifyBlockResults(blockResults, true);
    const row: ScreeningRow = {
      RecordId: record.internalId,
      CiteKey: record.citekey,
      Title: title,
      Authors: record.fields.author || "",
      Year: "",
      Venue: "",
      URL: record.fields.doi || "",
      TitleRaw: title,
      AbstractRaw: abstract,
      KeywordsRaw: keywords,
      BlockResults: blockResults,
      MatchedBlocks: blockResults.filter((result) => result.matched).map((result) => result.blockName).join("; "),
      MatchedTermsDetail: "",
      PrimaryExclusionReason: decision.primaryReason,
      AllExclusionReasons: decision.reasons.map((reason) => reason.message).join(" | "),
      Evidence: decision.reasons.map((reason) => reason.evidence).join(" | "),
      ExclusionReasons: decision.reasons,
    };
    (decision.kept ? kept : excluded).push(row);
  });
  return {
    sourceName: "Example library.bib",
    runAt: "2026-08-03T12:34:56.000Z",
    signature: "test-signature",
    entryHeaders: parsed.discoveredHeaders,
    validatedRecords: parsed.records,
    diagnostics: parsed.diagnostics,
    duplicateGroups: groups,
    duplicateDecisions: dedup.decisionAudit,
    afterDeduplication: dedup.records,
    metadataRequiredFields: ["title", "author"],
    metadataRemovals: metadata.removals,
    afterMetadata: metadata.retainedRecords,
    queryExpression: generateBooleanQuery(config),
    queryBlocks: config.blocks,
    searchFields: config.searchFields,
    caseInsensitive: config.caseInsensitive,
    kept,
    excluded,
    keptRecords: metadata.retainedRecords.filter((record) => kept.some((row) => row.RecordId === record.internalId)),
    termCounts: [{ term: "virtual reality", count: 1 }],
  };
}

const SHEETS = ["Overview", "Import Summary", "Validated Records", "Import Diagnostics", "Dedup Summary", "Dedup Decisions", "After Dedup", "Metadata Summary", "Metadata Removals", "After Metadata", "Screening Summary", "Screening Records", "Kept Records", "Excluded Records", "Exclusion Summary", "Full-Text Assessment", "Full-Text Summary", "Assessment Lists", "Query Configuration", "Term Statistics", "CiteKey Mapping"];

test("builds a fixed, filterable workbook with reconciled record states", async () => {
  const bytes = await buildPrismaWorkbook(snapshot());
  assert.ok(bytes.byteLength > 0);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), SHEETS);
  assert.equal(workbook.getWorksheet("Validated Records")?.rowCount, 8);
  assert.equal(workbook.getWorksheet("After Dedup")?.rowCount, 7);
  assert.equal(workbook.getWorksheet("After Metadata")?.rowCount, 6);
  assert.ok(workbook.getWorksheet("Screening Records")?.autoFilter);
  assert.equal(workbook.getWorksheet("Screening Records")?.views[0]?.state, "frozen");
  assert.match(String(workbook.getWorksheet("Screening Records")?.getCell("A1").value), /Screening Decisions/);
  assert.equal(workbook.getWorksheet("Dedup Summary")?.getCell("C8").value, 1);
  assert.deepEqual(["D16", "D17", "D18"].map((cell) => workbook.getWorksheet("Overview")?.getCell(cell).value), ["PASS", "PASS", "PASS"]);
  const assessment = workbook.getWorksheet("Full-Text Assessment")!;
  assert.equal(assessment.rowCount, 5);
  assert.equal(assessment.getCell("A5").value, snapshot().keptRecords[0].internalId);
  assert.equal(assessment.getCell("I5").value, "Not assessed");
  assert.deepEqual(assessment.getCell("I5").dataValidation.formulae, ["FullTextDecisions"]);
  assert.deepEqual(assessment.getCell("J5").dataValidation.formulae, ["FullTextExclusionReasons"]);
  assert.equal(assessment.getCell("L5").dataValidation.type, "date");
  assert.equal(((assessment.model as unknown as { conditionalFormattings: unknown[] }).conditionalFormattings || []).length, 2);
  assert.match(String((assessment.getCell("N5").value as { formula: string }).formula), /Reviewer required/);
  assert.equal((assessment.getCell("N5").value as { result: string }).result, "Pending");
  assert.deepEqual(workbook.definedNames.getRanges("FullTextDecisions").ranges, ["'Assessment Lists'!$A$5:$A$8"]);
  assert.deepEqual(workbook.definedNames.getRanges("FullTextExclusionReasons").ranges, ["'Assessment Lists'!$C$5:$C$104"]);
  assert.equal(workbook.getWorksheet("Assessment Lists")?.getCell("C5").value, "");
  assert.equal((workbook.getWorksheet("Full-Text Summary")?.getCell("C6").value as { result: number }).result, 1);
  assert.match((workbook.getWorksheet("Full-Text Summary")?.getCell("C13").value as { formula: string }).formula, /COUNTIF\('Full-Text Assessment'/);
  assert.equal((workbook.getWorksheet("Overview")?.getCell("C23").value as { result: number }).result, 1);
  assert.equal(workbook.getWorksheet("Exclusion Summary")?.rowCount, 5);
});

test("preserves text-like formulas, duplicate block labels, empty sheets, and long BibTeX", async () => {
  const data = snapshot();
  data.validatedRecords[0] = { ...data.validatedRecords[0], fields: { ...data.validatedRecords[0].fields, note: "x".repeat(65_000) } };
  data.termCounts = [];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildPrismaWorkbook(data));
  const validated = workbook.getWorksheet("Validated Records")!;
  assert.equal(validated.getCell("D5").value, "=Formula-like virtual reality study");
  const bibHeaders = validated.getRow(4).values as unknown[];
  assert.ok(bibHeaders.filter((value) => String(value).startsWith("BibTeX Part")).length >= 3);
  const screeningHeaders = (workbook.getWorksheet("Screening Records")!.getRow(4).values as unknown[]).map(String);
  assert.ok(screeningHeaders.includes("B1 Study — Status"));
  assert.ok(screeningHeaders.includes("B2 Study — Status"));
  assert.match(String(workbook.getWorksheet("Term Statistics")?.getCell("A5").value), /No configured terms matched/);
  assert.equal(workbook.getWorksheet("CiteKey Mapping")?.getCell("D5").value, "No");
});

test("creates a sanitized timestamped workbook filename", () => {
  assert.equal(prismaWorkbookFilename("Example library.bib", "2026-08-03T12:34:56.000Z"), "prisma_audit_Example_library_20260803_123456Z.xlsx");
});

test("classifies manual assessment completeness consistently with workbook formulas", () => {
  const status = (decision: "Not assessed" | "Include" | "Exclude" | "Unclear", primaryExclusionReason = "", reviewer = "", assessmentDate = "") => fullTextAssessmentCompleteness({ decision, primaryExclusionReason, reviewer, assessmentDate });
  assert.equal(status("Not assessed"), "Pending");
  assert.equal(status("Unclear"), "Needs resolution");
  assert.equal(status("Include"), "Reviewer required");
  assert.equal(status("Include", "", "Reviewer"), "Date required");
  assert.equal(status("Exclude", "", "Reviewer", "2026-08-03"), "Reason required");
  assert.equal(status("Include", "Wrong population", "Reviewer", "2026-08-03"), "Remove exclusion reason");
  assert.equal(status("Include", "", "Reviewer", "2026-08-03"), "Complete");
  assert.equal(status("Exclude", "Wrong population", "Reviewer", "2026-08-03"), "Complete");
});

test("creates an empty assessment workspace when no records were kept", async () => {
  const data = snapshot();
  data.kept = [];
  data.keptRecords = [];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildPrismaWorkbook(data));
  assert.match(String(workbook.getWorksheet("Full-Text Assessment")?.getCell("A5").value), /No records were kept/);
  assert.equal(workbook.getWorksheet("Full-Text Summary")?.getCell("C5").value, 0);
  assert.equal(Number((workbook.getWorksheet("Full-Text Summary")?.getCell("C6").value as { result: string | number }).result), 0);
});

test("generates a thousand-record audit workbook within a practical browser-export budget", { timeout: 60_000 }, async () => {
  const data = snapshot();
  const recordTemplate = data.afterMetadata[0];
  const rowTemplate = data.kept[0];
  assert.ok(recordTemplate && rowTemplate);
  const records = Array.from({ length: 1_000 }, (_, index) => ({ ...recordTemplate, internalId: `performance-record-${index + 1}`, citekey: `performance${index + 1}` }));
  const rows = records.map((record) => ({ ...rowTemplate, RecordId: record.internalId, CiteKey: record.citekey }));
  data.entryHeaders = records.length;
  data.validatedRecords = records;
  data.diagnostics = [];
  data.duplicateGroups = [];
  data.duplicateDecisions = [];
  data.afterDeduplication = records;
  data.metadataRemovals = [];
  data.afterMetadata = records;
  data.kept = rows;
  data.excluded = [];
  data.keptRecords = records;
  data.termCounts = [{ term: "virtual reality", count: records.length }];
  const started = performance.now();
  const bytes = await buildPrismaWorkbook(data);
  assert.ok(bytes.byteLength > 100_000);
  assert.ok(performance.now() - started < 30_000);
});
