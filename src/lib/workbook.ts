import type { BibtexDiagnostic, BibtexRecord } from "./bibtex.ts";
import { buildBibEntry } from "./bibtex.ts";
import type { DuplicateDecisionAuditRow, DuplicateGroup } from "./deduplication.ts";
import { buildUniqueBibtex } from "./deduplication.ts";
import type { CanonicalMetadataField, MetadataRemoval } from "./metadata.ts";
import { CANONICAL_METADATA_FIELDS, METADATA_FIELD_LABELS, calculateMetadataFieldCounts, canonicalMetadataValue, groupMetadataRemovals } from "./metadata.ts";
import type { ScreeningField, ScreeningRow } from "./screening.ts";
import { summarizeExclusions } from "./screening.ts";
import type { QueryBlock } from "./workflow.ts";

export type WorkbookRunSnapshot = {
  sourceName: string;
  runAt: string;
  signature: string;
  entryHeaders: number;
  validatedRecords: BibtexRecord[];
  diagnostics: BibtexDiagnostic[];
  duplicateGroups: DuplicateGroup[];
  duplicateDecisions: DuplicateDecisionAuditRow[];
  afterDeduplication: BibtexRecord[];
  metadataRequiredFields: CanonicalMetadataField[];
  metadataRemovals: MetadataRemoval[];
  afterMetadata: BibtexRecord[];
  queryExpression: string;
  queryBlocks: QueryBlock[];
  searchFields: Record<ScreeningField, boolean>;
  caseInsensitive: boolean;
  kept: ScreeningRow[];
  excluded: ScreeningRow[];
  keptRecords: BibtexRecord[];
  termCounts: Array<{ term: string; count: number }>;
};

export type FullTextDecision = "Not assessed" | "Include" | "Exclude" | "Unclear";

export type FullTextAssessmentRow = {
  record: BibtexRecord;
  decision: FullTextDecision;
  primaryExclusionReason: string;
  reviewer: string;
  assessmentDate: string;
  notes: string;
};

type TrustedFormula = { formula: string; result: string | number | boolean };
type CellValue = string | number | TrustedFormula;
type TableRow = CellValue[];

const XLSX_MAX_ROWS = 1_048_576;
const DATA_START_ROW = 5;
const MAX_TABLE_ROWS = XLSX_MAX_ROWS - DATA_START_ROW;
const BIBTEX_CHUNK_SIZE = 30_000;
const STAGE_COLOURS = {
  overview: "1E3A5F",
  import: "2563EB",
  dedup: "7C3AED",
  metadata: "D97706",
  screening: "047857",
  fullText: "9F1239",
  audit: "475569",
};

const FULL_TEXT_DECISIONS: FullTextDecision[] = ["Not assessed", "Include", "Exclude", "Unclear"];
const ASSESSMENT_REASON_SLOTS = 100;

function columnLetter(column: number) {
  let value = column;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function asText(value: unknown) {
  if (isTrustedFormula(value)) return String(value.result);
  return value == null ? "" : String(value);
}

function isTrustedFormula(value: unknown): value is TrustedFormula {
  return !!value && typeof value === "object" && "formula" in value && typeof (value as TrustedFormula).formula === "string";
}

function formula(expression: string, result: TrustedFormula["result"]): TrustedFormula {
  return { formula: expression, result: result === 0 ? "0" : result };
}

export function fullTextAssessmentCompleteness(input: Pick<FullTextAssessmentRow, "decision" | "primaryExclusionReason" | "reviewer" | "assessmentDate">) {
  if (input.decision === "Not assessed") return "Pending";
  if (input.decision === "Unclear") return "Needs resolution";
  if (!input.reviewer.trim()) return "Reviewer required";
  if (!input.assessmentDate.trim()) return "Date required";
  if (input.decision === "Exclude" && !input.primaryExclusionReason.trim()) return "Reason required";
  if (input.decision !== "Exclude" && input.primaryExclusionReason.trim()) return "Remove exclusion reason";
  return "Complete";
}

function splitBibtex(value: string) {
  if (!value) return [""];
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += BIBTEX_CHUNK_SIZE) parts.push(value.slice(index, index + BIBTEX_CHUNK_SIZE));
  return parts;
}

function recordValues(record: BibtexRecord) {
  return [
    record.internalId,
    record.citekey,
    record.entryType,
    canonicalMetadataValue(record, "title"),
    canonicalMetadataValue(record, "author"),
    canonicalMetadataValue(record, "year"),
    canonicalMetadataValue(record, "venue"),
    canonicalMetadataValue(record, "doi"),
    record.fields.url || (record.fields.doi ? `https://doi.org/${record.fields.doi}` : ""),
    canonicalMetadataValue(record, "abstract"),
    canonicalMetadataValue(record, "keywords"),
    record.line,
    record.range.startLine,
    record.range.endLine,
  ] satisfies TableRow;
}

const RECORD_HEADERS = ["RecordId", "OriginalCiteKey", "EntryType", "Title", "Author", "Year", "Venue", "DOI", "URL", "Abstract", "Keywords", "SourceLine", "SourceStartLine", "SourceEndLine"];

function withBibtex(headers: string[], rows: Array<{ values: TableRow; bibtex: string }>) {
  const parts = Math.max(1, ...rows.map((row) => splitBibtex(row.bibtex).length));
  return {
    headers: [...headers, ...Array.from({ length: parts }, (_, index) => `BibTeX Part ${index + 1}`)],
    rows: rows.map((row) => [...row.values, ...splitBibtex(row.bibtex), ...Array.from({ length: parts - splitBibtex(row.bibtex).length }, () => "")]),
  };
}

function assertRowLimit(sheetName: string, rows: number) {
  if (rows > MAX_TABLE_ROWS) throw new Error(`${sheetName} contains ${rows.toLocaleString()} rows, which exceeds the Excel worksheet limit. Reduce the input library before exporting.`);
}

function tableSheet(
  workbook: import("exceljs").Workbook,
  name: string,
  title: string,
  description: string,
  headers: string[],
  rows: TableRow[],
  colour: string,
  emptyMessage = "No records or decisions for this run."
) {
  assertRowLimit(name, rows.length);
  const worksheet = workbook.addWorksheet(name, { properties: { tabColor: { argb: colour } } });
  const lastColumn = columnLetter(Math.max(1, headers.length));
  worksheet.mergeCells(`A1:${lastColumn}1`);
  worksheet.getCell("A1").value = title;
  worksheet.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFFFFF" } };
  worksheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: colour } };
  worksheet.getCell("A1").alignment = { vertical: "middle" };
  worksheet.getRow(1).height = 26;
  worksheet.mergeCells(`A2:${lastColumn}2`);
  worksheet.getCell("A2").value = description;
  worksheet.getCell("A2").font = { italic: true, color: { argb: "475569" } };
  worksheet.getCell("A2").alignment = { wrapText: true, vertical: "top" };
  worksheet.getRow(2).height = 32;
  worksheet.addRow([]);
  const headerRow = worksheet.addRow(headers);
  headerRow.font = { bold: true, color: { argb: "FFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colour } };
  headerRow.alignment = { wrapText: true, vertical: "middle" };
  headerRow.height = 30;

  if (rows.length) {
    rows.forEach((values, rowIndex) => {
      const row = worksheet.addRow(values.map((value) => typeof value === "number" || isTrustedFormula(value) ? value : asText(value)));
      row.alignment = { vertical: "top", wrapText: true };
      if (rowIndex % 2 === 1) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "F8FAFC" } };
      row.eachCell((cell) => {
        if (typeof cell.value === "string") cell.numFmt = "@";
      });
    });
  } else {
    worksheet.addRow([emptyMessage]);
    worksheet.mergeCells(`A5:${lastColumn}5`);
    worksheet.getCell("A5").font = { italic: true, color: { argb: "64748B" } };
  }

  worksheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: Math.max(4, 4 + rows.length), column: headers.length } };
  worksheet.views = [{ state: "frozen", ySplit: 4, activeCell: "A5" }];
  headers.forEach((header, index) => {
    const values = rows.slice(0, 200).map((row) => asText(row[index]));
    const longest = Math.max(header.length + 2, ...values.map((value) => Math.min(value.length + 2, 45)));
    const semanticWidth = /Abstract|BibTeX|Evidence|Reason|Expression|Guidance|Description|Provenance/i.test(header) ? 42 : /Title|Author|Terms/i.test(header) ? 28 : 18;
    worksheet.getColumn(index + 1).width = Math.min(50, Math.max(longest, semanticWidth));
  });
  return worksheet;
}

function summaryRows(sections: Array<[string, CellValue, CellValue, CellValue?]>) {
  return sections.map(([section, metric, value, status = ""]) => [section, metric, value, status] satisfies TableRow);
}

function stateSheet(workbook: import("exceljs").Workbook, name: string, title: string, description: string, records: BibtexRecord[], colour: string) {
  const data = withBibtex(RECORD_HEADERS, records.map((record) => ({ values: recordValues(record), bibtex: buildBibEntry(record) })));
  return tableSheet(workbook, name, title, description, data.headers, data.rows, colour);
}

function screeningTable(snapshot: WorkbookRunSnapshot, rows: ScreeningRow[], outcome?: "kept" | "excluded") {
  const byId = new Map(snapshot.afterMetadata.map((record) => [record.internalId, record]));
  const blockHeaders = snapshot.queryBlocks.flatMap((block, index) => {
    const label = `B${index + 1} ${block.name.trim() || `Block ${index + 1}`}`;
    return [`${label} — Status`, `${label} — Matched Terms`, `${label} — Matched Fields`];
  });
  return withBibtex(
    [...RECORD_HEADERS, "Outcome", "PrimaryExclusionReason", "AllExclusionReasons", "Evidence", "MatchedBlocks", "MatchedTermsDetail", ...blockHeaders],
    rows.map((row) => {
      const record = byId.get(row.RecordId);
      if (!record) throw new Error(`Screening record '${row.RecordId}' is missing from the completed-run snapshot.`);
      const resultById = new Map(row.BlockResults.map((result) => [result.blockId, result]));
      const blockValues = snapshot.queryBlocks.flatMap((block) => {
        const result = resultById.get(block.id);
        const terms = result ? [...new Set(Object.values(result.hits).flatMap((values) => values || []))] : [];
        const fields = result ? (Object.keys(result.hits) as ScreeningField[]).filter((field) => result.hits[field]?.length) : [];
        return [result?.matched ? "Matched" : "Not matched", terms.join(" | "), fields.join(" | ")];
      });
      return {
        values: [
          ...recordValues(record),
          outcome || (row.PrimaryExclusionReason ? "excluded" : "kept"),
          row.PrimaryExclusionReason,
          row.AllExclusionReasons,
          row.Evidence,
          row.MatchedBlocks,
          row.MatchedTermsDetail,
          ...blockValues,
        ],
        bibtex: buildBibEntry(record),
      };
    })
  );
}

function fullTextRange(column: string, rowCount: number) {
  return `'Full-Text Assessment'!$${column}$5:$${column}$${Math.max(5, rowCount + 4)}`;
}

function createFullTextAssessmentSheet(workbook: import("exceljs").Workbook, records: BibtexRecord[]) {
  const rows: FullTextAssessmentRow[] = records.map((record) => ({
    record,
    decision: "Not assessed",
    primaryExclusionReason: "",
    reviewer: "",
    assessmentDate: "",
    notes: "",
  }));
  const data = withBibtex(
    ["RecordId", "OriginalCiteKey", "Title", "Author", "Year", "Venue", "DOI", "URL", "FullTextDecision", "PrimaryFullTextExclusionReason", "Reviewer", "AssessmentDate", "Notes", "AssessmentCompleteness", "EntryType", "Abstract", "Keywords", "SourceLine", "SourceStartLine", "SourceEndLine"],
    rows.map((item, index) => {
      const rowNumber = index + DATA_START_ROW;
      const completeness = `IF(I${rowNumber}="Not assessed","Pending",IF(I${rowNumber}="Unclear","Needs resolution",IF(K${rowNumber}="","Reviewer required",IF(L${rowNumber}="","Date required",IF(AND(I${rowNumber}="Exclude",J${rowNumber}=""),"Reason required",IF(AND(I${rowNumber}<>"Exclude",J${rowNumber}<>""),"Remove exclusion reason","Complete"))))))`;
      return {
        values: [
          item.record.internalId,
          item.record.citekey,
          canonicalMetadataValue(item.record, "title"),
          canonicalMetadataValue(item.record, "author"),
          canonicalMetadataValue(item.record, "year"),
          canonicalMetadataValue(item.record, "venue"),
          canonicalMetadataValue(item.record, "doi"),
          item.record.fields.url || (item.record.fields.doi ? `https://doi.org/${item.record.fields.doi}` : ""),
          item.decision,
          item.primaryExclusionReason,
          item.reviewer,
          item.assessmentDate,
          item.notes,
          formula(completeness, fullTextAssessmentCompleteness(item)),
          item.record.entryType,
          canonicalMetadataValue(item.record, "abstract"),
          canonicalMetadataValue(item.record, "keywords"),
          item.record.line,
          item.record.range.startLine,
          item.record.range.endLine,
        ],
        bibtex: buildBibEntry(item.record),
      };
    })
  );
  const worksheet = tableSheet(workbook, "Full-Text Assessment", "Manual Full-Text Assessment", "Complete this worksheet in Excel. Populate project-specific exclusion reasons on Assessment Lists first; manual edits are not imported into the web application.", data.headers, data.rows, STAGE_COLOURS.fullText, "No records were kept for manual full-text assessment.");

  if (rows.length) {
    const lastRow = rows.length + 4;
    for (let rowNumber = DATA_START_ROW; rowNumber <= lastRow; rowNumber++) {
      for (let column = 9; column <= 13; column++) worksheet.getCell(rowNumber, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FEF3C7" } };
      worksheet.getCell(rowNumber, 9).dataValidation = {
        type: "list",
        allowBlank: false,
        formulae: ["FullTextDecisions"],
        showInputMessage: true,
        promptTitle: "Full-text decision",
        prompt: "Choose Not assessed, Include, Exclude, or Unclear.",
        showErrorMessage: true,
        errorStyle: "stop",
        errorTitle: "Invalid decision",
        error: "Choose a value from the decision list.",
      };
      worksheet.getCell(rowNumber, 10).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ["FullTextExclusionReasons"],
        showInputMessage: true,
        promptTitle: "Primary exclusion reason",
        prompt: "Choose a project-specific reason from Assessment Lists when the decision is Exclude.",
        showErrorMessage: true,
        errorStyle: "stop",
        errorTitle: "Unknown reason",
        error: "Choose a reason configured on Assessment Lists.",
      };
      worksheet.getCell(rowNumber, 12).dataValidation = {
        type: "date",
        operator: "between",
        allowBlank: true,
        formulae: [new Date(1900, 0, 1), new Date(2100, 11, 31)],
        showErrorMessage: true,
        errorStyle: "stop",
        errorTitle: "Invalid date",
        error: "Enter an assessment date between 1900-01-01 and 2100-12-31.",
      };
      worksheet.getCell(rowNumber, 12).numFmt = "yyyy-mm-dd";
    }
    worksheet.addConditionalFormatting({
      ref: `I5:I${lastRow}`,
      rules: [
        { type: "expression", priority: 1, formulae: ['$I5="Include"'], style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "DCFCE7" } }, font: { color: { argb: "166534" }, bold: true } } },
        { type: "expression", priority: 2, formulae: ['$I5="Exclude"'], style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FEE2E2" } }, font: { color: { argb: "991B1B" }, bold: true } } },
        { type: "expression", priority: 3, formulae: ['$I5="Unclear"'], style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FEF3C7" } }, font: { color: { argb: "92400E" }, bold: true } } },
      ],
    });
    worksheet.addConditionalFormatting({
      ref: `N5:N${lastRow}`,
      rules: [
        { type: "expression", priority: 1, formulae: ['$N5="Complete"'], style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "DCFCE7" } }, font: { color: { argb: "166534" }, bold: true } } },
        { type: "expression", priority: 2, formulae: ['$N5="Pending"'], style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "E2E8F0" } } } },
        { type: "expression", priority: 3, formulae: ['$N5="Needs resolution"'], style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FEF3C7" } } } },
        { type: "expression", priority: 4, formulae: ['OR(ISNUMBER(SEARCH("required",$N5)),$N5="Remove exclusion reason")'], style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FEE2E2" } }, font: { color: { argb: "991B1B" }, bold: true } } },
      ],
    });
  }
  return worksheet;
}

function createFullTextSummarySheet(workbook: import("exceljs").Workbook, keptCount: number) {
  const decisionRange = fullTextRange("I", keptCount);
  const reasonRange = fullTextRange("J", keptCount);
  const completenessRange = fullTextRange("N", keptCount);
  const decisionCount = (decision: FullTextDecision, initial: number) => formula(`COUNTIF(${decisionRange},"${decision}")`, initial);
  const totalFormula = `COUNTIF(${decisionRange},"Not assessed")+COUNTIF(${decisionRange},"Include")+COUNTIF(${decisionRange},"Exclude")+COUNTIF(${decisionRange},"Unclear")`;
  const rows: Array<[string, CellValue, CellValue, CellValue?]> = [
    ["Input", "Records provided for full-text assessment", keptCount],
    ["Decisions", "Not assessed", decisionCount("Not assessed", keptCount)],
    ["Decisions", "Include", decisionCount("Include", 0)],
    ["Decisions", "Exclude", decisionCount("Exclude", 0)],
    ["Decisions", "Unclear", decisionCount("Unclear", 0)],
    ["Progress", "Completed final decisions", formula(`COUNTIF(${decisionRange},"Include")+COUNTIF(${decisionRange},"Exclude")`, 0)],
    ["Progress", "Unresolved or incomplete", formula(`COUNTIF(${completenessRange},"Pending")+COUNTIF(${completenessRange},"Needs resolution")+COUNTIF(${completenessRange},"*required")+COUNTIF(${completenessRange},"Remove exclusion reason")`, keptCount)],
    ["Reconciliation", "Kept records = all assessment states", formula(totalFormula, keptCount), formula(`IF(${totalFormula}=${keptCount},"PASS","REVIEW")`, "PASS")],
    ...Array.from({ length: ASSESSMENT_REASON_SLOTS }, (_, index) => {
      const summaryRow = index + 13;
      const listRow = index + DATA_START_ROW;
      return ["Full-text exclusion reasons", formula(`'Assessment Lists'!C${listRow}`, ""), formula(`IF(B${summaryRow}="","",COUNTIF(${reasonRange},B${summaryRow}))`, ""), ""] as [string, CellValue, CellValue, CellValue];
    }),
  ];
  return tableSheet(workbook, "Full-Text Summary", "Manual Full-Text Assessment Summary", "Live formulas update when decisions are entered on Full-Text Assessment. These report-level manual outcomes remain separate from automatic screening exclusions.", ["Section", "Metric", "Value", "Status"], summaryRows(rows), STAGE_COLOURS.fullText);
}

function createAssessmentListsSheet(workbook: import("exceljs").Workbook) {
  const rows = Array.from({ length: ASSESSMENT_REASON_SLOTS }, (_, index) => [FULL_TEXT_DECISIONS[index] || "", index + 1, ""] satisfies TableRow);
  const worksheet = tableSheet(workbook, "Assessment Lists", "Assessment Lists", "Enter project-specific primary full-text exclusion reasons in the yellow cells. The assessment dropdown and live reason summary use these 100 slots.", ["DecisionValues", "ReasonPosition", "FullTextExclusionReasons"], rows, STAGE_COLOURS.fullText);
  for (let rowNumber = DATA_START_ROW; rowNumber < DATA_START_ROW + ASSESSMENT_REASON_SLOTS; rowNumber++) worksheet.getCell(rowNumber, 3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FEF3C7" } };
  workbook.definedNames.add("'Assessment Lists'!$A$5:$A$8", "FullTextDecisions");
  workbook.definedNames.add(`'Assessment Lists'!$C$5:$C$${ASSESSMENT_REASON_SLOTS + 4}`, "FullTextExclusionReasons");
  return worksheet;
}

export function prismaWorkbookFilename(sourceName: string, runAt: string) {
  const source = (sourceName || "literature_search").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "literature_search";
  const timestamp = runAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "_");
  return `prisma_audit_${source}_${timestamp}.xlsx`;
}

export async function buildPrismaWorkbook(snapshot: WorkbookRunSnapshot): Promise<ArrayBuffer> {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Literature Screening Workflow";
  workbook.created = new Date(snapshot.runAt);
  workbook.modified = new Date(snapshot.runAt);
  workbook.subject = "PRISMA-oriented screening audit with an offline manual full-text assessment template";
  workbook.title = `PRISMA audit — ${snapshot.sourceName || "BibTeX library"}`;
  workbook.calcProperties.fullCalcOnLoad = true;

  const duplicateRemoved = snapshot.validatedRecords.length - snapshot.afterDeduplication.length;
  const metadataRemoved = snapshot.metadataRemovals.length;
  const screened = snapshot.afterMetadata.length;
  const afterDedupExpected = snapshot.validatedRecords.length - duplicateRemoved;
  const screenedExpected = snapshot.afterDeduplication.length - metadataRemoved;
  const outcomeExpected = snapshot.kept.length + snapshot.excluded.length;
  const keepAllGroups = new Set(snapshot.duplicateDecisions.filter((row) => row.action === "kept_distinct").map((row) => row.groupId)).size;
  const mergedGroups = new Set(snapshot.duplicateDecisions.filter((row) => row.action === "canonical").map((row) => row.groupId)).size;
  const enrichedFields = snapshot.duplicateDecisions.filter((row) => row.action === "canonical").reduce((count, row) => count + row.enrichedFields.length, 0);
  const reasonSummary = summarizeExclusions(snapshot.excluded);
  const importCounts = calculateMetadataFieldCounts(snapshot.validatedRecords);
  const removalGroups = groupMetadataRemovals(snapshot.metadataRemovals);
  const selectedSearchFields = (Object.keys(snapshot.searchFields) as ScreeningField[]).filter((field) => snapshot.searchFields[field]);
  const manualDecisionRange = fullTextRange("I", snapshot.kept.length);

  tableSheet(workbook, "Overview", "PRISMA Audit Workbook", "Reconciled automatic cleanup and pre-full-text screening flow, followed by an editable workbook-only manual full-text assessment stage.", ["Section", "Metric", "Value", "Status"], summaryRows([
    ["Run", "Source", snapshot.sourceName || "Pasted BibTeX"],
    ["Run", "Completed at (UTC)", snapshot.runAt],
    ["Run", "Run signature", snapshot.signature],
    ["PRISMA flow", "Entry headers discovered", snapshot.entryHeaders],
    ["PRISMA flow", "Structurally valid records", snapshot.validatedRecords.length],
    ["PRISMA flow", "Duplicate records removed", duplicateRemoved],
    ["PRISMA flow", "Records after deduplication", snapshot.afterDeduplication.length],
    ["PRISMA flow", "Records removed for required metadata", metadataRemoved],
    ["PRISMA flow", "Records screened", screened],
    ["PRISMA flow", "Kept for next step", snapshot.kept.length],
    ["PRISMA flow", "Excluded by automatic screening", snapshot.excluded.length],
    ["Reconciliation", "Valid − duplicates = after deduplication", `${afterDedupExpected} expected / ${snapshot.afterDeduplication.length} actual`, afterDedupExpected === snapshot.afterDeduplication.length ? "PASS" : "REVIEW"],
    ["Reconciliation", "After deduplication − metadata removed = screened", `${screenedExpected} expected / ${screened} actual`, screenedExpected === screened ? "PASS" : "REVIEW"],
    ["Reconciliation", "Screened = kept + excluded", `${outcomeExpected} outcomes / ${screened} screened`, outcomeExpected === screened ? "PASS" : "REVIEW"],
    ["Configuration", "Required metadata", snapshot.metadataRequiredFields.map((field) => METADATA_FIELD_LABELS[field]).join(" | ") || "None"],
    ["Configuration", "Search fields", selectedSearchFields.join(" | ")],
    ["Configuration", "Case-insensitive", snapshot.caseInsensitive ? "Yes" : "No"],
    ["Configuration", "Boolean expression", snapshot.queryExpression],
    ["Manual full-text", "Not assessed", formula(`COUNTIF(${manualDecisionRange},"Not assessed")`, snapshot.kept.length)],
    ["Manual full-text", "Include", formula(`COUNTIF(${manualDecisionRange},"Include")`, 0)],
    ["Manual full-text", "Exclude", formula(`COUNTIF(${manualDecisionRange},"Exclude")`, 0)],
    ["Manual full-text", "Unclear", formula(`COUNTIF(${manualDecisionRange},"Unclear")`, 0)],
    ["Workbook guide", "Record states", "Validated Records → After Dedup → After Metadata → Kept Records / Excluded Records → Full-Text Assessment"],
    ["Workbook guide", "Removal audits", "Dedup Decisions and Metadata Removals are pre-screening; Excluded Records contains automatic screening exclusions only; manual full-text outcomes remain separate."],
  ]), STAGE_COLOURS.overview);

  tableSheet(workbook, "Import Summary", "Import Summary", "Structural validation and canonical metadata availability in the completed import snapshot.", ["Section", "Metric", "Value", "Status"], summaryRows([
    ["Source", "Source name", snapshot.sourceName || "Pasted BibTeX"],
    ["Structure", "Entry headers", snapshot.entryHeaders],
    ["Structure", "Valid records", snapshot.validatedRecords.length],
    ["Diagnostics", "Warnings", snapshot.diagnostics.filter((item) => item.severity === "warning").length],
    ["Diagnostics", "Blocking errors", snapshot.diagnostics.filter((item) => item.severity === "error").length],
    ...CANONICAL_METADATA_FIELDS.flatMap((field) => [
      ["Metadata", `${METADATA_FIELD_LABELS[field]} present`, importCounts[field].present] as [string, string, CellValue],
      ["Metadata", `${METADATA_FIELD_LABELS[field]} missing`, importCounts[field].missing] as [string, string, CellValue],
    ]),
  ]), STAGE_COLOURS.import);

  stateSheet(workbook, "Validated Records", "Validated Records", "Every structurally valid record in the parsed import snapshot.", snapshot.validatedRecords, STAGE_COLOURS.import);
  tableSheet(workbook, "Import Diagnostics", "Import Diagnostics", "Source-positioned parser warnings and errors retained with the completed run.", ["Severity", "Code", "CiteKey", "Line", "StartLine", "EndLine", "StartOffset", "EndOffset", "Message", "RepairGuidance"], snapshot.diagnostics.map((item) => [item.severity, item.code, item.citekey || "", item.line, item.range.startLine, item.range.endLine, item.range.from, item.range.to, item.message, item.guidance]), STAGE_COLOURS.import, "No import diagnostics for this run.");

  tableSheet(workbook, "Dedup Summary", "Deduplication Summary", "Exact DOI/title candidate groups and their explicit manual resolutions.", ["Section", "Metric", "Value", "Status"], summaryRows([
    ["Input", "Validated records", snapshot.validatedRecords.length],
    ["Candidates", "Candidate groups", snapshot.duplicateGroups.length],
    ["Decisions", "Keep-all groups", keepAllGroups],
    ["Decisions", "Merged groups", mergedGroups],
    ["Outcome", "Duplicate records removed", duplicateRemoved],
    ["Enrichment", "Missing fields filled", enrichedFields],
    ["Outcome", "Records after deduplication", snapshot.afterDeduplication.length],
  ]), STAGE_COLOURS.dedup);

  const dedupData = withBibtex(
    ["GroupId", "MatchEvidence", "Action", "CanonicalRecordId", "CanonicalCiteKey", "EnrichedFields", "EnrichmentProvenance", "DecisionMethod", ...RECORD_HEADERS],
    snapshot.duplicateDecisions.map((item) => ({
      values: [item.groupId, item.evidence, item.action, item.canonicalRecordId, item.canonicalCiteKey, item.enrichedFields.join(" | "), item.enrichmentProvenance, item.decisionMethod, ...recordValues(item.record)],
      bibtex: buildBibEntry(item.record),
    }))
  );
  tableSheet(workbook, "Dedup Decisions", "Deduplication Decisions", "One row per candidate record, including keep-all, canonical, and removed-duplicate decisions.", dedupData.headers, dedupData.rows, STAGE_COLOURS.dedup, "No duplicate candidate groups for this run.");
  stateSheet(workbook, "After Dedup", "Records After Deduplication", "Canonical records after duplicate removals and missing-field enrichment.", snapshot.afterDeduplication, STAGE_COLOURS.dedup);

  tableSheet(workbook, "Metadata Summary", "Required Metadata Summary", "Record-level metadata requirements applied after duplicate enrichment.", ["Section", "Metric", "Value", "Status"], summaryRows([
    ["Configuration", "Required fields", snapshot.metadataRequiredFields.map((field) => METADATA_FIELD_LABELS[field]).join(" | ") || "None"],
    ["Input", "Records after deduplication", snapshot.afterDeduplication.length],
    ["Outcome", "Records removed", metadataRemoved],
    ["Outcome", "Records retained for screening", screened],
    ...removalGroups.map((group) => ["Missing-field combinations", group.missingFields.map((field) => METADATA_FIELD_LABELS[field]).join(" + "), group.rows.length] as [string, string, CellValue]),
  ]), STAGE_COLOURS.metadata);

  const metadataData = withBibtex(
    ["Decision", "Stage", "DecisionMethod", "RequiredFields", "PrimaryMissingField", "AllMissingFields", ...RECORD_HEADERS],
    snapshot.metadataRemovals.map((item) => ({
      values: ["removed", "pre_screening_cleanup", "automatic", item.requiredFields.map((field) => METADATA_FIELD_LABELS[field]).join(" | "), METADATA_FIELD_LABELS[item.primaryMissingField], item.missingFields.map((field) => METADATA_FIELD_LABELS[field]).join(" | "), ...recordValues(item.record)],
      bibtex: buildBibEntry(item.record),
    }))
  );
  tableSheet(workbook, "Metadata Removals", "Metadata Removals", "Canonical records removed automatically because required fields remained missing after enrichment.", metadataData.headers, metadataData.rows, STAGE_COLOURS.metadata, "No records were removed by the required metadata rules.");
  stateSheet(workbook, "After Metadata", "Records After Metadata Cleanup", "Complete dataset that reached automatic query screening.", snapshot.afterMetadata, STAGE_COLOURS.metadata);

  tableSheet(workbook, "Screening Summary", "Query and Screening Summary", "Exact block configuration and automatic pre-full-text screening outcomes.", ["Section", "Metric", "Value", "Status"], summaryRows([
    ["Configuration", "Boolean expression", snapshot.queryExpression],
    ["Configuration", "Search fields", selectedSearchFields.join(" | ")],
    ["Configuration", "Case-insensitive", snapshot.caseInsensitive ? "Yes" : "No"],
    ["Configuration", "Required blocks", snapshot.queryBlocks.filter((block) => !block.exclude).length],
    ["Configuration", "Exclusion blocks", snapshot.queryBlocks.filter((block) => block.exclude).length],
    ["Outcome", "Records screened", screened],
    ["Outcome", "Kept for next step", snapshot.kept.length],
    ["Outcome", "Excluded", snapshot.excluded.length],
    ...reasonSummary.map((item) => ["Primary exclusion reasons", item.reason, item.count] as [string, string, CellValue]),
  ]), STAGE_COLOURS.screening);

  const screeningOrder = new Map(snapshot.afterMetadata.map((record, index) => [record.internalId, index]));
  const allScreeningRows = [...snapshot.kept, ...snapshot.excluded].sort((left, right) => (screeningOrder.get(left.RecordId) || 0) - (screeningOrder.get(right.RecordId) || 0));
  const screeningData = screeningTable(snapshot, allScreeningRows);
  tableSheet(workbook, "Screening Records", "All Screening Decisions", "One row per screened record with outcome, ordered reasons, and block-level matching evidence.", screeningData.headers, screeningData.rows, STAGE_COLOURS.screening);
  const keptData = screeningTable(snapshot, snapshot.kept, "kept");
  tableSheet(workbook, "Kept Records", "Kept for the Next Step", "Records matching every required block and no exclusion block.", keptData.headers, keptData.rows, STAGE_COLOURS.screening, "No records were kept for the next step.");
  const excludedData = screeningTable(snapshot, snapshot.excluded, "excluded");
  tableSheet(workbook, "Excluded Records", "Automatically Excluded Records", "Records excluded during automatic pre-full-text screening, with primary and complete reasons.", excludedData.headers, excludedData.rows, STAGE_COLOURS.screening, "No records were excluded during screening.");
  tableSheet(workbook, "Exclusion Summary", "Primary Exclusion Reason Summary", "Each excluded record contributes exactly once using its first configured reason.", ["PrimaryExclusionReason", "Count"], reasonSummary.map((item) => [item.reason, item.count]), STAGE_COLOURS.screening, "No screening exclusion reasons for this run.");

  createFullTextAssessmentSheet(workbook, snapshot.keptRecords);
  createFullTextSummarySheet(workbook, snapshot.keptRecords.length);
  createAssessmentListsSheet(workbook);

  tableSheet(workbook, "Query Configuration", "Query Configuration", "Ordered authoritative screening blocks and terms used for this completed run.", ["BlockId", "Position", "Label", "BlockType", "TermMode", "TermPosition", "Term"], snapshot.queryBlocks.flatMap((block, blockIndex) => block.terms.map((term, termIndex) => [block.id, blockIndex + 1, block.name.trim() || `Block ${blockIndex + 1}`, block.exclude ? "exclusion" : "required", block.isRegex ? "regular_expression" : "literal_or_trailing_wildcard", termIndex + 1, term])), STAGE_COLOURS.audit);
  tableSheet(workbook, "Term Statistics", "Matched-Term Statistics", "Document counts for configured terms observed during screening.", ["Term", "MatchedDocumentCount"], snapshot.termCounts.map((item) => [item.term, item.count]), STAGE_COLOURS.audit, "No configured terms matched screened records.");
  const mapping = buildUniqueBibtex(snapshot.keptRecords).mapping;
  tableSheet(workbook, "CiteKey Mapping", "Kept BibTeX Cite-Key Mapping", "Original cite keys are preserved in workbook data; deterministic suffixes apply only to the kept .bib export.", ["RecordId", "OriginalCiteKey", "ExportCiteKey", "Changed"], mapping.map((item) => [item.recordId, item.originalCiteKey, item.exportCiteKey, item.originalCiteKey === item.exportCiteKey ? "No" : "Yes"]), STAGE_COLOURS.audit, "No kept records require cite-key mapping.");

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer).slice().buffer;
}
