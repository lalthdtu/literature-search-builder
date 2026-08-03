export type ScreeningField = "title" | "abstract" | "keywords";

export type BlockResult = {
  blockId: string;
  blockIndex: number;
  blockName: string;
  isExclusion: boolean;
  matched: boolean;
  configuredTerms: string[];
  hits: Partial<Record<ScreeningField, string[]>>;
};

export type ExclusionReason = {
  blockId: string | null;
  blockIndex: number;
  kind: "missing_required_block" | "matched_exclusion_block" | "missing_searchable_data";
  message: string;
  evidence: string;
};

export type ScreeningDecision = {
  kept: boolean;
  reasons: ExclusionReason[];
  primaryReason: string;
};

export type ExcludedCsvRow = {
  CiteKey: string;
  Title: string;
  Authors: string;
  Year: string;
  Venue: string;
  URL: string;
  PrimaryExclusionReason: string;
  AllExclusionReasons: string;
  Evidence: string;
};

export type ScreeningRow = ExcludedCsvRow & {
  RecordId: string;
  TitleRaw: string;
  AbstractRaw: string;
  KeywordsRaw: string;
  BlockResults: BlockResult[];
  MatchedBlocks: string;
  MatchedTermsDetail: string;
  ExclusionReasons: ExclusionReason[];
};

export function formatHitEvidence(hits: Partial<Record<ScreeningField, string[]>>) {
  const labels: Record<ScreeningField, string> = {
    title: "Title",
    abstract: "Abstract",
    keywords: "Keywords",
  };

  return (Object.keys(labels) as ScreeningField[])
    .filter((field) => hits[field]?.length)
    .map((field) => `${labels[field]}: ${hits[field]!.join(" | ")}`)
    .join("; ");
}

export function classifyBlockResults(blockResults: BlockResult[], hasSearchableData: boolean): ScreeningDecision {
  if (!hasSearchableData) {
    const message = "Missing searchable data";
    return {
      kept: false,
      primaryReason: message,
      reasons: [
        {
          blockId: null,
          blockIndex: -1,
          kind: "missing_searchable_data",
          message,
          evidence: "No content was available in the selected title, abstract, or keywords fields.",
        },
      ],
    };
  }

  const reasons = blockResults
    .filter((result) => (result.isExclusion ? result.matched : !result.matched))
    .sort((a, b) => a.blockIndex - b.blockIndex)
    .map<ExclusionReason>((result) => {
      if (result.isExclusion) {
        return {
          blockId: result.blockId,
          blockIndex: result.blockIndex,
          kind: "matched_exclusion_block",
          message: `Exclusion block matched: ${result.blockName}`,
          evidence: formatHitEvidence(result.hits),
        };
      }

      return {
        blockId: result.blockId,
        blockIndex: result.blockIndex,
        kind: "missing_required_block",
        message: `Required block not matched: ${result.blockName}`,
        evidence: `Configured terms: ${result.configuredTerms.join(" | ")}`,
      };
    });

  return {
    kept: reasons.length === 0,
    reasons,
    primaryReason: reasons[0]?.message || "",
  };
}

export function normalizeOperators(blockCount: number) {
  return Array.from({ length: Math.max(0, blockCount - 1) }, () => "AND" as const);
}

export function csvEscape(value: unknown) {
  if (value == null) return "";
  const text = String(value);
  const escaped = text.replace(/"/g, '""');
  return /[",\r\n]/.test(text) ? `"${escaped}"` : escaped;
}

export function toExclusionCSV(rows: ExcludedCsvRow[]) {
  const headers = [
    "CiteKey",
    "Title",
    "Authors",
    "Year",
    "Venue",
    "URL/DOI",
    "Decision",
    "ScreeningStage",
    "DecisionMethod",
    "PrimaryExclusionReason",
    "AllExclusionReasons",
    "Evidence",
  ];
  const body = rows.map((row) =>
    [
      row.CiteKey,
      row.Title,
      row.Authors,
      row.Year,
      row.Venue,
      row.URL,
      "excluded",
      "pre_full_text",
      "automatic",
      row.PrimaryExclusionReason,
      row.AllExclusionReasons,
      row.Evidence,
    ]
      .map(csvEscape)
      .join(",")
  );
  return [headers.join(","), ...body].join("\n");
}

export function toExclusionSummaryCSV(rows: Pick<ExcludedCsvRow, "PrimaryExclusionReason">[]) {
  const body = summarizeExclusions(rows).map(({ reason, count }) => [reason, count].map(csvEscape).join(","));
  return ["PrimaryExclusionReason,Count", ...body].join("\n");
}

export function summarizeExclusions(rows: Pick<ExcludedCsvRow, "PrimaryExclusionReason">[]) {
  const counts = new Map<string, number>();
  rows.forEach((row) => counts.set(row.PrimaryExclusionReason, (counts.get(row.PrimaryExclusionReason) || 0) + 1));
  return [...counts.entries()].map(([reason, count]) => ({ reason, count }));
}

type MatcherConfig = {
  blocks: Array<{ id: string; name: string; terms: string[]; isRegex?: boolean; exclude?: boolean }>;
  caseInsensitive: boolean;
};

function escapeLiteral(value: string) {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term: string, isRegex: boolean) {
  const value = term.trim();
  if (isRegex) return value;
  if (value.endsWith("*")) return `\\b${escapeLiteral(value.slice(0, -1))}[\\w-]*`;
  return `\\b${escapeLiteral(value)}\\b`;
}

export function createBlockMatcher(config: MatcherConfig) {
  const flags = config.caseInsensitive ? "i" : "";
  const compiled = config.blocks.map((block, blockIndex) => ({
    block,
    blockIndex,
    name: block.name.trim() || `Block ${blockIndex + 1}`,
    terms: block.terms.map((term) => term.trim()).filter(Boolean),
    regexes: block.terms.map((term) => term.trim()).filter(Boolean).map((term) => new RegExp(termPattern(term, !!block.isRegex), flags)),
  }));

  return (fields: Record<ScreeningField, string>, selected: Record<ScreeningField, boolean>): BlockResult[] => compiled.map(({ block, blockIndex, name, terms, regexes }) => {
    const hits: Partial<Record<ScreeningField, string[]>> = {};
    (["title", "abstract", "keywords"] as ScreeningField[]).forEach((field) => {
      if (!selected[field] || !fields[field]) return;
      const matchedTerms = regexes.flatMap((regex, index) => regex.test(fields[field]) ? [terms[index]] : []);
      if (matchedTerms.length) hits[field] = matchedTerms;
    });
    return {
      blockId: block.id,
      blockIndex,
      blockName: name,
      isExclusion: !!block.exclude,
      matched: Object.values(hits).some((values) => values?.length),
      configuredTerms: terms,
      hits,
    };
  });
}

export function toKeptCSV(rows: ScreeningRow[]) {
  const headers = ["CiteKey", "Title", "Authors", "Year", "Venue", "URL/DOI", "Matched Blocks", "Matched Terms (by block & field)"];
  return [headers.join(","), ...rows.map((row) => [row.CiteKey, row.Title, row.Authors, row.Year, row.Venue, row.URL, row.MatchedBlocks, row.MatchedTermsDetail].map(csvEscape).join(","))].join("\n");
}
