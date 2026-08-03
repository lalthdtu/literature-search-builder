import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { summarizeExclusions, type ScreeningRow } from "@/lib/screening";

export type PreviewBlock = { id: string; name: string; exclude: boolean };

type Props = {
  kept: ScreeningRow[];
  excluded: ScreeningRow[];
  blocks: PreviewBlock[];
  stale: boolean;
};

const PAGE_SIZE = 50;

function Evidence({ row }: { row: ScreeningRow }) {
  return (
    <div className="grid gap-2 py-2">
      {row.BlockResults.map((result) => {
        const fields = (["title", "abstract", "keywords"] as const)
          .filter((field) => result.hits[field]?.length)
          .map((field) => `${field}: ${result.hits[field]!.join(" | ")}`);
        return (
          <div key={result.blockId} className="rounded-lg border bg-slate-50 p-2 text-xs">
            <div className="font-medium">{result.blockName}: {result.matched ? "Matched" : "Not matched"}</div>
            <div className="mt-1 text-slate-600">{fields.length ? fields.join("; ") : `Configured terms: ${result.configuredTerms.join(" | ")}`}</div>
          </div>
        );
      })}
    </div>
  );
}

function RecordTable({ rows, blocks, search, reason }: { rows: ScreeningRow[]; blocks: PreviewBlock[]; search: string; reason?: string }) {
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = !needle || [row.CiteKey, row.Title, row.Authors].some((value) => value.toLowerCase().includes(needle));
      const matchesReason = !reason || reason === "all" || row.PrimaryExclusionReason === reason;
      return matchesSearch && matchesReason;
    });
  }, [rows, search, reason]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  useEffect(() => setPage(1), [search, reason, rows]);
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);

  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="grid gap-3">
      <div className="text-xs text-slate-500">Showing {visible.length} of {filtered.length} records</div>
      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-600">
            <tr>
              <th className="w-10 px-3 py-2" aria-label="Expand row" />
              <th className="min-w-36 px-3 py-2">Cite key</th>
              <th className="min-w-80 px-3 py-2">Title</th>
              <th className="min-w-56 px-3 py-2">Authors</th>
              <th className="px-3 py-2">Year</th>
              {blocks.map((block) => <th key={block.id} className="min-w-36 px-3 py-2">{block.name}</th>)}
              <th className="min-w-72 px-3 py-2">Primary reason</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const isExpanded = expanded === row.RecordId;
              const resultById = new Map(row.BlockResults.map((result) => [result.blockId, result]));
              return (
                <Fragment key={row.RecordId}>
                  <tr className="border-t align-top">
                    <td className="px-2 py-2">
                      <Button variant="ghost" className="h-7 w-7 p-0" onClick={() => setExpanded(isExpanded ? null : row.RecordId)} aria-label={isExpanded ? "Collapse evidence" : "Expand evidence"}>
                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </Button>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{row.CiteKey}</td>
                    <td className="px-3 py-2">{row.Title || "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{row.Authors || "—"}</td>
                    <td className="px-3 py-2">{row.Year || "—"}</td>
                    {blocks.map((block) => {
                      const result = resultById.get(block.id);
                      const matched = !!result?.matched;
                      const passes = block.exclude ? !matched : matched;
                      return <td key={block.id} className={`px-3 py-2 font-medium ${passes ? "text-green-700" : "text-red-700"}`}>{matched ? "Matched" : "Not matched"}</td>;
                    })}
                    <td className="px-3 py-2 text-red-700">{row.PrimaryExclusionReason || "—"}</td>
                  </tr>
                  {isExpanded && (
                    <tr className="border-t">
                      <td />
                      <td colSpan={blocks.length + 5} className="px-3 pb-3"><Evidence row={row} /></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!visible.length && <tr><td colSpan={blocks.length + 6} className="px-4 py-8 text-center text-slate-500">No records match the current filters.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between">
        <Button variant="outline" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
        <span className="text-sm text-slate-600">Page {page} of {pages}</span>
        <Button variant="outline" disabled={page === pages} onClick={() => setPage((value) => value + 1)}>Next</Button>
      </div>
    </div>
  );
}

export function ResultsPreview({ kept, excluded, blocks, stale }: Props) {
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("all");
  const reasons = useMemo(() => [...new Set(excluded.map((row) => row.PrimaryExclusionReason))], [excluded]);
  const summary = useMemo(() => summarizeExclusions(excluded), [excluded]);

  return (
    <div className="grid gap-4">
      {stale && <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Preview is out of date. Execute the query again before exporting.</div>}
      <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search cite key, title, or authors" className="max-w-md" />

      <Tabs defaultValue="kept">
        <TabsList>
          <TabsTrigger value="kept">Kept ({kept.length})</TabsTrigger>
          <TabsTrigger value="excluded">Excluded ({excluded.length})</TabsTrigger>
          <TabsTrigger value="summary">Reason Summary</TabsTrigger>
        </TabsList>
        <TabsContent value="kept" className="mt-4"><RecordTable rows={kept} blocks={blocks} search={search} /></TabsContent>
        <TabsContent value="excluded" className="mt-4 grid gap-3">
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger className="w-full max-w-sm"><SelectValue placeholder="Filter by primary reason" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All primary reasons</SelectItem>
              {reasons.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
            </SelectContent>
          </Select>
          <RecordTable rows={excluded} blocks={blocks} search={search} reason={reason} />
        </TabsContent>
        <TabsContent value="summary" className="mt-4">
          <div className="overflow-x-auto rounded-xl border bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-600"><tr><th className="px-4 py-2">Primary exclusion reason</th><th className="px-4 py-2">Count</th></tr></thead>
              <tbody>{summary.map((item) => <tr key={item.reason} className="border-t"><td className="px-4 py-2">{item.reason}</td><td className="px-4 py-2 tabular-nums">{item.count}</td></tr>)}</tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
