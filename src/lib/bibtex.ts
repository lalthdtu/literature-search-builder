export type SourceRange = {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
};

export type BibtexDiagnostic = {
  severity: "error" | "warning";
  code: "no_entries" | "embedded_entry" | "unbalanced_entry" | "entry_count_mismatch" | "citekey_collision";
  line: number;
  citekey?: string;
  message: string;
  guidance: string;
  range: SourceRange;
  fix?: { kind: "insert_closure"; offset: number; text: string; label: string };
};

export type BibtexRecord = {
  internalId: string;
  fingerprint: string;
  entryType: string;
  citekey: string;
  fields: Record<string, string>;
  raw: string;
  line: number;
  range: SourceRange;
};

export type BibtexParseResult = {
  records: BibtexRecord[];
  diagnostics: BibtexDiagnostic[];
  discoveredHeaders: number;
  hasBlockingErrors: boolean;
};

type Header = { start: number; bodyStart: number; entryType: string; citekey: string; line: number };

function createLineLookup(text: string) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") starts.push(index + 1);
  return (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= offset) low = middle + 1;
      else high = middle - 1;
    }
    return high + 1;
  };
}

function hashText(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function sourceSignature(text: string) {
  return `${text.length}-${hashText(text)}`;
}

function findEntryEnd(text: string, bodyStart: number) {
  let depth = 1;
  let inQuote = false;
  for (let index = bodyStart; index < text.length; index++) {
    const char = text[index];
    if (char === '"' && text[index - 1] !== "\\") inQuote = !inQuote;
    if (inQuote || text[index - 1] === "\\") continue;
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function closureAt(text: string, bodyStart: number, boundary: number) {
  let depth = 1;
  let inQuote = false;
  for (let index = bodyStart; index < boundary; index++) {
    const char = text[index];
    if (char === '"' && text[index - 1] !== "\\") inQuote = !inQuote;
    if (inQuote || text[index - 1] === "\\") continue;
    if (char === "{") depth++;
    else if (char === "}") depth = Math.max(0, depth - 1);
  }
  const textToInsert = `${inQuote ? '"' : ""}${"}".repeat(Math.max(1, depth))}\n\n`;
  const parts = [inQuote ? "a closing quote" : "", depth === 1 ? "1 closing brace" : `${depth} closing braces`].filter(Boolean).join(" and ");
  return { kind: "insert_closure" as const, offset: boundary, text: textToInsert, label: `Insert ${parts}` };
}

function readBracedValue(body: string, start: number) {
  let depth = 1;
  for (let index = start + 1; index < body.length; index++) {
    if (body[index - 1] === "\\") continue;
    if (body[index] === "{") depth++;
    else if (body[index] === "}") {
      depth--;
      if (depth === 0) return { value: body.slice(start + 1, index), next: index + 1 };
    }
  }
  return null;
}

function parseFields(raw: string) {
  const firstComma = raw.indexOf(",");
  const body = raw.slice(firstComma + 1, -1);
  const fields: Record<string, string> = {};
  let cursor = 0;
  while (cursor < body.length) {
    while (cursor < body.length && /[\s,]/.test(body[cursor])) cursor++;
    const keyMatch = body.slice(cursor).match(/^([A-Za-z][\w-]*)\s*=\s*/);
    if (!keyMatch) {
      cursor++;
      continue;
    }
    const key = keyMatch[1].toLowerCase();
    cursor += keyMatch[0].length;
    if (body[cursor] === "{") {
      const parsed = readBracedValue(body, cursor);
      if (!parsed) break;
      fields[key] = parsed.value;
      cursor = parsed.next;
    } else if (body[cursor] === '"') {
      const start = ++cursor;
      while (cursor < body.length && !(body[cursor] === '"' && body[cursor - 1] !== "\\")) cursor++;
      fields[key] = body.slice(start, cursor);
      cursor++;
    } else {
      const start = cursor;
      while (cursor < body.length && body[cursor] !== "," && body[cursor] !== "\n" && body[cursor] !== "\r") cursor++;
      fields[key] = body.slice(start, cursor).trim();
    }
  }
  return fields;
}

export function parseBibtex(text: string): BibtexParseResult {
  const lineAt = createLineLookup(text);
  const makeRange = (from: number, to: number): SourceRange => ({ from, to, startLine: lineAt(from), endLine: lineAt(Math.max(from, to - 1)) });
  const headerRegex = /@(\w+)\s*\{\s*([^,\s{}]+)\s*,/g;
  const headers: Header[] = [];
  let match: RegExpExecArray | null;
  while ((match = headerRegex.exec(text))) {
    headers.push({ start: match.index, bodyStart: headerRegex.lastIndex, entryType: match[1], citekey: match[2], line: lineAt(match.index) });
  }

  const diagnostics: BibtexDiagnostic[] = [];
  const records: BibtexRecord[] = [];
  if (!headers.length) {
    diagnostics.push({ severity: "error", code: "no_entries", line: 1, message: "No BibTeX entries were found.", guidance: "Paste or upload a .bib file containing entries such as @article{...}.", range: makeRange(0, Math.max(1, text.length)) });
  }

  const fingerprintOccurrences = new Map<string, number>();
  headers.forEach((header, index) => {
    const end = findEntryEnd(text, header.bodyStart);
    if (end === -1) {
      diagnostics.push({ severity: "error", code: "unbalanced_entry", line: header.line, citekey: header.citekey, message: `Entry '${header.citekey}' has unbalanced braces or quotes.`, guidance: "Close the entry's missing brace or quote before parsing again.", range: makeRange(header.start, text.length), fix: closureAt(text, header.bodyStart, text.length) });
      return;
    }
    const nextHeader = headers[index + 1];
    if (nextHeader && nextHeader.start < end) {
      diagnostics.push({ severity: "error", code: "embedded_entry", line: header.line, citekey: header.citekey, message: `Entry '${header.citekey}' contains another entry header at line ${nextHeader.line}.`, guidance: `Close '${header.citekey}' before the entry beginning on line ${nextHeader.line}.`, range: makeRange(header.start, nextHeader.start), fix: closureAt(text, header.bodyStart, nextHeader.start) });
      return;
    }
    const raw = text.slice(header.start, end).trim();
    const fields = parseFields(raw);
    const fingerprint = hashText(`${header.entryType.toLowerCase()}\u0000${JSON.stringify(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)))}`);
    const occurrence = (fingerprintOccurrences.get(fingerprint) || 0) + 1;
    fingerprintOccurrences.set(fingerprint, occurrence);
    records.push({
      internalId: `record-${fingerprint}-${occurrence}`,
      fingerprint,
      entryType: header.entryType,
      citekey: header.citekey,
      fields,
      raw,
      line: header.line,
      range: makeRange(header.start, end),
    });
  });

  if (records.length !== headers.length) {
    diagnostics.push({ severity: "error", code: "entry_count_mismatch", line: 1, message: `Found ${headers.length} entry headers but only ${records.length} structurally valid records.`, guidance: "Resolve every highlighted structural region before continuing.", range: makeRange(0, Math.max(1, text.length)) });
  }

  const keys = new Map<string, BibtexRecord[]>();
  records.forEach((record) => keys.set(record.citekey, [...(keys.get(record.citekey) || []), record]));
  keys.forEach((collisions, citekey) => {
    if (collisions.length < 2) return;
    diagnostics.push({ severity: "warning", code: "citekey_collision", line: collisions[0].line, citekey, message: `Cite key '${citekey}' is shared by ${collisions.length} records.`, guidance: "Cite keys are not used for deduplication. Unique suffixes will be added only when exporting BibTeX.", range: collisions[0].range });
  });

  return { records, diagnostics, discoveredHeaders: headers.length, hasBlockingErrors: diagnostics.some((item) => item.severity === "error") };
}

export function applyBibtexDiagnosticFix(source: string, diagnostic: BibtexDiagnostic) {
  if (!diagnostic.fix) return source;
  return `${source.slice(0, diagnostic.fix.offset)}${diagnostic.fix.text}${source.slice(diagnostic.fix.offset)}`;
}

export function buildBibEntry(record: BibtexRecord, citekey = record.citekey, fields = record.fields) {
  const body = Object.entries(fields).map(([key, value]) => `  ${key} = {${value}}`).join(",\n");
  return `@${record.entryType}{${citekey},\n${body}\n}`;
}
