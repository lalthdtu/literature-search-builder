import { useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Download, FileText, Filter, Play, Plus, Save, Trash2, Upload, Wrench } from "lucide-react";

/* ================= Types ================= */

type Operator = "AND" | "OR";

type Block = {
  id: string;
  name: string;
  terms: string[]; // plain strings; interpret as regex if isRegex = true
  isRegex?: boolean;
  exclude?: boolean; // NOT block
};

type QueryConfig = {
  blocks: Block[];
  operators: Operator[]; // operators[i] is between blocks[i] and blocks[i+1]
  caseInsensitive: boolean;
  searchFields: {
    title: boolean;
    abstract: boolean;
    keywords: boolean;
  };
};

/* ================= Helpers ================= */

const uid = () => Math.random().toString(36).slice(2);

const DEFAULT_CONFIG: QueryConfig = {
  caseInsensitive: true,
  searchFields: { title: true, abstract: true, keywords: true },
  blocks: [
    {
      id: uid(),
      name: "Group 1",
      terms: ["immersive virtual reality", "virtual reality"],
    },
    {
      id: uid(),
      name: "Group 2",
      terms: ["remote experiment", "remote participation", "remote study", "remote VR", "online study", "home\\w*", "participant[-\\s]?owned HMD", "participant[-\\s]?provided HMD", "self[-\\s]?administered", "unsupervised", "participant[-\\s]?led", "self[-\\s]?conducted", "web[-\\s]?based", "crowdsourc\\w*", "prolific", "amazon mechanical turk", "MTurk", "out[-\\s]?of[-\\s]?lab", "outside the lab", "decentralized"],
      isRegex: true,
    },
    {
      id: uid(),
      name: "Group 3",
      terms: ["user", "online", "study", "experiment", "behavior", "cognition", "evaluation", "empirical", "perception", "participant", "controlled", "task performance", "human[-\\s]?subject", "data collection"],
      isRegex: true,
    },
  ],
  operators: ["AND", "AND"],
};

function safeRegExp(pattern: string, flags: string) {
  try {
    return new RegExp(pattern, flags);
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, flags);
  }
}

// Minimal BibTeX parsing (tolerant)
function parseBibtexEntries(text: string) {
  const entries: any[] = [];
  const atIndices: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "@") atIndices.push(i);

  for (let idx = 0; idx < atIndices.length; idx++) {
    const start = atIndices[idx];
    const end = idx + 1 < atIndices.length ? atIndices[idx + 1] : text.length;
    const chunk = text.slice(start, end).trim();
    if (!chunk.startsWith("@")) continue;

    const headerMatch = chunk.match(/^@(\w+)\s*\{\s*([^,]+)\s*,/s);
    if (!headerMatch) continue;
    const entry_type = headerMatch[1];
    const citekey = headerMatch[2];

    const fields: Record<string, string> = {};
    const fieldRe = /(\w+)\s*=\s*("(?:\\.|[^"\\])*"|\{(?:\\.|[^{}]|\{[^{}]*\})*\})\s*,?/gis;
    let m: RegExpExecArray | null;
    while ((m = fieldRe.exec(chunk))) {
      const key = m[1].toLowerCase();
      const valRaw = m[2].trim();
      let val = valRaw;
      if ((val.startsWith("{") && val.endsWith("}")) || (val.startsWith('"') && val.endsWith('"'))) {
        val = val.slice(1, -1);
      }
      fields[key] = val;
    }

    entries.push({ entry_type, citekey, ...fields, __raw: chunk });
  }
  return entries;
}

function buildBibEntry(entry: any) {
  const { entry_type, citekey, __raw, ...fields } = entry;
  const ordered = Object.entries(fields)
    .filter(([k]) => !k.startsWith("__"))
    .map(([k, v]) => `  ${k} = {${v}}`)
    .join(",\n");
  return `@${entry_type}{${citekey},\n${ordered}\n}`;
}

function csvEscape(s: string) {
  if (s == null) return "";
  const needs = /[",\n]/.test(s);
  const t = String(s).replace(/"/g, '""');
  return needs ? `"${t}"` : t;
}

function toCSV(rows: any[]) {
  const headers = ["CiteKey", "Title", "Authors", "Year", "Venue", "URL/DOI", "Matched Blocks", "Matched Terms (by block & field)"];
  const body = rows.map((r) => [r.CiteKey, r.Title, r.Authors, r.Year, r.Venue, r.URL, r.MatchedBlocks, r.MatchedTermsDetail].map(csvEscape).join(",")).join("\n");
  return headers.join(",") + "\n" + body;
}

function download(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function evaluateQueryOnText(_text: string, cfg: QueryConfig) {
  const flags = cfg.caseInsensitive ? "i" : "";
  const compiled = cfg.blocks
    .map((b, idx) => {
      const terms = (b.terms || []).filter((t) => t.trim().length > 0);
      if (terms.length === 0) return null;
      const regexes = terms.map((t) => (b.isRegex ? safeRegExp(t, flags) : safeRegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)));
      return { index: idx, name: b.name || `Block ${idx + 1}`, block: b, terms, regexes };
    })
    .filter(Boolean) as { index: number; name: string; block: Block; terms: string[]; regexes: RegExp[] }[];

  // Returns ok + matched blocks + detailed per-field term hits
  return function matchesByFields(fields: { title?: string; abstract?: string; keywords?: string }, selected: { title: boolean; abstract: boolean; keywords: boolean }) {
    const texts: Record<"title" | "abstract" | "keywords", string> = {
      title: selected.title ? fields.title || "" : "",
      abstract: selected.abstract ? fields.abstract || "" : "",
      keywords: selected.keywords ? fields.keywords || "" : "",
    };

    const matchedBlocks: string[] = [];
    const detailed: Record<string, { title?: string[]; abstract?: string[]; keywords?: string[] }> = {};

    const blockHitAtLeastOne = (cidx: number) => {
      const c = compiled[cidx];
      let any = false;
      const perFieldHits: { title?: string[]; abstract?: string[]; keywords?: string[] } = {};
      (Object.keys(texts) as Array<keyof typeof texts>).forEach((field) => {
        const t = texts[field];
        if (!t) return;
        const hits: string[] = [];
        c.regexes.forEach((re, i) => {
          if (re.test(t)) hits.push(c.terms[i]);
        });
        if (hits.length > 0) {
          (perFieldHits as any)[field] = hits;
          any = true;
        }
      });
      // Store details only for *positive* blocks (NOT blocks are diagnostic, not in report)
      if (any && !compiled[cidx].block.exclude) detailed[compiled[cidx].name] = perFieldHits;
      return any;
    };

    if (compiled.length === 0) return { ok: true, matchedBlocks, detailed };

    // First block
    const firstHit = blockHitAtLeastOne(0);
    let val = compiled[0].block.exclude ? !firstHit : firstHit;
    if (!compiled[0].block.exclude && firstHit) matchedBlocks.push(compiled[0].name);

    // Fold across operators
    for (let i = 0; i < cfg.operators.length && i + 1 < compiled.length; i++) {
      const cidx = i + 1;
      const hit = blockHitAtLeastOne(cidx);
      const rhs = compiled[cidx].block.exclude ? !hit : hit;
      const op = cfg.operators[i];
      val = op === "AND" ? val && rhs : val || rhs;
      if (!compiled[cidx].block.exclude && hit) matchedBlocks.push(compiled[cidx].name);
    }

    return { ok: val, matchedBlocks, detailed };
  };
}

/* ======== Parse pasted Boolean query into blocks/operators ======== */
function parseBooleanQuery(input: string) {
  if (!input) return null;
  const s = input.replace(/\s+/g, " ").trim();

  // 1) Split top-level groups by AND
  const groups: string[] = [];
  let buf = "";
  let depth = 0;
  let inQuote = false;
  let quoteChar = "";

  const pushGroup = () => {
    if (buf.trim().length) groups.push(buf.trim());
    buf = "";
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true;
      quoteChar = ch;
      buf += ch;
      continue;
    }
    if (inQuote) {
      buf += ch;
      if (ch === quoteChar) {
        inQuote = false;
        quoteChar = "";
      }
      continue;
    }
    if (ch === "(") {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      buf += ch;
      continue;
    }

    // split on standalone AND at top level
    if (depth === 0 && s.slice(i, i + 3).toUpperCase() === "AND") {
      const prev = s[i - 1],
        next = s[i + 3];
      if ((prev === " " || prev === ")") && (next === " " || next === "(" || next === undefined)) {
        pushGroup();
        i += 2;
        continue;
      }
    }
    buf += ch;
  }
  pushGroup();

  // 2) For each group, split top-level ORs into terms
  const blocks: Block[] = [];
  const operators: Operator[] = [];

  groups.forEach((group, gi) => {
    let g = group.trim();

    // support NOT prefix (optional)
    let exclude = false;
    if (/^NOT\s+/i.test(g)) {
      exclude = true;
      g = g.replace(/^NOT\s+/i, "").trim();
    }

    // strip outer parentheses
    if (g.startsWith("(") && g.endsWith(")")) g = g.slice(1, -1).trim();

    const terms: string[] = [];
    let tb = "";
    depth = 0;
    inQuote = false;
    quoteChar = "";
    const pushTerm = () => {
      const t = tb.trim();
      if (t) terms.push(t);
      tb = "";
    };

    for (let i = 0; i < g.length; i++) {
      const ch = g[i];

      if (!inQuote && (ch === '"' || ch === "'")) {
        inQuote = true;
        quoteChar = ch;
        tb += ch;
        continue;
      }
      if (inQuote) {
        tb += ch;
        if (ch === quoteChar) {
          inQuote = false;
          quoteChar = "";
        }
        continue;
      }
      if (ch === "(") {
        depth++;
        tb += ch;
        continue;
      }
      if (ch === ")") {
        depth = Math.max(0, depth - 1);
        tb += ch;
        continue;
      }

      // split on standalone OR at top level
      if (depth === 0 && g.slice(i, i + 2).toUpperCase() === "OR") {
        const prev = g[i - 1],
          next = g[i + 2];
        if ((prev === " " || prev === ")") && (next === " " || next === "(" || next === undefined)) {
          pushTerm();
          i += 1;
          continue;
        }
      }
      tb += ch;
    }
    pushTerm();

    const cleanTerms = terms.map((t) => t.replace(/^["']|["']$/g, "").trim()).filter(Boolean);

    blocks.push({
      id: uid(),
      name: `Group ${gi + 1}`,
      terms: cleanTerms,
      isRegex: false,
      exclude,
    });

    if (gi < groups.length - 1) operators.push("AND");
  });

  return { blocks, operators };
}

/* ================= App ================= */

export default function App() {
  const [bib, setBib] = useState<string>("");
  const [cfg, setCfg] = useState<QueryConfig>(DEFAULT_CONFIG);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const [report, setReport] = useState<any | null>(null);
  const [queryString, setQueryString] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);

  const addBlockAt = (index: number) => {
    const nb: Block = { id: uid(), name: `Block ${cfg.blocks.length + 1}`, terms: [""], isRegex: false };
    const blocks = [...cfg.blocks.slice(0, index), nb, ...cfg.blocks.slice(index)];
    const operators = [...cfg.operators];
    if (index === 0) operators.unshift("AND");
    else operators.splice(index, 0, "AND");
    setCfg({ ...cfg, blocks, operators });
  };

  const removeBlock = (id: string, idx: number) => {
    const blocks = cfg.blocks.filter((b) => b.id !== id);
    let operators = [...cfg.operators];
    if (operators.length > 0) {
      if (idx === 0) operators.shift();
      else operators.splice(idx - 1, 1);
    }
    setCfg({ ...cfg, blocks, operators });
  };

  const updateBlock = (index: number, patch: Partial<Block>) => {
    const blocks = [...cfg.blocks];
    blocks[index] = { ...blocks[index], ...patch };
    setCfg({ ...cfg, blocks });
  };

  const updateOperator = (index: number, op: Operator) => {
    const operators = [...cfg.operators];
    operators[index] = op;
    setCfg({ ...cfg, operators });
  };

  const run = () => {
    setRunning(true);
    try {
      const entries = parseBibtexEntries(bib);
      const matcher = evaluateQueryOnText(bib, cfg);

      let eligible = 0; // entries with at least one selected field present
      let matched = 0;
      const rows: any[] = [];
      const matchedBibEntries: string[] = [];

      for (const e of entries) {
        const title = (e.title || "").toString();
        const abstract = (e.abstract || e.abs || e.summary || "").toString();
        const keywords = (e.keywords || e.keyword || "").toString();

        const hasAny = (cfg.searchFields.title && title) || (cfg.searchFields.abstract && abstract) || (cfg.searchFields.keywords && keywords);
        if (hasAny) eligible++;

        const { ok, matchedBlocks, detailed } = matcher({ title, abstract, keywords }, cfg.searchFields);

        if (ok && hasAny) {
          matched++;
          const cleanTitle = title.replace(/\s+/g, " ").replace(/[{}]/g, "").trim();
          const authors = (e.author || "").replace(/\s+/g, " ").trim();
          const year = (e.year || "").trim();
          const venue = (e.booktitle || e.journal || "").replace(/\s+/g, " ").trim();
          const doi = (e.doi || "").trim();
          const url = (e.url || (doi ? `https://doi.org/${doi}` : "")).trim();

          // Compact detail string for CSV
          const detailPieces: string[] = [];
          Object.entries(detailed).forEach(([blockName, fields]) => {
            const parts: string[] = [];
            if (fields.title?.length) parts.push(`Title: ${fields.title.join(" | ")}`);
            if (fields.abstract?.length) parts.push(`Abstract: ${fields.abstract.join(" | ")}`);
            if (fields.keywords?.length) parts.push(`Keywords: ${fields.keywords.join(" | ")}`);
            if (parts.length) detailPieces.push(`${blockName} [${parts.join("; ")}]`);
          });

          rows.push({
            CiteKey: e.citekey,
            Title: cleanTitle,
            Authors: authors,
            Year: year,
            Venue: venue,
            URL: url,
            MatchedBlocks: matchedBlocks.join("; "),
            MatchedTermsDetail: detailPieces.join("; "),
            MatchedTermsMap: detailed, // used for on-screen chips
          });

          matchedBibEntries.push(buildBibEntry(e));
        }
      }

      setResults(rows);
      setReport({ total: entries.length, eligible, matched, unmatched: Math.max(0, eligible - matched) });
      (window as any).__matched_bib__ = matchedBibEntries.join("\n\n");
    } finally {
      setRunning(false);
    }
  };

  const loadSample = () => {
    const sample = `@article{sample1,
  title={A remote study of immersive virtual reality task performance},
  author={Doe, Jane},
  year={2024},
  journal={Imaginary Journal},
  abstract={We conducted an online study using immersive virtual reality with participant-owned HMDs to evaluate behavior and task performance.}
}

@inproceedings{sample2,
  title={On-site VR art},
  author={Roe, John},
  year={2023},
  booktitle={Nice Conf},
  abstract={An on-site installation without user study.}
}`;
    setBib(sample);
  };

  const saveConfig = () => {
    const json = JSON.stringify(cfg, null, 2);
    download("query_config.json", json, "application/json");
  };

  const loadConfig = (file: File) => {
    file.text().then((t) => {
      try {
        const obj = JSON.parse(t);
        if (obj.blocks && obj.operators) setCfg(obj);
      } catch {}
    });
  };

  const exportCSV = () => {
    if (!results || results.length === 0) return;
    download("matches.csv", toCSV(results), "text/csv");
  };

  const exportBib = () => {
    const bibText = (window as any).__matched_bib__ || "";
    download("matches.bib", bibText, "text/plain");
  };

  const applyPastedQuery = () => {
    const parsed = parseBooleanQuery(queryString);
    if (parsed) setCfg({ ...cfg, blocks: parsed.blocks, operators: parsed.operators });
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-slate-50 p-6">
      <div className="mx-auto max-w-6xl grid gap-6">
        <header className="flex items-center justify-between">
          <h1 className="text-3xl font-semibold tracking-tight">Literature Search Builder</h1>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={saveConfig} title="Save query config">
              <Save className="h-4 w-4 mr-2" />
              Save Config
            </Button>
            <Button variant="secondary" onClick={() => fileRef.current?.click()} title="Load query config">
              <Upload className="h-4 w-4 mr-2" />
              Load Config
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) loadConfig(f);
                e.currentTarget.value = "";
              }}
            />
          </div>
        </header>

        <Tabs defaultValue="data">
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="data">1. Paste BibTeX</TabsTrigger>
            <TabsTrigger value="query">2. Build Query</TabsTrigger>
            <TabsTrigger value="run">3. Run & Report</TabsTrigger>
          </TabsList>

          <TabsContent value="data">
            <Card className="shadow-sm">
              <CardContent className="p-6 grid gap-4">
                <div className="flex items-center justify-between">
                  <Label className="text-base">BibTeX input</Label>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={loadSample}>
                      <FileText className="h-4 w-4 mr-2" />
                      Load Sample
                    </Button>
                    <Button variant="outline" onClick={() => setBib("")}>
                      <Trash2 className="h-4 w-4 mr-2" />
                      Clear
                    </Button>
                  </div>
                </div>
                <Textarea value={bib} onChange={(e) => setBib(e.target.value)} placeholder="Paste your .bib content here" className="min-h-[280px] font-mono text-sm" />
                <p className="text-sm text-slate-500">Tip: you can paste the BibTeX you exported (e.g., from IEEE/ACM). Abstracts are required for matching.</p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="query">
            <Card className="shadow-sm">
              <CardContent className="p-6 grid gap-6">
                {/* Paste Boolean query and auto-build blocks */}
                <div className="grid gap-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-base">Paste Boolean Query</Label>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setQueryString("")}>
                        {" "}
                        <Trash2 className="h-4 w-4 mr-2" />
                        Clear
                      </Button>
                      <Button onClick={applyPastedQuery}>
                        {" "}
                        <Filter className="h-4 w-4 mr-2" />
                        Parse to Blocks
                      </Button>
                    </div>
                  </div>
                  <Textarea value={queryString} onChange={(e) => setQueryString(e.target.value)} placeholder={`("virtual reality" OR "immersive virtual reality") AND ("remote study" OR "online study") AND ("participant")`} className="min-h-[120px] font-mono text-sm" />
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <Label className="text-base">Query Blocks</Label>
                    <div className="flex items-center gap-2 text-sm text-slate-600">
                      <Wrench className="h-4 w-4" />
                      <span>Case-insensitive</span>
                      <Switch checked={cfg.caseInsensitive} onCheckedChange={(v) => setCfg({ ...cfg, caseInsensitive: v })} />

                      <span className="ml-4">Fields:</span>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-600">Title</span>
                        <Switch checked={cfg.searchFields.title} onCheckedChange={(v) => setCfg({ ...cfg, searchFields: { ...cfg.searchFields, title: v } })} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-600">Abstract</span>
                        <Switch checked={cfg.searchFields.abstract} onCheckedChange={(v) => setCfg({ ...cfg, searchFields: { ...cfg.searchFields, abstract: v } })} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-600">Keywords</span>
                        <Switch checked={cfg.searchFields.keywords} onCheckedChange={(v) => setCfg({ ...cfg, searchFields: { ...cfg.searchFields, keywords: v } })} />
                      </div>
                    </div>
                  </div>
                  <Button onClick={() => addBlockAt(cfg.blocks.length)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Block
                  </Button>
                </div>

                <div className="grid gap-4">
                  {cfg.blocks.map((b, i) => (
                    <div key={b.id} className="rounded-2xl border bg-white shadow-sm p-4">
                      <div className="flex flex-wrap items-center gap-3 justify-between">
                        <div className="flex items-center gap-3">
                          <Input value={b.name} onChange={(e) => updateBlock(i, { name: e.target.value })} className="w-56" />
                          <div className="flex items-center gap-2 text-sm text-slate-600">
                            <span>Regex</span>
                            <Switch checked={!!b.isRegex} onCheckedChange={(v) => updateBlock(i, { isRegex: v })} />
                          </div>
                          <div className="flex items-center gap-2 text-sm text-slate-600">
                            <span>Exclude (NOT)</span>
                            <Switch checked={!!b.exclude} onCheckedChange={(v) => updateBlock(i, { exclude: v })} />
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="destructive" onClick={() => removeBlock(b.id, i)}>
                            <Trash2 className="h-4 w-4 mr-2" />
                            Remove
                          </Button>
                          <Button variant="outline" onClick={() => addBlockAt(i)}>
                            <Plus className="h-4 w-4 mr-2" />
                            Insert Above
                          </Button>
                          <Button variant="outline" onClick={() => addBlockAt(i + 1)}>
                            <Plus className="h-4 w-4 mr-2" />
                            Insert Below
                          </Button>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2">
                        {b.terms.map((t, ti) => (
                          <div key={ti} className="flex items-center gap-2">
                            <Input
                              value={t}
                              onChange={(e) => {
                                const terms = [...b.terms];
                                terms[ti] = e.target.value;
                                updateBlock(i, { terms });
                              }}
                              placeholder={b.isRegex ? "regex term" : "literal term"}
                            />
                            <Button
                              variant="ghost"
                              onClick={() => {
                                const terms = b.terms.filter((_, k) => k !== ti);
                                updateBlock(i, { terms });
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                        <Button variant="secondary" onClick={() => updateBlock(i, { terms: [...b.terms, ""] })}>
                          <Plus className="h-4 w-4 mr-2" />
                          Add term
                        </Button>
                      </div>

                      {i < cfg.blocks.length - 1 && (
                        <div className="mt-4 flex items-center justify-center gap-3">
                          <Select value={cfg.operators[i]} onValueChange={(v: Operator) => updateOperator(i, v as Operator)}>
                            <SelectTrigger className="w-40">
                              <SelectValue placeholder={cfg.operators[i]} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="AND">AND</SelectItem>
                              <SelectItem value="OR">OR</SelectItem>
                            </SelectContent>
                          </Select>
                          <span className="text-sm text-slate-500">(operator to next block)</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="run">
            <Card className="shadow-sm">
              <CardContent className="p-6 grid gap-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-slate-700">
                    <Filter className="h-4 w-4" /> Ready to filter
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={run} disabled={running}>
                      <Play className="h-4 w-4 mr-2" />
                      {running ? "Running..." : "Execute"}
                    </Button>
                    <Button variant="outline" onClick={exportCSV} disabled={!results || results.length === 0}>
                      <Download className="h-4 w-4 mr-2" />
                      Export CSV
                    </Button>
                    <Button variant="outline" onClick={exportBib} disabled={!results || results.length === 0}>
                      <Download className="h-4 w-4 mr-2" />
                      Export .bib
                    </Button>
                  </div>
                </div>

                {report && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="rounded-2xl border p-4 bg-white shadow-sm">
                      <div className="text-xs text-slate-500">Total entries</div>
                      <div className="text-2xl font-semibold">{report.total}</div>
                    </div>
                    <div className="rounded-2xl border p-4 bg-white shadow-sm">
                      <div className="text-xs text-slate-500">With selected fields</div>
                      <div className="text-2xl font-semibold">{report.eligible}</div>
                    </div>
                    <div className="rounded-2xl border p-4 bg-white shadow-sm">
                      <div className="text-xs text-slate-500">Matched</div>
                      <div className="text-2xl font-semibold">{report.matched}</div>
                    </div>
                    <div className="rounded-2xl border p-4 bg-white shadow-sm">
                      <div className="text-xs text-slate-500">Unmatched (with abstract)</div>
                      <div className="text-2xl font-semibold">{report.unmatched}</div>
                    </div>
                  </div>
                )}

                {results && (
                  <div className="grid gap-3">
                    <div className="text-sm text-slate-600">{results.length} matching entries</div>
                    <div className="grid gap-3">
                      {results.map((r, idx) => (
                        <div key={idx} className="rounded-2xl border bg-white p-4 shadow-sm">
                          <div className="text-sm text-slate-500">
                            {r.CiteKey} · {r.Year}
                          </div>
                          <div className="text-lg font-medium leading-snug mt-1">{r.Title || "(No title)"}</div>
                          <div className="text-sm text-slate-600 mt-1">{r.Authors}</div>
                          <div className="text-sm text-slate-600">{r.Venue}</div>
                          {r.URL && (
                            <a className="text-sm text-blue-600 underline mt-1 inline-block" href={r.URL} target="_blank" rel="noreferrer">
                              Open
                            </a>
                          )}

                          {r.MatchedBlocks && <div className="text-xs text-slate-500 mt-2">Matched blocks: {r.MatchedBlocks}</div>}

                          {r.MatchedTermsMap && (
                            <div className="mt-2">
                              <div className="text-xs text-slate-500 mb-1">Where terms matched (by block & field):</div>
                              <div className="grid gap-1">
                                {Object.entries(r.MatchedTermsMap).map(([block, fields]: any, i: number) => (
                                  <div key={i} className="text-xs">
                                    <span className="font-medium">{block}:</span>{" "}
                                    {["title", "abstract", "keywords"].map((f) =>
                                      (fields as any)[f]?.length ? (
                                        <span key={f} className="inline-block ml-2">
                                          <span className="uppercase tracking-wide text-slate-500">{f}:</span>{" "}
                                          <span className="inline-flex flex-wrap gap-1 align-middle">
                                            {(fields as any)[f].map((t: string, j: number) => (
                                              <span key={j} className="rounded-full border px-2 py-0.5 bg-slate-50">
                                                {t}
                                              </span>
                                            ))}
                                          </span>
                                        </span>
                                      ) : null
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!results && <div className="text-sm text-slate-500">Run the query to see a summarized report and the matching references.</div>}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <footer className="text-center text-xs text-slate-500 py-4">Built for visual, block-based literature filtering. Paste a Boolean query to auto-build blocks, tweak AND/OR/NOT, then execute.</footer>
      </div>
    </div>
  );
}
