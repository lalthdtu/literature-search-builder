import { buildBibEntry, type BibtexRecord } from "./bibtex.ts";
import { csvEscape } from "./screening.ts";

export type DuplicateEvidence = { kind: "doi" | "title"; value: string; recordIds: [string, string] };
export type DuplicateGroup = { id: string; recordIds: string[]; evidence: DuplicateEvidence[] };
export type DuplicateResolution =
  | { action: "keep_all" }
  | { action: "merge"; canonicalId: string; enrichFromIds: string[] };

export type DuplicateAuditRow = {
  groupId: string;
  evidence: string;
  canonicalRecordId: string;
  canonicalCiteKey: string;
  removedRecordId: string;
  removedCiteKey: string;
  removedDoi: string;
  removedTitle: string;
  enrichedFields: string;
  decisionMethod: "manual";
};

export type DuplicateDecisionAuditRow = {
  groupId: string;
  evidence: string;
  record: BibtexRecord;
  action: "kept_distinct" | "canonical" | "removed_duplicate";
  canonicalRecordId: string;
  canonicalCiteKey: string;
  enrichedFields: string[];
  enrichmentProvenance: string;
  decisionMethod: "manual";
};

export function normalizeDoi(value: string) {
  return value.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "").replace(/\s+/g, "");
}

export function normalizeTitle(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\\[a-zA-Z]+\s*/g, " ")
    .replace(/[{}]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function findDuplicateGroups(records: BibtexRecord[]): DuplicateGroup[] {
  const parent = new Map(records.map((record) => [record.internalId, record.internalId]));
  const find = (id: string): string => {
    const current = parent.get(id)!;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  const evidence: DuplicateEvidence[] = [];
  const compare = (kind: DuplicateEvidence["kind"], getValue: (record: BibtexRecord) => string) => {
    const values = new Map<string, BibtexRecord[]>();
    records.forEach((record) => {
      const value = getValue(record);
      if (value) values.set(value, [...(values.get(value) || []), record]);
    });
    values.forEach((matches, value) => {
      if (matches.length < 2) return;
      for (let index = 1; index < matches.length; index++) {
        union(matches[0].internalId, matches[index].internalId);
        evidence.push({ kind, value, recordIds: [matches[0].internalId, matches[index].internalId] });
      }
    });
  };

  compare("doi", (record) => normalizeDoi(record.fields.doi || ""));
  compare("title", (record) => normalizeTitle(record.fields.title || ""));

  const components = new Map<string, string[]>();
  records.forEach((record) => {
    const root = find(record.internalId);
    components.set(root, [...(components.get(root) || []), record.internalId]);
  });

  return [...components.values()]
    .filter((recordIds) => recordIds.length > 1)
    .map((recordIds, index) => ({
      id: `duplicate-group-${index + 1}`,
      recordIds,
      evidence: evidence.filter((item) => item.recordIds.some((id) => recordIds.includes(id))),
    }));
}

export function applyDuplicateResolutions(
  records: BibtexRecord[],
  groups: DuplicateGroup[],
  resolutions: Record<string, DuplicateResolution>
) {
  const byId = new Map(records.map((record) => [record.internalId, record]));
  const removed = new Set<string>();
  const replacements = new Map<string, BibtexRecord>();
  const audit: DuplicateAuditRow[] = [];
  const decisionAudit: DuplicateDecisionAuditRow[] = [];

  groups.forEach((group) => {
    const resolution = resolutions[group.id];
    const evidenceText = group.evidence.map((item) => `${item.kind}: ${item.value}`).join(" | ");
    if (!resolution) return;
    if (resolution.action === "keep_all") {
      group.recordIds.forEach((id) => {
        const record = byId.get(id);
        if (!record) return;
        decisionAudit.push({
          groupId: group.id,
          evidence: evidenceText,
          record,
          action: "kept_distinct",
          canonicalRecordId: "",
          canonicalCiteKey: "",
          enrichedFields: [],
          enrichmentProvenance: "",
          decisionMethod: "manual",
        });
      });
      return;
    }
    const canonical = byId.get(resolution.canonicalId);
    if (!canonical) return;
    const fields = { ...canonical.fields };
    const enrichedByRecord = new Map<string, string[]>();
    resolution.enrichFromIds.forEach((sourceId) => {
      const source = byId.get(sourceId);
      if (!source || sourceId === canonical.internalId) return;
      Object.entries(source.fields).forEach(([field, value]) => {
        if (!fields[field] && value) {
          fields[field] = value;
          enrichedByRecord.set(sourceId, [...(enrichedByRecord.get(sourceId) || []), field]);
        }
      });
    });
    const enrichedCanonical = { ...canonical, fields };
    replacements.set(canonical.internalId, enrichedCanonical);
    const provenance = [...enrichedByRecord.entries()].map(([sourceId, fieldNames]) => {
      const source = byId.get(sourceId);
      return `${source?.citekey || sourceId}: ${fieldNames.join(" | ")}`;
    }).join("; ");
    decisionAudit.push({
      groupId: group.id,
      evidence: evidenceText,
      record: enrichedCanonical,
      action: "canonical",
      canonicalRecordId: canonical.internalId,
      canonicalCiteKey: canonical.citekey,
      enrichedFields: [...new Set([...enrichedByRecord.values()].flat())],
      enrichmentProvenance: provenance,
      decisionMethod: "manual",
    });
    group.recordIds.filter((id) => id !== canonical.internalId).forEach((id) => {
      const duplicate = byId.get(id);
      if (!duplicate) return;
      removed.add(id);
      audit.push({
        groupId: group.id,
        evidence: group.evidence.map((item) => `${item.kind}: ${item.value}`).join(" | "),
        canonicalRecordId: canonical.internalId,
        canonicalCiteKey: canonical.citekey,
        removedRecordId: duplicate.internalId,
        removedCiteKey: duplicate.citekey,
        removedDoi: duplicate.fields.doi || "",
        removedTitle: duplicate.fields.title || "",
        enrichedFields: (enrichedByRecord.get(id) || []).join(" | "),
        decisionMethod: "manual",
      });
      decisionAudit.push({
        groupId: group.id,
        evidence: evidenceText,
        record: duplicate,
        action: "removed_duplicate",
        canonicalRecordId: canonical.internalId,
        canonicalCiteKey: canonical.citekey,
        enrichedFields: enrichedByRecord.get(id) || [],
        enrichmentProvenance: (enrichedByRecord.get(id) || []).length ? `Contributed to ${canonical.citekey}` : "",
        decisionMethod: "manual",
      });
    });
  });

  return { records: records.filter((record) => !removed.has(record.internalId)).map((record) => replacements.get(record.internalId) || record), audit, decisionAudit };
}

export function toDuplicateAuditCSV(rows: DuplicateAuditRow[]) {
  const headers = ["GroupId", "MatchEvidence", "CanonicalRecordId", "CanonicalCiteKey", "RemovedRecordId", "RemovedCiteKey", "RemovedDOI", "RemovedTitle", "EnrichedFields", "DecisionMethod", "Stage"];
  const body = rows.map((row) => [row.groupId, row.evidence, row.canonicalRecordId, row.canonicalCiteKey, row.removedRecordId, row.removedCiteKey, row.removedDoi, row.removedTitle, row.enrichedFields, row.decisionMethod, "deduplication"].map(csvEscape).join(","));
  return [headers.join(","), ...body].join("\n");
}

export function buildUniqueBibtex(records: BibtexRecord[]) {
  const totals = new Map<string, number>();
  records.forEach((record) => totals.set(record.citekey, (totals.get(record.citekey) || 0) + 1));
  const seen = new Map<string, number>();
  const mapping: Array<{ recordId: string; originalCiteKey: string; exportCiteKey: string }> = [];
  const entries = records.map((record) => {
    const occurrence = (seen.get(record.citekey) || 0) + 1;
    seen.set(record.citekey, occurrence);
    const exportCiteKey = (totals.get(record.citekey) || 0) > 1 && occurrence > 1 ? `${record.citekey}-${occurrence}` : record.citekey;
    mapping.push({ recordId: record.internalId, originalCiteKey: record.citekey, exportCiteKey });
    return buildBibEntry(record, exportCiteKey);
  });
  return { bibtex: entries.join("\n\n"), mapping };
}

export function toCiteKeyMappingCSV(rows: Array<{ recordId: string; originalCiteKey: string; exportCiteKey: string }>) {
  return ["RecordId,OriginalCiteKey,ExportCiteKey", ...rows.map((row) => [row.recordId, row.originalCiteKey, row.exportCiteKey].map(csvEscape).join(","))].join("\n");
}
