import { sourceSignature, type BibtexParseResult } from "./bibtex.ts";
import type { DuplicateResolution } from "./deduplication.ts";
import { calculateMetadataFieldCounts, CANONICAL_METADATA_FIELDS, type CanonicalMetadataField, type MetadataFieldCounts, type MetadataRequirements } from "./metadata.ts";
import { normalizeOperators } from "./screening.ts";

export type SearchFields = { title: boolean; abstract: boolean; keywords: boolean };
export type QueryBlock = { id: string; name: string; terms: string[]; isRegex?: boolean; exclude?: boolean };
export type QueryConfig = {
  blocks: QueryBlock[];
  operators: Array<"AND" | "OR">;
  caseInsensitive: boolean;
  searchFields: SearchFields;
};

export type ImportSnapshot = {
  sourceSignature: string;
  parsed: BibtexParseResult;
  fieldCounts: MetadataFieldCounts;
};

export type WorkflowStatus = "not_started" | "needs_attention" | "ready" | "complete" | "out_of_date";

export type ProjectFileV2 = {
  kind: "literature-search-project";
  version: 2;
  sourceName: string;
  bibtex: string;
  sourceSignature: string;
  metadataRequirements: MetadataRequirements;
  queryString: string;
  queryConfig: QueryConfig;
  duplicateResolutions: Record<string, DuplicateResolution>;
};

type ProjectFileV1 = {
  kind: "literature-search-project";
  version: 1;
  sourceName: string;
  bibtex: string;
  sourceSignature: string;
  thresholds: { title: number; abstract: number; keywords: number };
  requirementsConfirmed: boolean;
  queryString: string;
  queryConfig: QueryConfig;
  duplicateResolutions: Record<string, DuplicateResolution>;
};

export function createImportSnapshot(source: string, parsed: BibtexParseResult): ImportSnapshot {
  return { sourceSignature: sourceSignature(source), parsed, fieldCounts: calculateMetadataFieldCounts(parsed.records) };
}

export function importReadiness(snapshot: ImportSnapshot | null, currentSource: string) {
  const reasons: string[] = [];
  if (!snapshot) reasons.push("Validate and parse the BibTeX source.");
  else {
    if (snapshot.sourceSignature !== sourceSignature(currentSource)) reasons.push("The BibTeX source changed; validate it again.");
    if (snapshot.parsed.hasBlockingErrors) reasons.push("Resolve all structural BibTeX errors.");
  }
  return { ready: reasons.length === 0, reasons };
}

export function validateQueryConfig(config: QueryConfig) {
  const errors: string[] = [];
  if (!Object.values(config.searchFields).some(Boolean)) errors.push("Select at least one searchable field.");
  if (!config.blocks.length) errors.push("Add at least one query block.");
  config.blocks.forEach((block, blockIndex) => {
    const name = block.name.trim() || `Block ${blockIndex + 1}`;
    if (!block.terms.length || block.terms.some((term) => !term.trim())) errors.push(`${name} contains an empty term.`);
    if (block.isRegex) block.terms.filter((term) => term.trim()).forEach((term) => {
      try { new RegExp(term, config.caseInsensitive ? "i" : ""); }
      catch (error) { errors.push(`${name} contains invalid regex '${term}': ${error instanceof Error ? error.message : "Invalid expression"}`); }
    });
  });
  return errors;
}

function quoteTerm(term: string) {
  return /^[\p{L}\p{N}*_-]+$/u.test(term) ? term : `"${term.replace(/"/g, '\\"')}"`;
}

export function generateBooleanQuery(config: QueryConfig) {
  return config.blocks.map((block) => `${block.exclude ? "NOT " : ""}(${block.terms.filter((term) => term.trim()).map((term) => quoteTerm(term.trim())).join(" OR ")})`).join(" AND ");
}

export function normalizeQueryConfig(input: Partial<QueryConfig>, defaultConfig: QueryConfig): QueryConfig {
  const blocks = Array.isArray(input.blocks) ? input.blocks.map((block, index) => ({
    id: block.id || `block-${index + 1}`,
    name: block.name || `Block ${index + 1}`,
    terms: Array.isArray(block.terms) ? block.terms : [],
    isRegex: !!block.isRegex,
    exclude: !!block.exclude,
  })) : [];
  return {
    blocks,
    operators: normalizeOperators(blocks.length),
    caseInsensitive: input.caseInsensitive !== false,
    searchFields: { ...defaultConfig.searchFields, ...(input.searchFields || {}) },
  };
}

export function createProjectFile(data: Omit<ProjectFileV2, "kind" | "version" | "sourceSignature">): ProjectFileV2 {
  return { kind: "literature-search-project", version: 2, ...data, sourceSignature: sourceSignature(data.bibtex) };
}

function validBase(candidate: Partial<ProjectFileV2 | ProjectFileV1>) {
  return typeof candidate.sourceName === "string" &&
    typeof candidate.bibtex === "string" &&
    candidate.sourceSignature === sourceSignature(candidate.bibtex) &&
    typeof candidate.queryString === "string" &&
    !!candidate.queryConfig && Array.isArray(candidate.queryConfig.blocks) &&
    !!candidate.duplicateResolutions && typeof candidate.duplicateResolutions === "object";
}

function validRequiredFields(value: unknown): value is CanonicalMetadataField[] {
  return Array.isArray(value) && value.every((field) => CANONICAL_METADATA_FIELDS.includes(field as CanonicalMetadataField));
}

export function parseProjectFile(value: unknown): { ok: true; project: ProjectFileV2; migrationNotice?: string } | { ok: false; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "The selected file is not a project object." };
  const candidate = value as Partial<ProjectFileV2 | ProjectFileV1>;
  if (candidate.kind !== "literature-search-project" || !validBase(candidate)) return { ok: false, error: "The project file is incomplete or its source signature is invalid." };
  if (candidate.version === 2) {
    const project = candidate as Partial<ProjectFileV2>;
    if (!project.metadataRequirements || typeof project.metadataRequirements.confirmed !== "boolean" || !validRequiredFields(project.metadataRequirements.requiredFields)) return { ok: false, error: "The project contains invalid metadata requirements." };
    const requiredFields = CANONICAL_METADATA_FIELDS.filter((field) => project.metadataRequirements!.requiredFields.includes(field));
    return { ok: true, project: { ...(project as ProjectFileV2), metadataRequirements: { ...project.metadataRequirements, requiredFields } } };
  }
  if (candidate.version === 1) {
    const project = candidate as ProjectFileV1;
    if (!project.thresholds || [project.thresholds.title, project.thresholds.abstract, project.thresholds.keywords].some((item) => typeof item !== "number" || !Number.isFinite(item))) return { ok: false, error: "The version-1 project contains invalid coverage thresholds." };
    const requiredFields = (["title", "abstract", "keywords"] as CanonicalMetadataField[]).filter((field) => project.thresholds[field as keyof ProjectFileV1["thresholds"]] === 100);
    const ignored = Object.entries(project.thresholds).filter(([, threshold]) => threshold > 0 && threshold < 100).map(([field, threshold]) => `${field} ${threshold}%`);
    return {
      ok: true,
      project: { kind: "literature-search-project", version: 2, sourceName: project.sourceName, bibtex: project.bibtex, sourceSignature: project.sourceSignature, metadataRequirements: { requiredFields, confirmed: false }, queryString: project.queryString, queryConfig: project.queryConfig, duplicateResolutions: project.duplicateResolutions },
      migrationNotice: `Version-1 project migrated. 100% thresholds became required fields${ignored.length ? `; partial thresholds were ignored (${ignored.join(", ")})` : ""}. Confirm the new metadata rules before screening.`,
    };
  }
  return { ok: false, error: "Unsupported project file version." };
}
