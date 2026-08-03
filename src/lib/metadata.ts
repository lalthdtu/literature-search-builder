import type { BibtexRecord } from "./bibtex.ts";
import { csvEscape } from "./screening.ts";

export const CANONICAL_METADATA_FIELDS = ["title", "author", "year", "abstract", "keywords", "doi", "venue"] as const;
export type CanonicalMetadataField = (typeof CANONICAL_METADATA_FIELDS)[number];
export type MetadataRequirements = { requiredFields: CanonicalMetadataField[]; confirmed: boolean };

export const METADATA_FIELD_LABELS: Record<CanonicalMetadataField, string> = {
  title: "Title",
  author: "Author",
  year: "Year",
  abstract: "Abstract",
  keywords: "Keywords",
  doi: "DOI",
  venue: "Venue",
};

const FIELD_ALIASES: Record<CanonicalMetadataField, string[]> = {
  title: ["title"],
  author: ["author"],
  year: ["year"],
  abstract: ["abstract", "abs", "summary"],
  keywords: ["keywords", "keyword", "author_keywords"],
  doi: ["doi"],
  venue: ["journal", "booktitle"],
};

function hasMeaningfulValue(value: string) {
  return value.replace(/[{}\s]/g, "").length > 0;
}

export function canonicalMetadataValue(record: BibtexRecord, field: CanonicalMetadataField) {
  return FIELD_ALIASES[field].map((alias) => record.fields[alias] || "").find(hasMeaningfulValue) || "";
}

export function missingRequiredFields(record: BibtexRecord, requiredFields: CanonicalMetadataField[]) {
  const required = new Set(requiredFields);
  return CANONICAL_METADATA_FIELDS.filter((field) => required.has(field) && !canonicalMetadataValue(record, field));
}

export type MetadataRemoval = {
  record: BibtexRecord;
  requiredFields: CanonicalMetadataField[];
  missingFields: CanonicalMetadataField[];
  primaryMissingField: CanonicalMetadataField;
};

export type MetadataCleanupResult = {
  retainedRecords: BibtexRecord[];
  removals: MetadataRemoval[];
};

export function applyMetadataRequirements(records: BibtexRecord[], requiredFields: CanonicalMetadataField[]): MetadataCleanupResult {
  const retainedRecords: BibtexRecord[] = [];
  const removals: MetadataRemoval[] = [];
  records.forEach((record) => {
    const missingFields = missingRequiredFields(record, requiredFields);
    if (!missingFields.length) retainedRecords.push(record);
    else removals.push({ record, requiredFields: [...requiredFields], missingFields, primaryMissingField: missingFields[0] });
  });
  return { retainedRecords, removals };
}

export type MetadataFieldCounts = Record<CanonicalMetadataField, { present: number; missing: number }>;

export function calculateMetadataFieldCounts(records: BibtexRecord[]): MetadataFieldCounts {
  return Object.fromEntries(CANONICAL_METADATA_FIELDS.map((field) => {
    const present = records.filter((record) => !!canonicalMetadataValue(record, field)).length;
    return [field, { present, missing: records.length - present }];
  })) as MetadataFieldCounts;
}

export function groupMetadataRemovals(removals: MetadataRemoval[]) {
  const groups = new Map<string, MetadataRemoval[]>();
  removals.forEach((removal) => {
    const key = removal.missingFields.join("|");
    groups.set(key, [...(groups.get(key) || []), removal]);
  });
  return [...groups.entries()].map(([key, rows]) => ({ key, missingFields: rows[0].missingFields, rows }));
}

export function toMetadataRemovalsCSV(removals: MetadataRemoval[]) {
  const headers = ["RecordId", "CiteKey", "EntryType", "Title", "Author", "Year", "Venue", "DOI", "Decision", "Stage", "DecisionMethod", "RequiredFields", "PrimaryMissingField", "AllMissingFields"];
  const body = removals.map(({ record, requiredFields, missingFields, primaryMissingField }) => [
    record.internalId,
    record.citekey,
    record.entryType,
    canonicalMetadataValue(record, "title"),
    canonicalMetadataValue(record, "author"),
    canonicalMetadataValue(record, "year"),
    canonicalMetadataValue(record, "venue"),
    canonicalMetadataValue(record, "doi"),
    "removed",
    "pre_screening_cleanup",
    "automatic",
    requiredFields.map((field) => METADATA_FIELD_LABELS[field]).join(" | "),
    METADATA_FIELD_LABELS[primaryMissingField],
    missingFields.map((field) => METADATA_FIELD_LABELS[field]).join(" | "),
  ].map(csvEscape).join(","));
  return [headers.join(","), ...body].join("\n");
}
