import { useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Download, FileText, Filter, Play, Plus, Save, Trash2, Upload, Wrench, CheckCircle, HelpCircle, XCircle } from "lucide-react";

type Operator = "AND" | "OR";

type Block = {
  id: string;
  name: string;
  terms: string[];
  isRegex?: boolean;
  exclude?: boolean;
};

type QueryConfig = {
  blocks: Block[];
  operators: Operator[];
  caseInsensitive: boolean;
  searchFields: {
    title: boolean;
    abstract: boolean;
    keywords: boolean;
  };
};

type RunOutput = {
  matched: any[];
  partial: any[];
  unmatched: any[];
  report: {
    total: number;
    eligible: number;
    matched: number;
    partial: number;
    unmatched: number;
  };
  termStats: any;
};

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

type FieldName = "title" | "abstract" | "keywords";

function colorForBlockName(name: string, cfg: any) {
  const idx = Math.max(
    0,
    cfg.blocks.findIndex((b: any, i: number) => (b.name || `Block ${i + 1}`) === name)
  );
  const palette = [
    { bg: "#F1F5FF", border: "#3B82F6" },
    { bg: "#FDF2F8", border: "#EC4899" },
    { bg: "#ECFDF5", border: "#10B981" },
    { bg: "#FEF3C7", border: "#F59E0B" },
    { bg: "#FEE2E2", border: "#EF4444" },
    { bg: "#EDE9FE", border: "#8B5CF6" },
  ];
  return palette[idx % palette.length];
}

function totalHits(fields: any) {
  return (fields?.title?.length || 0) + (fields?.abstract?.length || 0) + (fields?.keywords?.length || 0);
}

function MatchBreakdown({ cfg, matchedMap, caption }: { cfg: any; matchedMap: any; caption?: string }) {
  const entries = Object.entries(matchedMap || {})
    .filter(([_, f]: any) => totalHits(f) > 0)
    .sort((a: any, b: any) => totalHits(b[1]) - totalHits(a[1]));

  return (
    <div className="mt-2">
      <div className="text-xs text-slate-500 mb-1">Where terms matched (by block &amp; field){caption ? ` — ${caption}` : ""}</div>

      {entries.length === 0 ? (
        <div className="text-xs text-slate-500">No term hits in selected fields.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map(([block, fields]: any) => {
            const { bg, border } = colorForBlockName(block, cfg);
            const pills = [
              { key: "Title", list: fields.title || [] },
              { key: "Abstract", list: fields.abstract || [] },
              { key: "Keywords", list: fields.keywords || [] },
            ].filter((p) => p.list.length > 0);

            return (
              <div key={block} className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-2 rounded-full border px-2 py-0.5 text-xs" style={{ background: bg, borderColor: border }} title={block}>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: border }} />
                  {block}
                </span>

                {pills.map((p) => (
                  <span key={p.key} className="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]" style={{ borderColor: border }} title={p.list.join(" • ")}>
                    {p.key} <span className="ml-1 tabular-nums">({p.list.length})</span>
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function escapeHTML(s: string) {
  return (s || "").replace(
    /[&<>"']/g,
    (ch) =>
      ((
        {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        } as const
      )[ch]!)
  );
}

function compileRegexForBlockField(blockCfg: { name?: string; isRegex?: boolean } | undefined, hits: string[] | undefined, caseInsensitive: boolean): RegExp | null {
  if (!blockCfg || !hits?.length) return null;
  const sortDesc = (a: string, b: string) => b.length - a.length;

  const source = `(?:${[...hits]
    .sort(sortDesc)
    .map((h) => toSmartWordPattern(h, !!blockCfg.isRegex))
    .join("|")})`;

  const flags = `g${caseInsensitive ? "i" : ""}`;
  return new RegExp(source, flags);
}

type Span = { start: number; end: number; block: string; text: string };

function collectSpans(text: string, arr: Array<{ block: string; re: RegExp }>): Span[] {
  const spans: Span[] = [];
  for (const { block, re } of arr) {
    const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text))) {
      spans.push({
        start: m.index,
        end: m.index + m[0].length,
        block,
        text: m[0],
      });
      if (m[0].length === 0) rx.lastIndex++;
    }
  }

  spans.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const picked: Span[] = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start >= lastEnd) {
      picked.push(s);
      lastEnd = s.end;
    }
  }
  return picked;
}

function highlightByBlocks(text: string, matchedTermsMap: Record<string, Partial<Record<FieldName, string[]>>>, cfg: QueryConfig, field: FieldName) {
  if (!text) return "";
  const perBlock: Array<{ block: string; re: RegExp }> = [];

  for (const [blockName, fields] of Object.entries(matchedTermsMap || {})) {
    const blockCfg = cfg.blocks.find((b) => (b.name || "") === blockName);
    const hits = (fields?.[field] || []) as string[];
    const re = compileRegexForBlockField(blockCfg, hits, !!cfg.caseInsensitive);
    if (re) perBlock.push({ block: blockName, re });
  }

  if (!perBlock.length) return escapeHTML(text);

  const spans = collectSpans(text, perBlock);
  if (!spans.length) return escapeHTML(text);

  let out = "";
  let pos = 0;
  for (const s of spans) {
    const { bg, border } = colorForBlockName(s.block, cfg);
    out += escapeHTML(text.slice(pos, s.start));
    out += `<mark class="hl" data-block="${escapeHTML(s.block)}" style="background:${bg};border:1px solid ${border};border-radius:0.25rem;padding:0 0.15em;">${escapeHTML(s.text)}</mark>`;
    pos = s.end;
  }
  out += escapeHTML(text.slice(pos));
  return out;
}

function parseBibtexEntries(text: string) {
  const entries: any[] = [];
  const src = text || "";
  let i = 0;
  const n = src.length;

  const headerRe = /^@(\w+)\s*\{\s*/;
  const fieldRe = /(\w+)\s*=\s*("(?:\\.|[^"\\])*"|\{(?:\\.|[^{}]|\{[^{}]*\})*\})\s*,?/gis;

  while (i < n) {
    const at = src.indexOf("@", i);
    if (at === -1) break;

    const head = src.slice(at);
    const m = head.match(headerRe);
    if (!m) {
      i = at + 1;
      continue;
    }

    const type = m[1];
    let j = at + m[0].length;

    let depth = 1;
    let inQuote = false;
    while (j < n) {
      const ch = src[j];

      if (ch === '"' && src[j - 1] !== "\\" && depth === 1) {
        inQuote = !inQuote;
        j++;
        continue;
      }

      if (!inQuote) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      j++;
    }

    const chunk = src.slice(at, j).trim();

    const citeKeyMatch = chunk.match(/^@\w+\s*\{\s*([^,]+)\s*,/s);
    if (!citeKeyMatch) {
      i = j;
      continue;
    }
    const citekey = citeKeyMatch[1];

    const fields: Record<string, string> = {};
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(chunk))) {
      const key = fm[1].toLowerCase();
      const valRaw = fm[2].trim();
      let val = valRaw;
      if ((val.startsWith("{") && val.endsWith("}")) || (val.startsWith('"') && val.endsWith('"'))) {
        val = val.slice(1, -1);
      }
      fields[key] = val;
    }

    entries.push({ entry_type: type, citekey, ...fields, __raw: chunk });
    i = j;
  }

  if (entries.length === 0 && src.trim().length > 0) {
    throw new Error("No BibTeX entries found. Did you forget the '@' symbol?");
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

function hasRegexMeta(s: string) {
  return /[\\.^$|()[\]?+{}]/.test(s);
}

function escExceptStar(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function toSmartWordPattern(term: string, isRegex: boolean) {
  const t = term.trim();

  if (isRegex && hasRegexMeta(t)) return t;

  const trailingStar = /\*$/.test(t);
  if (trailingStar) {
    const stem = escExceptStar(t.slice(0, -1));
    return `\\b${stem}[\\w-]*`;
  }

  return `\\b${escExceptStar(t)}\\b`;
}

function evaluateQueryOnText(_text: string, cfg: QueryConfig) {
  const flags = cfg.caseInsensitive ? "i" : "";
  const compiled = cfg.blocks
    .map((b, idx) => {
      const terms = (b.terms || []).filter((t) => t.trim().length > 0);
      if (terms.length === 0) return null;
      const regexes = terms.map((t) => safeRegExp(toSmartWordPattern(t, !!b.isRegex), flags));
      return {
        index: idx,
        name: b.name || `Block ${idx + 1}`,
        block: b,
        terms,
        regexes,
      };
    })
    .filter(Boolean) as {
    index: number;
    name: string;
    block: Block;
    terms: string[];
    regexes: RegExp[];
  }[];

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
      const perFieldHits: {
        title?: string[];
        abstract?: string[];
        keywords?: string[];
      } = {};
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
      if (any && !compiled[cidx].block.exclude) detailed[compiled[cidx].name] = perFieldHits;
      return any;
    };

    if (compiled.length === 0) return { ok: true, matchedBlocks, detailed };

    const firstHit = blockHitAtLeastOne(0);
    let val = compiled[0].block.exclude ? !firstHit : firstHit;
    if (!compiled[0].block.exclude && firstHit) matchedBlocks.push(compiled[0].name);

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

function parseBooleanQuery(input: string) {
  if (!input) return null;
  const s = input.replace(/\s+/g, " ").trim();

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

  const blocks: Block[] = [];
  const operators: Operator[] = [];

  groups.forEach((group, gi) => {
    let g = group.trim();

    let exclude = false;
    if (/^NOT\s+/i.test(g)) {
      exclude = true;
      g = g.replace(/^NOT\s+/i, "").trim();
    }

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

export default function App() {
  const [bib, setBib] = useState<string>("");
  const [cfg, setCfg] = useState<QueryConfig>(DEFAULT_CONFIG);
  const [running, setRunning] = useState(false);
  const [queryString, setQueryString] = useState<string>("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [matchedBib, setMatchedBib] = useState<string>("");
  const [runOutput, setRunOutput] = useState<RunOutput | null>(null);

  const addBlockAt = (index: number) => {
    const nb: Block = {
      id: uid(),
      name: `Block ${cfg.blocks.length + 1}`,
      terms: [""],
      isRegex: false,
    };
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

  function computeTermStats(rows: any[]) {
    type Field = "title" | "abstract" | "keywords";

    const overallDocCounts = new Map<string, number>();
    const overallFieldCounts: Record<Field, Map<string, number>> = {
      title: new Map(),
      abstract: new Map(),
      keywords: new Map(),
    };

    const perBlock: Record<string, Record<string, { docCount: number; fields: Record<Field, number> }>> = {};

    for (const r of rows) {
      const mtm = (r.MatchedTermsMap || {}) as Record<string, Partial<Record<Field, string[]>>>;

      const seenOverall = new Set<string>();
      const seenInBlock = new Map<string, Set<string>>();

      for (const [blockName, fields] of Object.entries(mtm)) {
        perBlock[blockName] ||= {};
        if (!seenInBlock.has(blockName)) seenInBlock.set(blockName, new Set());

        (["title", "abstract", "keywords"] as Field[]).forEach((f) => {
          const terms = (fields?.[f] || []) as string[];
          for (const term of terms) {
            const blk = (perBlock[blockName][term] ||= {
              docCount: 0,
              fields: { title: 0, abstract: 0, keywords: 0 },
            });
            blk.fields[f]++;

            const seenBlockSet = seenInBlock.get(blockName)!;
            if (!seenBlockSet.has(term)) {
              blk.docCount++;
              seenBlockSet.add(term);
            }

            overallFieldCounts[f].set(term, (overallFieldCounts[f].get(term) || 0) + 1);

            if (!seenOverall.has(term)) {
              overallDocCounts.set(term, (overallDocCounts.get(term) || 0) + 1);
              seenOverall.add(term);
            }
          }
        });
      }
    }

    cfg.blocks.forEach((b, idx) => {
      const name = b.name || `Block ${idx + 1}`;
      perBlock[name] ||= {};
      (b.terms || []).forEach((raw) => {
        const term = (raw || "").trim();
        if (!term) return;
        perBlock[name][term] ||= {
          docCount: 0,
          fields: { title: 0, abstract: 0, keywords: 0 },
        };
      });
    });

    const overallTop = [...overallDocCounts.entries()].sort((a, b) => b[1] - a[1]).map(([term, docCount]) => ({ term, docCount }));

    const topByBlock = Object.fromEntries(
      Object.entries(perBlock).map(([blockName, termMap]) => {
        const list = Object.entries(termMap)
          .map(([term, v]) => ({
            term,
            docCount: v.docCount,
            fields: v.fields,
          }))
          .sort((a, b) => b.docCount - a.docCount);
        return [blockName, list];
      })
    );

    return {
      totalMatchedStudies: rows.length,
      overallTop,
      topByBlock,
      perBlock,
      overallFieldCounts: Object.fromEntries((["title", "abstract", "keywords"] as Field[]).map((f) => [f, Object.fromEntries(overallFieldCounts[f])])),
    };
  }

  const run = () => {
    setRunning(true);
    setRunOutput(null);
    try {
      const entries = parseBibtexEntries(bib);
      const matcher = evaluateQueryOnText(bib, cfg);

      let eligible = 0;
      const matchedRows: any[] = [];
      const partialRows: any[] = [];
      const unmatchedRows: any[] = [];
      const matchedBibEntries: string[] = [];

      for (const e of entries) {
        const title = (e.title || "").toString();
        const abstract = (e.abstract || e.abs || e.summary || "").toString();
        const keywords = (e.keywords || e.keyword || "").toString();

        const hasAny = (cfg.searchFields.title && title) || (cfg.searchFields.abstract && abstract) || (cfg.searchFields.keywords && keywords);

        const cleanTitle = title.replace(/\s+/g, " ").replace(/[{}]/g, "").trim();
        const authors = (e.author || "").replace(/\s+/g, " ").trim();
        const year = (e.year || "").trim();
        const venue = (e.booktitle || e.journal || "").replace(/\s+/g, " ").trim();
        const doi = (e.doi || "").trim();
        const url = (e.url || (doi ? `https://doi.org/${doi}` : "")).trim();
        const baseEntry = {
          CiteKey: e.citekey,
          Title: cleanTitle,
          Authors: authors,
          Year: year,
          Venue: venue,
          URL: url,
        };

        if (hasAny) eligible++;

        const { ok, matchedBlocks, detailed } = matcher({ title, abstract, keywords }, cfg.searchFields);

        const detailPieces: string[] = [];
        Object.entries(detailed).forEach(([blockName, fields]) => {
          const parts: string[] = [];
          if (fields.title?.length) parts.push(`Title: ${fields.title.join(" | ")}`);
          if (fields.abstract?.length) parts.push(`Abstract: ${fields.abstract.join(" | ")}`);
          if (fields.keywords?.length) parts.push(`Keywords: ${fields.keywords.join(" | ")}`);
          if (parts.length) detailPieces.push(`${blockName} [${parts.join("; ")}]`);
        });

        if (ok && hasAny) {
          matchedRows.push({
            ...baseEntry,
            TitleRaw: title,
            AbstractRaw: abstract,
            KeywordsRaw: keywords,
            MatchedBlocks: matchedBlocks.join("; "),
            MatchedTermsDetail: detailPieces.join("; "),
            MatchedTermsMap: detailed,
          });
          matchedBibEntries.push(buildBibEntry(e));
        } else if (hasAny && Object.keys(detailed).length > 0) {
          const allPosBlocks = cfg.blocks.filter((b) => !b.exclude).map((b, j) => b.name || `Block ${j + 1}`);
          const hitBlocks = Object.keys(detailed);
          const missingBlocks = allPosBlocks.filter((n) => !hitBlocks.includes(n));

          partialRows.push({
            ...baseEntry,
            TitleRaw: title,
            AbstractRaw: abstract,
            KeywordsRaw: keywords,
            MatchedTermsMap: detailed,
            MatchedTermsDetail: detailPieces.join("; "),
            PartialBlocks: hitBlocks.join("; "),
            MissingBlocks: missingBlocks.join("; "),
          });
        } else if (hasAny) {
          unmatchedRows.push({
            ...baseEntry,
            TitleRaw: title,
            AbstractRaw: abstract,
            KeywordsRaw: keywords,
            MatchedTermsMap: detailed || {},
          });
        }
      }

      const report = {
        total: entries.length,
        eligible,
        matched: matchedRows.length,
        partial: partialRows.length,
        unmatched: unmatchedRows.length,
      };

      const stats = computeTermStats(matchedRows);

      setRunOutput({
        matched: matchedRows,
        partial: partialRows,
        unmatched: unmatchedRows,
        report,
        termStats: stats,
      });

      setMatchedBib(matchedBibEntries.join("\n\n"));
    } catch (error: any) {
      alert(`Error processing BibTeX: ${error.message}`);
      setRunOutput(null);
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
    if (!runOutput || runOutput.matched.length === 0) return;
    download("matches.csv", toCSV(runOutput.matched), "text/csv");
  };

  const exportBib = () => {
    download("matches.bib", matchedBib, "text/plain");
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
                <div className="grid gap-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-base">Paste Boolean Query</Label>
                    <div className="flex gap-2">
                      <Button variant="outline" onClick={() => setQueryString("")}>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Clear
                      </Button>
                      <Button onClick={applyPastedQuery}>
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
                        <Switch
                          checked={cfg.searchFields.title}
                          onCheckedChange={(v) =>
                            setCfg({
                              ...cfg,
                              searchFields: { ...cfg.searchFields, title: v },
                            })
                          }
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-600">Abstract</span>
                        <Switch
                          checked={cfg.searchFields.abstract}
                          onCheckedChange={(v) =>
                            setCfg({
                              ...cfg,
                              searchFields: {
                                ...cfg.searchFields,
                                abstract: v,
                              },
                            })
                          }
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-600">Keywords</span>
                        <Switch
                          checked={cfg.searchFields.keywords}
                          onCheckedChange={(v) =>
                            setCfg({
                              ...cfg,
                              searchFields: {
                                ...cfg.searchFields,
                                keywords: v,
                              },
                            })
                          }
                        />
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
                    <Button variant="outline" onClick={exportCSV} disabled={!runOutput || runOutput.matched.length === 0}>
                      <Download className="h-4 w-4 mr-2" />
                      Export CSV
                    </Button>
                    <Button variant="outline" onClick={exportBib} disabled={!runOutput || runOutput.matched.length === 0}>
                      <Download className="h-4 w-4 mr-2" />
                      Export .bib
                    </Button>
                  </div>
                </div>

                {runOutput?.report && (
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <div className="rounded-2xl border p-4 bg-white shadow-sm">
                      <div className="text-xs text-slate-500">Total entries</div>
                      <div className="text-2xl font-semibold">{runOutput.report.total}</div>
                    </div>
                    <div className="rounded-2xl border p-4 bg-white shadow-sm">
                      <div className="text-xs text-slate-500">With selected fields</div>
                      <div className="text-2xl font-semibold">{runOutput.report.eligible}</div>
                    </div>
                    <div className="rounded-2xl border p-4 bg-white shadow-sm">
                      <div className="text-xs text-slate-500">Matched</div>
                      <div className="text-2xl font-semibold">{runOutput.report.matched}</div>
                    </div>
                    <div className="rounded-2xl border p-4 bg-white shadow-sm">
                      <div className="text-xs text-slate-500">Partially matched</div>
                      <div className="text-2xl font-semibold">{runOutput.report.partial}</div>
                    </div>
                    <div className="rounded-2xl border p-4 bg-white shadow-sm">
                      <div className="text-xs text-slate-500">Unmatched</div>
                      <div className="text-2xl font-semibold">{runOutput.report.unmatched}</div>
                    </div>
                  </div>
                )}
                {runOutput?.termStats && (
                  <div className="grid gap-4">
                    <div className="flex items-center justify-between mt-2">
                      <div className="text-sm text-slate-700 font-medium">Search-term stats</div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div className="rounded-2xl border p-4 bg-white shadow-sm">
                        <div className="text-xs text-slate-500">Top term overall</div>
                        {runOutput.termStats.overallTop.length ? (
                          <div className="text-lg font-semibold">
                            {runOutput.termStats.overallTop[0].term}
                            <span className="ml-2 text-slate-500 text-sm">({runOutput.termStats.overallTop[0].docCount} studies)</span>
                          </div>
                        ) : (
                          <div className="text-slate-500">—</div>
                        )}
                        <div className="mt-2 text-xs text-slate-500">Based on unique studies where the term matched in any field.</div>
                      </div>

                      <div className="rounded-2xl border p-4 bg-white shadow-sm">
                        <div className="text-xs text-slate-500">Top 3 terms overall</div>
                        <ul className="mt-1 text-sm">
                          {runOutput.termStats.overallTop.slice(0, 3).map((t: any, i: number) => (
                            <li key={i} className="flex justify-between">
                              <span className="truncate">{t.term}</span>
                              <span className="text-slate-500">{t.docCount}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div className="rounded-2xl border p-4 bg-white shadow-sm">
                        <div className="text-xs text-slate-500">Field leaders (overall)</div>
                        <ul className="mt-1 text-sm">
                          {(["title", "abstract", "keywords"] as const).map((f) => {
                            const entries = Object.entries(runOutput.termStats.overallFieldCounts[f] || {}).sort((a: any, b: any) => (b[1] as number) - (a[1] as number));
                            const top = entries[0];
                            return (
                              <li key={f} className="flex justify-between">
                                <span className="uppercase tracking-wide text-slate-500">{f}:</span>
                                <span className="truncate ml-2">{top ? `${top[0]} (${top[1]})` : "—"}</span>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </div>

                    <div className="grid gap-3">
                      {Object.entries(runOutput.termStats.topByBlock).map(([blockName, list]: any) => (
                        <div key={blockName} className="rounded-2xl border bg-white shadow-sm">
                          <div className="p-4 border-b flex items-center justify-between">
                            <div className="text-sm font-medium">{blockName}</div>
                            {list.length ? (
                              list.some((t: any) => t.docCount > 0) ? (
                                <div className="text-xs text-slate-500">
                                  Leader: <span className="font-medium">{list.find((t: any) => t.docCount === Math.max(...list.map((x: any) => x.docCount)))!.term}</span> (<span className="tabular-nums">{Math.max(...list.map((x: any) => x.docCount))}</span>)
                                </div>
                              ) : (
                                <div className="text-xs text-slate-500">No matches</div>
                              )
                            ) : (
                              <div className="text-xs text-slate-500">No matches</div>
                            )}
                          </div>
                          <div className="p-4 overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="text-left text-xs text-slate-500">
                                  <th className="py-2 pr-4">Term</th>
                                  <th className="py-2 pr-4">Studies</th>
                                  <th className="py-2 pr-4">Title</th>
                                  <th className="py-2 pr-4">Abstract</th>
                                  <th className="py-2 pr-4">Keywords</th>
                                </tr>
                              </thead>
                              <tbody>
                                {list.map((t: any, i: number) => (
                                  <tr key={i} className="border-t">
                                    <td className="py-2 pr-4">{t.term}</td>
                                    <td className="py-2 pr-4 tabular-nums">{t.docCount}</td>
                                    <td className="py-2 pr-4 tabular-nums">{t.fields.title}</td>
                                    <td className="py-2 pr-4 tabular-nums">{t.fields.abstract}</td>
                                    <td className="py-2 pr-4 tabular-nums">{t.fields.keywords}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {runOutput && (
                  <Tabs defaultValue="matched" className="mt-4">
                    <TabsList>
                      <TabsTrigger value="matched">Matched ({runOutput.matched.length})</TabsTrigger>
                      <TabsTrigger value="partial">Partially Matched ({runOutput.partial.length})</TabsTrigger>
                      <TabsTrigger value="unmatched">Unmatched ({runOutput.unmatched.length})</TabsTrigger>
                    </TabsList>
                    <TabsContent value="matched" className="mt-4">
                      <p className="text-sm text-slate-600 mb-4">These entries fully matched the query.</p>
                      <div className="grid gap-3">
                        {runOutput.matched.map((r, idx) => {
                          const titleHTML = highlightByBlocks(r.TitleRaw || r.Title || "", r.MatchedTermsMap, cfg, "title");
                          const absHTML = highlightByBlocks(r.AbstractRaw || "", r.MatchedTermsMap, cfg, "abstract");
                          const kwHTML = highlightByBlocks(r.KeywordsRaw || "", r.MatchedTermsMap, cfg, "keywords");

                          return (
                            <div key={idx} className="rounded-2xl border bg-white p-4 shadow-sm">
                              <div className="text-sm text-slate-500 flex items-center gap-2">
                                <CheckCircle className="h-4 w-4 text-green-600" aria-label="Matched" />
                                <span>
                                  {r.CiteKey} · {r.Year}
                                </span>
                              </div>

                              <div className="text-lg font-medium leading-snug mt-1" dangerouslySetInnerHTML={{ __html: titleHTML }} />

                              <div className="text-sm text-slate-600 mt-1">{r.Authors}</div>
                              <div className="text-sm text-slate-600">{r.Venue}</div>
                              {r.URL && (
                                <a className="text-sm text-blue-600 underline mt-1 inline-block" href={r.URL} target="_blank" rel="noreferrer">
                                  Open
                                </a>
                              )}

                              {r.AbstractRaw && (
                                <div className="mt-3">
                                  <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Abstract</div>
                                  <p
                                    className="text-sm text-slate-700 whitespace-pre-line"
                                    dangerouslySetInnerHTML={{
                                      __html: absHTML,
                                    }}
                                  />
                                </div>
                              )}

                              {r.KeywordsRaw && (
                                <div className="mt-3">
                                  <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Keywords</div>
                                  <p className="text-sm text-slate-700" dangerouslySetInnerHTML={{ __html: kwHTML }} />
                                </div>
                              )}

                              <MatchBreakdown cfg={cfg} matchedMap={r.MatchedTermsMap} />
                            </div>
                          );
                        })}
                      </div>
                    </TabsContent>
                    <TabsContent value="partial" className="mt-4">
                      <p className="text-sm text-slate-600 mb-4">These entries had some matching terms but did not satisfy the full query.</p>
                      <div className="grid gap-3">
                        {runOutput.partial.map((r: any, idx: number) => {
                          const titleHTML = highlightByBlocks(r.TitleRaw || r.Title || "", r.MatchedTermsMap || {}, cfg, "title");
                          const absHTML = highlightByBlocks(r.AbstractRaw || "", r.MatchedTermsMap || {}, cfg, "abstract");
                          const kwHTML = highlightByBlocks(r.KeywordsRaw || "", r.MatchedTermsMap || {}, cfg, "keywords");

                          return (
                            <div key={idx} className="rounded-2xl border bg-white p-4 shadow-sm">
                              <div className="text-sm text-slate-500 flex items-center gap-2">
                                <HelpCircle className="h-4 w-4 text-yellow-600" aria-label="Partially Matched" />
                                <span>
                                  {r.CiteKey} · {r.Year}
                                </span>
                              </div>

                              <div className="text-lg font-medium leading-snug mt-1" dangerouslySetInnerHTML={{ __html: titleHTML }} />
                              <div className="text-sm text-slate-600 mt-1">{r.Authors}</div>
                              <div className="text-sm text-slate-600">{r.Venue}</div>
                              {r.URL && (
                                <a className="text-sm text-blue-600 underline mt-1 inline-block" href={r.URL} target="_blank" rel="noreferrer">
                                  Open
                                </a>
                              )}

                              {r.PartialBlocks && r.PartialBlocks.length > 0 ? (
                                <div className="text-xs text-slate-500 mt-2">
                                  Partial matches in: {r.PartialBlocks}
                                  {r.MissingBlocks ? <> · Missing required blocks: {r.MissingBlocks}</> : null}
                                </div>
                              ) : null}

                              {r.AbstractRaw && (
                                <div className="mt-3">
                                  <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Abstract</div>
                                  <p className="text-sm text-slate-700 whitespace-pre-line" dangerouslySetInnerHTML={{ __html: absHTML }} />
                                </div>
                              )}
                              {r.KeywordsRaw && (
                                <div className="mt-3">
                                  <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Keywords</div>
                                  <p className="text-sm text-slate-700" dangerouslySetInnerHTML={{ __html: kwHTML }} />
                                </div>
                              )}

                              <MatchBreakdown cfg={cfg} matchedMap={r.MatchedTermsMap} caption="partial" />
                            </div>
                          );
                        })}
                      </div>
                    </TabsContent>
                    <TabsContent value="unmatched" className="mt-4">
                      <p className="text-sm text-slate-600 mb-4">These entries did not match the query.</p>
                      <div className="grid gap-3">
                        {runOutput.unmatched.map((r: any, idx: number) => {
                          const titleHTML = highlightByBlocks(r.TitleRaw || r.Title || "", r.MatchedTermsMap || {}, cfg, "title");
                          const absHTML = highlightByBlocks(r.AbstractRaw || "", r.MatchedTermsMap || {}, cfg, "abstract");
                          const kwHTML = highlightByBlocks(r.KeywordsRaw || "", r.MatchedTermsMap || {}, cfg, "keywords");

                          return (
                            <div key={idx} className="rounded-2xl border bg-white p-4 shadow-sm">
                              <div className="text-sm text-slate-500 flex items-center gap-2">
                                <XCircle className="h-4 w-4 text-red-600" aria-label="Unmatched" />
                                <span>
                                  {r.CiteKey} · {r.Year}
                                </span>
                              </div>

                              <div className="text-lg font-medium leading-snug mt-1" dangerouslySetInnerHTML={{ __html: titleHTML }} />

                              <div className="text-sm text-slate-600 mt-1">{r.Authors}</div>
                              <div className="text-sm text-slate-600">{r.Venue}</div>
                              {r.URL && (
                                <a className="text-sm text-blue-600 underline mt-1 inline-block" href={r.URL} target="_blank" rel="noreferrer">
                                  Open
                                </a>
                              )}

                              {r.AbstractRaw && (
                                <div className="mt-3">
                                  <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Abstract</div>
                                  <p className="text-sm text-slate-700 whitespace-pre-line" dangerouslySetInnerHTML={{ __html: absHTML }} />
                                </div>
                              )}

                              {r.KeywordsRaw && (
                                <div className="mt-3">
                                  <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Keywords</div>
                                  <p className="text-sm text-slate-700" dangerouslySetInnerHTML={{ __html: kwHTML }} />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </TabsContent>
                  </Tabs>
                )}

                {!runOutput && <div className="text-sm text-slate-500">Run the query to see a summarized report, search-term stats, and the matching references.</div>}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        <footer className="text-center text-xs text-slate-500 py-4">Built for visual, block-based literature filtering. Paste a Boolean query to auto-build blocks, tweak AND/OR/NOT, then execute.</footer>
      </div>
    </div>
  );
}
