import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, ChevronRight, FileSpreadsheet, FileText, Filter, FolderOpen, Play, Plus, Save, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { BibtexSourceEditor } from "@/components/BibtexSourceEditor";
import { ResultsPreview, type PreviewBlock } from "@/components/ResultsPreview";
import { applyBibtexDiagnosticFix, parseBibtex, sourceSignature, type BibtexDiagnostic, type BibtexRecord } from "@/lib/bibtex";
import {
  applyDuplicateResolutions,
  buildUniqueBibtex,
  findDuplicateGroups,
  type DuplicateAuditRow,
  type DuplicateResolution,
} from "@/lib/deduplication";
import {
  applyMetadataRequirements,
  calculateMetadataFieldCounts,
  CANONICAL_METADATA_FIELDS,
  groupMetadataRemovals,
  METADATA_FIELD_LABELS,
  type CanonicalMetadataField,
} from "@/lib/metadata";
import { parseBlockQuery, type QueryParseError } from "@/lib/queryParser";
import {
  classifyBlockResults,
  createBlockMatcher,
  type ScreeningRow,
} from "@/lib/screening";
import { buildPrismaWorkbook, prismaWorkbookFilename, type WorkbookRunSnapshot } from "@/lib/workbook";
import {
  createImportSnapshot,
  createProjectFile,
  generateBooleanQuery,
  importReadiness,
  normalizeQueryConfig,
  parseProjectFile,
  validateQueryConfig,
  type ImportSnapshot,
  type ProjectFileV2,
  type QueryBlock,
  type QueryConfig,
  type WorkflowStatus,
} from "@/lib/workflow";

type Step = "import" | "dedup" | "metadata" | "query" | "results";
type RunOutput = WorkbookRunSnapshot & {
  structurallyValid: number;
  screenedRecords: BibtexRecord[];
  duplicateAudit: DuplicateAuditRow[];
  blocks: PreviewBlock[];
};

const uid = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
const DEFAULT_CONFIG: QueryConfig = {
  caseInsensitive: true,
  searchFields: { title: true, abstract: true, keywords: true },
  blocks: [
    { id: uid(), name: "Virtual reality", terms: ["immersive virtual reality", "virtual reality"] },
    { id: uid(), name: "Remote participation", terms: ["remote study", "online study", "home*", "crowdsourc*"] },
    { id: uid(), name: "Excluded topic/type", terms: ["review", "survey"], exclude: true },
  ],
  operators: ["AND", "AND"],
};

function download(filename: string, content: BlobPart, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function workflowSignature(bib: string, requiredFields: CanonicalMetadataField[], metadataAppliedSignature: string | null, config: QueryConfig, resolutions: Record<string, DuplicateResolution>) {
  return sourceSignature(`${bib}\u0000${JSON.stringify({ requiredFields, metadataAppliedSignature, config, resolutions })}`);
}

function metadataSignature(records: BibtexRecord[], requiredFields: CanonicalMetadataField[]) {
  return sourceSignature(JSON.stringify({ records: records.map((record) => [record.internalId, record.fields]), requiredFields }));
}

function statusFor(complete: boolean, ready: boolean, started: boolean, stale = false): WorkflowStatus {
  if (stale) return "out_of_date";
  if (complete) return "complete";
  if (ready) return "ready";
  return started ? "needs_attention" : "not_started";
}

const statusStyle: Record<WorkflowStatus, string> = {
  not_started: "bg-slate-100 text-slate-600",
  needs_attention: "bg-amber-100 text-amber-800",
  ready: "bg-blue-100 text-blue-800",
  complete: "bg-green-100 text-green-800",
  out_of_date: "bg-amber-100 text-amber-800",
};

function StatusBadge({ status }: { status: WorkflowStatus }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusStyle[status]}`}>{status.replaceAll("_", " ")}</span>;
}

function GateList({ items }: { items: Array<{ ok: boolean; label: string }> }) {
  return (
    <div className="grid gap-2 rounded-xl border bg-slate-50 p-4">
      <div className="font-medium">Readiness checklist</div>
      {items.map((item) => <div key={item.label} className={`flex items-start gap-2 text-sm ${item.ok ? "text-green-700" : "text-amber-800"}`}>{item.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}<span>{item.label}</span></div>)}
    </div>
  );
}

function RecordSummary({ record }: { record: BibtexRecord }) {
  return (
    <div className="grid gap-1">
      <div className="font-medium">{record.fields.title || "Untitled record"}</div>
      <div className="text-xs text-slate-500">{record.citekey} · {record.fields.author || "No author"} · {record.fields.year || "No year"} · line {record.line}</div>
      <div className="flex flex-wrap gap-1 pt-1">
        {["title", "abstract", "keywords", "doi", "author", "year"].map((field) => <span key={field} className={`rounded-full border px-2 py-0.5 text-[11px] ${record.fields[field] || (field === "abstract" && (record.fields.abs || record.fields.summary)) || (field === "keywords" && record.fields.keyword) ? "border-green-200 bg-green-50 text-green-700" : "border-slate-200 text-slate-400"}`}>{field}</span>)}
      </div>
    </div>
  );
}

function ParsedRecords({ snapshot, onJump, onFix }: { snapshot: ImportSnapshot; onJump: (diagnostic: BibtexDiagnostic | BibtexRecord) => void; onFix: (diagnostic: BibtexDiagnostic) => void }) {
  const warningKeys = new Set(snapshot.parsed.diagnostics.filter((item) => item.severity === "warning").map((item) => item.citekey).filter(Boolean));
  const attention = snapshot.parsed.records.filter((record) => warningKeys.has(record.citekey));
  const valid = snapshot.parsed.records.filter((record) => !warningKeys.has(record.citekey));
  const errors = snapshot.parsed.diagnostics.filter((item) => item.severity === "error");
  return (
    <div className="grid gap-3">
      <details open={errors.length > 0} className="rounded-xl border bg-white p-3">
        <summary className="cursor-pointer font-medium text-red-700">Blocking regions ({errors.length})</summary>
        <div className="mt-3 grid gap-2">{errors.map((item, index) => <div key={`${item.code}-${index}`} className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm"><div className="font-medium">Lines {item.range.startLine}–{item.range.endLine}: {item.message}</div><div className="mt-1 text-red-700">{item.guidance}</div><div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => onJump(item)}>Jump to source</Button>{item.fix && <Button size="sm" onClick={() => onFix(item)}>{item.fix.label}</Button>}</div></div>)}</div>
      </details>
      <details open={attention.length > 0} className="rounded-xl border bg-white p-3">
        <summary className="cursor-pointer font-medium text-amber-800">Needs attention ({attention.length})</summary>
        <div className="mt-3 grid gap-2">{attention.map((record) => <button key={record.internalId} className="rounded-lg border p-3 text-left hover:bg-slate-50" onClick={() => onJump(record)}><RecordSummary record={record} /></button>)}</div>
      </details>
      <details className="rounded-xl border bg-white p-3">
        <summary className="cursor-pointer font-medium text-green-800">Structurally valid ({valid.length})</summary>
        <div className="mt-3 max-h-96 grid gap-2 overflow-y-auto">{valid.map((record) => <button key={record.internalId} className="rounded-lg border p-3 text-left hover:bg-slate-50" onClick={() => onJump(record)}><RecordSummary record={record} /></button>)}</div>
      </details>
    </div>
  );
}

export default function App() {
  const [step, setStep] = useState<Step>("import");
  const [bib, setBib] = useState("");
  const [sourceName, setSourceName] = useState("pasted-input.bib");
  const [requiredMetadataFields, setRequiredMetadataFields] = useState<CanonicalMetadataField[]>(["title", "author"]);
  const [metadataConfirmed, setMetadataConfirmed] = useState(false);
  const [metadataAppliedSignature, setMetadataAppliedSignature] = useState<string | null>(null);
  const [importSnapshot, setImportSnapshot] = useState<ImportSnapshot | null>(null);
  const [jumpTo, setJumpTo] = useState<{ from: number; to: number; nonce: number } | null>(null);
  const [config, setConfig] = useState<QueryConfig>(DEFAULT_CONFIG);
  const [queryString, setQueryString] = useState("");
  const [queryParseErrors, setQueryParseErrors] = useState<QueryParseError[]>([]);
  const [resolutions, setResolutions] = useState<Record<string, DuplicateResolution>>({});
  const [runOutput, setRunOutput] = useState<RunOutput | null>(null);
  const [running, setRunning] = useState(false);
  const [generatingWorkbook, setGeneratingWorkbook] = useState(false);
  const [workbookError, setWorkbookError] = useState("");
  const [message, setMessage] = useState("");
  const bibFileRef = useRef<HTMLInputElement>(null);
  const projectFileRef = useRef<HTMLInputElement>(null);

  const effectiveSnapshot = importSnapshot;
  const importGate = importReadiness(effectiveSnapshot, bib);
  const duplicateGroups = useMemo(() => effectiveSnapshot && importGate.ready ? findDuplicateGroups(effectiveSnapshot.parsed.records) : [], [effectiveSnapshot, importGate.ready]);
  const unresolvedGroups = duplicateGroups.filter((group) => !resolutions[group.id]);
  const dedupReady = importGate.ready && unresolvedGroups.length === 0;
  const dedupResult = useMemo(() => effectiveSnapshot ? applyDuplicateResolutions(effectiveSnapshot.parsed.records, duplicateGroups, resolutions) : { records: [], audit: [], decisionAudit: [] }, [effectiveSnapshot, duplicateGroups, resolutions]);
  const currentMetadataSignature = metadataSignature(dedupResult.records, requiredMetadataFields);
  const metadataPreview = useMemo(() => applyMetadataRequirements(dedupResult.records, requiredMetadataFields), [dedupResult.records, requiredMetadataFields]);
  const dedupMetadataCounts = useMemo(() => calculateMetadataFieldCounts(dedupResult.records), [dedupResult.records]);
  const metadataReady = dedupReady && metadataConfirmed && metadataAppliedSignature === currentMetadataSignature;
  const queryValidation = validateQueryConfig(config);
  const readyToScreen = metadataReady && queryValidation.length === 0;
  const currentSignature = workflowSignature(bib, requiredMetadataFields, metadataAppliedSignature, config, resolutions);
  const resultsStale = !!runOutput && runOutput.signature !== currentSignature;
  const sourceStale = !!importSnapshot && importSnapshot.sourceSignature !== sourceSignature(bib);

  const stepStatuses: Record<Step, WorkflowStatus> = {
    import: statusFor(importGate.ready, importGate.ready, !!bib, sourceStale),
    dedup: statusFor(dedupReady, dedupReady, duplicateGroups.length > 0, sourceStale),
    metadata: statusFor(metadataReady, dedupReady, dedupReady, !!metadataAppliedSignature && metadataAppliedSignature !== currentMetadataSignature),
    query: statusFor(!!runOutput && !resultsStale, readyToScreen, config.blocks.length > 0, sourceStale || !metadataReady || (!!runOutput && resultsStale)),
    results: statusFor(!!runOutput && !resultsStale, !!runOutput, !!runOutput, resultsStale),
  };

  const updateSource = (value: string, name?: string) => {
    setBib(value);
    if (typeof name === "string") setSourceName(name);
    setMetadataConfirmed(false);
    setMetadataAppliedSignature(null);
    setMessage(value === bib ? "" : "Source changed. Validate and parse it again before continuing.");
  };

  const readBibFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".bib")) { setMessage("Choose a .bib file."); return; }
    updateSource(await file.text(), file.name);
  };

  const validateImport = () => {
    const parsed = parseBibtex(bib);
    setImportSnapshot(createImportSnapshot(bib, parsed));
    setResolutions({});
    setMetadataConfirmed(false);
    setMetadataAppliedSignature(null);
    setMessage(parsed.hasBlockingErrors ? "Parsing found blocking structural errors. Use the markers and grouped diagnostics to repair them." : `Parsed ${parsed.records.length} structurally valid records. Review the field counts before continuing.`);
  };

  const applySuggestedClosure = (diagnostic: BibtexDiagnostic) => {
    if (!diagnostic.fix) return;
    const fixedSource = applyBibtexDiagnosticFix(bib, diagnostic);
    const parsed = parseBibtex(fixedSource);
    setBib(fixedSource);
    setImportSnapshot(createImportSnapshot(fixedSource, parsed));
    setResolutions({});
    setMetadataConfirmed(false);
    setMetadataAppliedSignature(null);
    setMessage(parsed.hasBlockingErrors ? `Inserted the suggested closure. ${parsed.diagnostics.filter((item) => item.severity === "error").length} blocking issue(s) remain.` : `Inserted the suggested closure and reparsed ${parsed.records.length} valid records.`);
  };

  const applyQueryString = () => {
    const parsed = parseBlockQuery(queryString);
    if (!parsed.ok) { setQueryParseErrors(parsed.errors); return; }
    setQueryParseErrors([]);
    const blocks: QueryBlock[] = parsed.blocks.map((block) => ({ ...block, id: uid() }));
    setConfig((current) => ({ ...current, blocks, operators: Array.from({ length: Math.max(0, blocks.length - 1) }, () => "AND") }));
  };

  const updateBlock = (index: number, patch: Partial<QueryBlock>) => setConfig((current) => {
    const blocks = [...current.blocks];
    blocks[index] = { ...blocks[index], ...patch };
    return { ...current, blocks };
  });

  const runScreening = () => {
    if (!readyToScreen) return;
    setRunning(true);
    setMessage("");
    try {
      const matcher = createBlockMatcher(config);
      const kept: ScreeningRow[] = [];
      const excluded: ScreeningRow[] = [];
      const keptRecords: BibtexRecord[] = [];
      const termDocuments = new Map<string, Set<string>>();
      metadataPreview.retainedRecords.forEach((record) => {
        const title = record.fields.title || "";
        const abstract = record.fields.abstract || record.fields.abs || record.fields.summary || "";
        const keywords = record.fields.keywords || record.fields.keyword || "";
        const hasSearchableData = Boolean((config.searchFields.title && title) || (config.searchFields.abstract && abstract) || (config.searchFields.keywords && keywords));
        const blockResults = matcher({ title, abstract, keywords }, config.searchFields);
        const decision = classifyBlockResults(blockResults, hasSearchableData);
        const detail = blockResults.filter((result) => result.matched).map((result) => {
          const fields = Object.entries(result.hits).filter(([, terms]) => terms?.length).map(([field, terms]) => `${field}: ${terms!.join(" | ")}`).join("; ");
          result.configuredTerms.forEach((term) => {
            if (Object.values(result.hits).some((values) => values?.includes(term))) termDocuments.set(term, new Set([...(termDocuments.get(term) || []), record.internalId]));
          });
          return `${result.blockName} [${fields}]`;
        }).join("; ");
        const base = {
          RecordId: record.internalId,
          CiteKey: record.citekey,
          Title: title.replace(/[{}]/g, "").replace(/\s+/g, " ").trim(),
          Authors: (record.fields.author || "").replace(/\s+/g, " ").trim(),
          Year: record.fields.year || "",
          Venue: record.fields.booktitle || record.fields.journal || "",
          URL: record.fields.url || (record.fields.doi ? `https://doi.org/${record.fields.doi}` : ""),
          TitleRaw: title,
          AbstractRaw: abstract,
          KeywordsRaw: keywords,
          BlockResults: blockResults,
          MatchedBlocks: blockResults.filter((result) => result.matched).map((result) => result.blockName).join("; "),
          MatchedTermsDetail: detail,
        };
        if (decision.kept) {
          kept.push({ ...base, PrimaryExclusionReason: "", AllExclusionReasons: "", Evidence: "", ExclusionReasons: [] });
          keptRecords.push(record);
        } else {
          excluded.push({ ...base, PrimaryExclusionReason: decision.primaryReason, AllExclusionReasons: decision.reasons.map((reason) => reason.message).join(" | "), Evidence: decision.reasons.map((reason) => `${reason.message} [${reason.evidence}]`).join(" | "), ExclusionReasons: decision.reasons });
        }
      });
      const runAt = new Date().toISOString();
      setRunOutput({
        entryHeaders: effectiveSnapshot?.parsed.discoveredHeaders || 0,
        structurallyValid: effectiveSnapshot?.parsed.records.length || 0,
        sourceName,
        runAt,
        validatedRecords: effectiveSnapshot?.parsed.records || [],
        diagnostics: effectiveSnapshot?.parsed.diagnostics || [],
        duplicateGroups,
        duplicateDecisions: dedupResult.decisionAudit,
        afterDeduplication: dedupResult.records,
        metadataRequiredFields: [...requiredMetadataFields],
        afterMetadata: metadataPreview.retainedRecords,
        queryExpression: generateBooleanQuery(config),
        queryBlocks: config.blocks.map((block) => ({ ...block, terms: [...block.terms] })),
        searchFields: { ...config.searchFields },
        caseInsensitive: config.caseInsensitive,
        kept,
        excluded,
        screenedRecords: metadataPreview.retainedRecords,
        keptRecords,
        duplicateAudit: dedupResult.audit,
        metadataRemovals: metadataPreview.removals,
        blocks: config.blocks.map((block, index) => ({ id: block.id, name: block.name.trim() || `Block ${index + 1}`, exclude: !!block.exclude })),
        signature: currentSignature,
        termCounts: [...termDocuments].map(([term, ids]) => ({ term, count: ids.size })).sort((a, b) => b.count - a.count),
      });
      setWorkbookError("");
      setStep("results");
    } catch (error) {
      setMessage(`Screening could not run: ${error instanceof Error ? error.message : "Unknown error"}`);
      setStep("query");
    } finally { setRunning(false); }
  };

  const exportProject = () => download("literature_search_project.json", JSON.stringify(createProjectFile({ sourceName, bibtex: bib, metadataRequirements: { requiredFields: requiredMetadataFields, confirmed: metadataReady }, queryString, queryConfig: config, duplicateResolutions: resolutions }), null, 2), "application/json");

  const exportWorkbook = async () => {
    if (!runOutput || resultsStale || generatingWorkbook) return;
    setGeneratingWorkbook(true);
    setWorkbookError("");
    try {
      const buffer = await buildPrismaWorkbook(runOutput);
      download(prismaWorkbookFilename(runOutput.sourceName, runOutput.runAt), buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } catch (error) {
      setWorkbookError(`Workbook could not be generated: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setGeneratingWorkbook(false);
    }
  };

  const loadProjectOrConfig = async (file: File) => {
    try {
      const value = JSON.parse(await file.text());
      const projectResult = parseProjectFile(value);
      if (projectResult.ok) {
        const project: ProjectFileV2 = projectResult.project;
        const parsed = parseBibtex(project.bibtex);
        const loadedConfig = normalizeQueryConfig(project.queryConfig, DEFAULT_CONFIG);
        const loadedGroups = findDuplicateGroups(parsed.records);
        const loadedDedup = applyDuplicateResolutions(parsed.records, loadedGroups, project.duplicateResolutions);
        const loadedMetadataSignature = metadataSignature(loadedDedup.records, project.metadataRequirements.requiredFields);
        setBib(project.bibtex); setSourceName(project.sourceName);
        setImportSnapshot(createImportSnapshot(project.bibtex, parsed));
        setRequiredMetadataFields(project.metadataRequirements.requiredFields);
        setMetadataConfirmed(project.metadataRequirements.confirmed);
        setMetadataAppliedSignature(project.metadataRequirements.confirmed ? loadedMetadataSignature : null);
        setConfig(loadedConfig); setQueryString(project.queryString); setResolutions(project.duplicateResolutions); setRunOutput(null); setStep("import");
        setMessage(projectResult.migrationNotice || "Project loaded and source reparsed. Review readiness before continuing.");
      } else if (Array.isArray(value?.blocks)) {
        setConfig(normalizeQueryConfig(value, DEFAULT_CONFIG)); setStep(dedupReady ? "query" : "import"); setMessage("Legacy query configuration loaded and normalized to required AND blocks.");
      } else setMessage(projectResult.error);
    } catch { setMessage("The selected JSON file could not be read. Current work was not changed."); }
  };

  const navigate = (next: Step) => {
    const allowed = next === "import" || (next === "dedup" && importGate.ready) || (next === "metadata" && dedupReady) || (next === "query" && metadataReady) || (next === "results" && !!runOutput);
    if (allowed) setStep(next);
  };

  const importChecklist = [
    { ok: !!effectiveSnapshot && !sourceStale, label: "BibTeX source has a current parsed snapshot." },
    { ok: !!effectiveSnapshot && !effectiveSnapshot.parsed.hasBlockingErrors, label: "No blocking structural errors remain." },
  ];
  const queryChecklist = [
    { ok: importGate.ready, label: "Import validation is complete and current." },
    { ok: dedupReady, label: unresolvedGroups.length ? `${unresolvedGroups.length} duplicate candidate group(s) still need a decision.` : "Every duplicate candidate group has a decision." },
    { ok: metadataReady, label: metadataReady ? "Required metadata cleanup is applied and current." : "Apply the required metadata rules." },
    { ok: queryValidation.length === 0, label: queryValidation.length ? queryValidation.join(" ") : "Query blocks and regular expressions are valid." },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 p-4 md:p-6">
      <div className="mx-auto grid max-w-7xl gap-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div><h1 className="text-3xl font-semibold tracking-tight">Literature Screening Workflow</h1><p className="mt-1 text-sm text-slate-600">Validate, deduplicate, screen, and audit before full-text assessment.</p></div>
          <div className="flex gap-2"><Button variant="outline" onClick={exportProject}><Save className="mr-2 h-4 w-4" />Export project</Button><Button variant="outline" onClick={() => projectFileRef.current?.click()}><FolderOpen className="mr-2 h-4 w-4" />Load project/config</Button><input ref={projectFileRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadProjectOrConfig(file); event.currentTarget.value = ""; }} /></div>
        </header>

        {message && <div className={`rounded-xl border p-3 text-sm ${message.includes("could not") || message.includes("blocking") ? "border-red-200 bg-red-50 text-red-800" : "border-blue-200 bg-blue-50 text-blue-800"}`}>{message}</div>}

        <Tabs value={step} onValueChange={(value) => navigate(value as Step)}>
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1 p-1 lg:grid-cols-5">
            {(["import", "dedup", "metadata", "query", "results"] as Step[]).map((item, index) => {
              const disabled = item === "dedup" ? !importGate.ready : item === "metadata" ? !dedupReady : item === "query" ? !metadataReady : item === "results" ? !runOutput : false;
              const labels = ["Import & Validate", "Deduplicate", "Required Metadata", "Define Query & Screen", "Results"];
              return <TabsTrigger key={item} value={item} disabled={disabled} className="h-auto min-h-14 flex-wrap py-2"><span>{index + 1}. {labels[index]}</span><StatusBadge status={stepStatuses[item]} /></TabsTrigger>;
            })}
          </TabsList>

          <TabsContent value="import">
            <Card><CardContent className="grid gap-5 p-5 md:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Import and validate BibTeX</h2><p className="text-sm text-slate-600">Create a stable parsed snapshot before configuring screening.</p></div><div className="flex gap-2"><Button variant="outline" onClick={() => bibFileRef.current?.click()}><Upload className="mr-2 h-4 w-4" />Upload .bib</Button><input ref={bibFileRef} type="file" accept=".bib,text/plain" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readBibFile(file); event.currentTarget.value = ""; }} /><Button onClick={validateImport}><FileText className="mr-2 h-4 w-4" />Validate & parse records</Button></div></div>
              <div onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void readBibFile(file); }} className="grid gap-2"><div className="flex justify-between text-xs text-slate-500"><span>{sourceName}</span><span>Paste, edit, upload, or drop a .bib file</span></div><BibtexSourceEditor value={bib} diagnostics={sourceStale ? [] : effectiveSnapshot?.parsed.diagnostics || []} jumpTo={jumpTo} onChange={updateSource} /></div>
              {sourceStale && <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Parsed records are out of date. Validate and parse the edited source again.</div>}
              {effectiveSnapshot && !sourceStale && <>
                <div><h3 className="mb-2 font-medium">Metadata present and missing</h3><div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">{CANONICAL_METADATA_FIELDS.map((field) => { const counts = effectiveSnapshot.fieldCounts[field]; return <div key={field} className="rounded-xl border bg-white p-3"><div className="text-xs text-slate-500">{METADATA_FIELD_LABELS[field]}</div><div className="mt-1 text-sm font-medium text-green-700">{counts.present} present</div><div className="text-sm font-medium text-amber-700">{counts.missing} missing</div></div>; })}</div></div>
                <ParsedRecords snapshot={effectiveSnapshot} onJump={(item) => setJumpTo({ from: item.range.from, to: item.range.to, nonce: Date.now() })} onFix={applySuggestedClosure} />
              </>}
              <GateList items={importChecklist} />
              <div className="flex justify-end"><Button disabled={!importGate.ready} onClick={() => setStep("dedup")}>Continue to deduplication<ChevronRight className="ml-2 h-4 w-4" /></Button></div>
            </CardContent></Card>
          </TabsContent>

          <TabsContent value="dedup">
            <Card><CardContent className="grid gap-5 p-5 md:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Resolve duplicate candidates</h2><p className="text-sm text-slate-600">Candidates use exact normalized DOI or title evidence. Cite keys are never matching evidence.</p></div><Button variant="outline" disabled={!unresolvedGroups.length} onClick={() => setResolutions((current) => { const next = { ...current }; unresolvedGroups.forEach((group) => { next[group.id] = { action: "merge", canonicalId: group.recordIds[0], enrichFromIds: group.recordIds.slice(1) }; }); return next; })}><Check className="mr-2 h-4 w-4" />Choose first for all unresolved</Button></div>
              <div className="grid grid-cols-3 gap-3"><div className="rounded-xl border p-3"><div className="text-xs text-slate-500">Candidate groups</div><div className="text-2xl font-semibold">{duplicateGroups.length}</div></div><div className="rounded-xl border p-3"><div className="text-xs text-slate-500">Unresolved</div><div className="text-2xl font-semibold text-amber-700">{unresolvedGroups.length}</div></div><div className="rounded-xl border p-3"><div className="text-xs text-slate-500">Records removed</div><div className="text-2xl font-semibold">{dedupResult.audit.length}</div></div></div>
              {!duplicateGroups.length && <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-green-800">No DOI- or title-based duplicate candidates were found. This step is complete.</div>}
              <div className="grid gap-4">{duplicateGroups.map((group) => {
                const records = group.recordIds.map((id) => effectiveSnapshot!.parsed.records.find((record) => record.internalId === id)!).filter(Boolean);
                const resolution = resolutions[group.id];
                return <div key={group.id} className={`rounded-xl border p-4 ${resolution ? "border-green-200 bg-green-50/40" : "border-amber-300 bg-amber-50/40"}`}><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="font-medium">{group.id}</div><div className="text-xs text-slate-500">{[...new Set(group.evidence.map((item) => `${item.kind.toUpperCase()}: ${item.value}`))].join(" · ")}</div></div><Button variant="outline" onClick={() => setResolutions((current) => ({ ...current, [group.id]: { action: "keep_all" } }))}>Keep all as distinct</Button></div><div className="mt-3 grid gap-2">{records.map((record) => { const canonical = resolution?.action === "merge" && resolution.canonicalId === record.internalId; return <div key={record.internalId} className={`rounded-lg border bg-white p-3 ${canonical ? "border-green-500 ring-1 ring-green-300" : ""}`}><RecordSummary record={record} /><div className="mt-2 flex flex-wrap items-center gap-3"><Button size="sm" variant={canonical ? "secondary" : "outline"} onClick={() => setResolutions((current) => ({ ...current, [group.id]: { action: "merge", canonicalId: record.internalId, enrichFromIds: records.filter((item) => item.internalId !== record.internalId).map((item) => item.internalId) } }))}>{canonical ? "Canonical record" : "Choose as canonical"}</Button>{resolution?.action === "merge" && !canonical && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={resolution.enrichFromIds.includes(record.internalId)} onChange={(event) => setResolutions((current) => ({ ...current, [group.id]: { ...resolution, enrichFromIds: event.target.checked ? [...resolution.enrichFromIds, record.internalId] : resolution.enrichFromIds.filter((id) => id !== record.internalId) } }))} />Fill missing canonical fields from this record</label>}</div></div>; })}</div><div className="mt-2 text-xs font-medium">Decision: {resolution?.action === "keep_all" ? "Keep all as distinct" : resolution?.action === "merge" ? `Merge into ${records.find((record) => record.internalId === resolution.canonicalId)?.citekey}` : "Required"}</div></div>;
              })}</div>
              <GateList items={[{ ok: importGate.ready, label: "Import snapshot is valid and current." }, { ok: unresolvedGroups.length === 0, label: unresolvedGroups.length ? `${unresolvedGroups.length} candidate group(s) require a decision.` : "Every candidate group has an explicit decision." }]} />
              <div className="flex justify-between"><Button variant="outline" onClick={() => setStep("import")}>Back</Button><Button disabled={!dedupReady} onClick={() => setStep("metadata")}>Continue to required metadata<ChevronRight className="ml-2 h-4 w-4" /></Button></div>
            </CardContent></Card>
          </TabsContent>

          <TabsContent value="metadata">
            <Card><CardContent className="grid gap-5 p-5 md:p-6">
              <div><h2 className="text-xl font-semibold">Required metadata</h2><p className="text-sm text-slate-600">Choose the fields every deduplicated record must contain before query screening. All selected rules are required.</p></div>
              <div className="grid gap-3 rounded-xl border bg-white p-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{CANONICAL_METADATA_FIELDS.map((field) => <div key={field} className="flex items-center justify-between rounded-lg border p-3"><div><Label>{METADATA_FIELD_LABELS[field]}</Label><div className="text-xs text-slate-500">{dedupMetadataCounts[field].present} present · {dedupMetadataCounts[field].missing} missing</div></div><Switch checked={requiredMetadataFields.includes(field)} onCheckedChange={(checked) => { setRequiredMetadataFields((current) => checked ? CANONICAL_METADATA_FIELDS.filter((item) => item === field || current.includes(item)) : current.filter((item) => item !== field)); setMetadataConfirmed(false); }} /></div>)}</div>
                <div className="text-xs text-slate-500">No fields selected means metadata cleanup is disabled after you explicitly apply the configuration.</div>
              </div>
              <div className="grid grid-cols-3 gap-3"><div className="rounded-xl border p-3"><div className="text-xs text-slate-500">After deduplication</div><div className="text-2xl font-semibold">{dedupResult.records.length}</div></div><div className="rounded-xl border border-red-200 p-3"><div className="text-xs text-slate-500">Will be removed</div><div className="text-2xl font-semibold text-red-700">{metadataPreview.removals.length}</div></div><div className="rounded-xl border border-green-200 p-3"><div className="text-xs text-slate-500">Will be screened</div><div className="text-2xl font-semibold text-green-700">{metadataPreview.retainedRecords.length}</div></div></div>
              <div className="grid gap-3">{groupMetadataRemovals(metadataPreview.removals).map((group) => <details key={group.key} className="rounded-xl border border-red-200 bg-red-50/40 p-3"><summary className="cursor-pointer font-medium text-red-800">Missing {group.missingFields.map((field) => METADATA_FIELD_LABELS[field]).join(" + ")} ({group.rows.length})</summary><div className="mt-3 grid gap-2">{group.rows.map(({ record, missingFields }) => <div key={record.internalId} className="rounded-lg border bg-white p-3"><RecordSummary record={record} /><div className="mt-2 flex flex-wrap items-center gap-2">{missingFields.map((field) => <span key={field} className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">Missing {METADATA_FIELD_LABELS[field]}</span>)}<Button size="sm" variant="outline" className="ml-auto" onClick={() => { setJumpTo({ from: record.range.from, to: record.range.to, nonce: Date.now() }); setStep("import"); }}>Jump to source</Button></div></div>)}</div></details>)}{!metadataPreview.removals.length && <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-green-800">Every deduplicated record satisfies the current metadata requirements.</div>}</div>
              {metadataConfirmed && !metadataReady && <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">The deduplicated records or required fields changed. Apply the metadata requirements again.</div>}
              <GateList items={[{ ok: dedupReady, label: "Duplicate resolution is complete and current." }, { ok: metadataReady, label: metadataReady ? "Metadata requirements are applied and current." : "Apply the current metadata requirements." }]} />
              <div className="flex flex-wrap justify-between gap-2"><Button variant="outline" onClick={() => setStep("dedup")}>Back</Button><div className="flex gap-2"><Button onClick={() => { setMetadataConfirmed(true); setMetadataAppliedSignature(currentMetadataSignature); setMessage(`Applied metadata requirements: ${metadataPreview.removals.length} record(s) removed before screening.`); }}><Check className="mr-2 h-4 w-4" />Apply metadata requirements</Button><Button disabled={!metadataReady} onClick={() => setStep("query")}>Continue to query<ChevronRight className="ml-2 h-4 w-4" /></Button></div></div>
            </CardContent></Card>
          </TabsContent>

          <TabsContent value="query">
            <Card><CardContent className="grid gap-5 p-5 md:p-6">
              <div><h2 className="text-xl font-semibold">Define query and screen</h2><p className="text-sm text-slate-600">The Boolean text imports blocks. Once applied, the editable blocks are authoritative.</p></div>
              <div className="grid gap-2"><div className="flex justify-between"><Label>Boolean query import draft</Label><Button onClick={applyQueryString}><Filter className="mr-2 h-4 w-4" />Parse query to blocks</Button></div><Textarea value={queryString} onChange={(event) => { setQueryString(event.target.value); setQueryParseErrors([]); }} className="min-h-28 font-mono" placeholder={'("virtual reality" OR immersive) AND NOT (review OR survey)'} />{queryParseErrors.length > 0 && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{queryParseErrors.map((error, index) => <div key={`${error.position}-${index}`}>Position {error.position + 1}: {error.message}</div>)}</div>}</div>
              <div className="grid gap-2"><Label>Current generated expression</Label><div className="rounded-xl border bg-slate-50 p-3 font-mono text-sm">{generateBooleanQuery(config) || "No valid blocks"}</div></div>
              <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-3 text-sm"><span>Case-insensitive</span><Switch checked={config.caseInsensitive} onCheckedChange={(checked) => setConfig((current) => ({ ...current, caseInsensitive: checked }))} /><span className="ml-2 font-medium">Search fields:</span>{(["title", "abstract", "keywords"] as const).map((field) => <label key={field} className="flex items-center gap-2 capitalize"><Switch checked={config.searchFields[field]} onCheckedChange={(checked) => setConfig((current) => ({ ...current, searchFields: { ...current.searchFields, [field]: checked } }))} />{field}</label>)}</div><Button onClick={() => setConfig((current) => ({ ...current, blocks: [...current.blocks, { id: uid(), name: `Block ${current.blocks.length + 1}`, terms: [""] }], operators: [...current.operators, "AND"] }))}><Plus className="mr-2 h-4 w-4" />Add block</Button></div>
              <div className="grid gap-4">{config.blocks.map((block, blockIndex) => <div key={block.id} className={`rounded-xl border p-4 ${block.exclude ? "border-red-200 bg-red-50" : "bg-white"}`}><div className="flex flex-wrap items-center gap-3"><Input value={block.name} className="max-w-xs" onChange={(event) => updateBlock(blockIndex, { name: event.target.value })} /><label className="flex items-center gap-2 text-sm">Regex <Switch checked={!!block.isRegex} onCheckedChange={(checked) => updateBlock(blockIndex, { isRegex: checked })} /></label><label className="flex items-center gap-2 text-sm">Exclude (NOT) <Switch checked={!!block.exclude} onCheckedChange={(checked) => updateBlock(blockIndex, { exclude: checked })} /></label><Button variant="ghost" className="ml-auto text-red-700" onClick={() => setConfig((current) => { const blocks = current.blocks.filter((item) => item.id !== block.id); return { ...current, blocks, operators: Array.from({ length: Math.max(0, blocks.length - 1) }, () => "AND") }; })}><Trash2 className="mr-2 h-4 w-4" />Remove</Button></div><div className="mt-3 grid gap-2">{block.terms.map((term, termIndex) => <div key={termIndex} className="flex gap-2"><Input value={term} placeholder={block.isRegex ? "regular expression" : "literal term or trailing wildcard*"} onChange={(event) => { const terms = [...block.terms]; terms[termIndex] = event.target.value; updateBlock(blockIndex, { terms }); }} /><Button variant="ghost" onClick={() => updateBlock(blockIndex, { terms: block.terms.filter((_, index) => index !== termIndex) })}><Trash2 className="h-4 w-4" /></Button></div>)}<Button variant="outline" onClick={() => updateBlock(blockIndex, { terms: [...block.terms, ""] })}><Plus className="mr-2 h-4 w-4" />Add term</Button></div>{blockIndex < config.blocks.length - 1 && <div className="mt-3 text-center text-xs font-medium text-slate-500">AND — all required blocks must match</div>}</div>)}</div>
              <GateList items={queryChecklist} />
              <div className="flex justify-between"><Button variant="outline" onClick={() => setStep("metadata")}>Back</Button><Button disabled={!readyToScreen || running} onClick={runScreening}><Play className="mr-2 h-4 w-4" />{running ? "Screening…" : `Run screening on ${metadataPreview.retainedRecords.length} records`}</Button></div>
            </CardContent></Card>
          </TabsContent>

          <TabsContent value="results">
            <Card><CardContent className="grid gap-5 p-5 md:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Results and audit exports</h2><p className="text-sm text-slate-600">Automatic pre-full-text cleanup and screening results from the last successful run.</p></div><div className="flex flex-wrap gap-2"><Button disabled={resultsStale || !runOutput || generatingWorkbook} onClick={() => void exportWorkbook()}><FileSpreadsheet className="mr-2 h-4 w-4" />{generatingWorkbook ? "Generating workbook…" : "Download complete workbook"}</Button><Button variant="outline" disabled={resultsStale || !runOutput?.keptRecords.length || generatingWorkbook} onClick={() => { if (!runOutput) return; download("matches.bib", buildUniqueBibtex(runOutput.keptRecords).bibtex); }}><FileText className="mr-2 h-4 w-4" />Kept .bib</Button></div></div>
              {resultsStale && <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">These results are out of date because an upstream input or decision changed. Review the gated steps and run screening again; exports are disabled.</div>}
              {workbookError && <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900">{workbookError}</div>}
              {runOutput ? <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">{[
                  ["Entry headers", runOutput.entryHeaders], ["Structurally valid", runOutput.structurallyValid], ["Duplicates removed", runOutput.duplicateAudit.length], ["Metadata removed", runOutput.metadataRemovals.length], ["Screened", runOutput.screenedRecords.length], ["Kept", runOutput.kept.length], ["Excluded", runOutput.excluded.length],
                ].map(([label, value]) => <div key={String(label)} className="rounded-xl border bg-white p-3"><div className="text-xs text-slate-500">{label}</div><div className="text-2xl font-semibold">{value}</div></div>)}</div>
                <ResultsPreview kept={runOutput.kept} excluded={runOutput.excluded} blocks={runOutput.blocks} stale={resultsStale} />
                <details className="rounded-xl border bg-white p-4"><summary className="cursor-pointer font-medium">Matched-term statistics ({runOutput.termCounts.length})</summary><div className="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-3">{runOutput.termCounts.map((item) => <div key={item.term} className="flex justify-between rounded-lg border px-3 py-2 text-sm"><span>{item.term}</span><span className="font-medium">{item.count}</span></div>)}</div></details>
              </> : <div className="rounded-xl border p-8 text-center text-slate-500">Complete the preceding steps and run screening to create results.</div>}
            </CardContent></Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
