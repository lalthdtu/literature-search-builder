export type ParsedQueryBlock = {
  name: string;
  terms: string[];
  exclude: boolean;
  isRegex: false;
};

export type QueryParseError = {
  position: number;
  message: string;
};

export type QueryParseResult =
  | { ok: true; blocks: ParsedQueryBlock[] }
  | { ok: false; errors: QueryParseError[] };

type TokenKind = "lparen" | "rparen" | "and" | "or" | "not" | "term" | "eof";
type Token = { kind: TokenKind; value: string; position: number };

function tokenize(input: string): Token[] | QueryParseError[] {
  const tokens: Token[] = [];
  const errors: QueryParseError[] = [];
  let position = 0;

  while (position < input.length) {
    const char = input[position];
    if (/\s/.test(char)) {
      position++;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen", value: char, position });
      position++;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen", value: char, position });
      position++;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const start = position++;
      let value = "";
      let closed = false;
      while (position < input.length) {
        const current = input[position];
        if (current === quote && input[position - 1] !== "\\") {
          closed = true;
          position++;
          break;
        }
        value += current;
        position++;
      }
      if (!closed) errors.push({ position: start, message: "Unmatched quote." });
      else if (!value.trim()) errors.push({ position: start, message: "Quoted terms cannot be empty." });
      else tokens.push({ kind: "term", value: value.trim(), position: start });
      continue;
    }

    const start = position;
    while (position < input.length && !/[\s()]/.test(input[position])) position++;
    const value = input.slice(start, position);
    const upper = value.toUpperCase();
    const kind: TokenKind = upper === "AND" ? "and" : upper === "OR" ? "or" : upper === "NOT" ? "not" : "term";
    tokens.push({ kind, value, position: start });
  }

  if (errors.length) return errors;
  tokens.push({ kind: "eof", value: "", position: input.length });
  return tokens;
}

export function parseBlockQuery(input: string): QueryParseResult {
  if (!input.trim()) return { ok: false, errors: [{ position: 0, message: "Enter a search string before parsing." }] };
  const tokenized = tokenize(input);
  if (tokenized.length && "message" in tokenized[0]) return { ok: false, errors: tokenized as QueryParseError[] };

  const tokens = tokenized as Token[];
  const blocks: ParsedQueryBlock[] = [];
  const errors: QueryParseError[] = [];
  let cursor = 0;

  const current = () => tokens[cursor];
  const consume = (kind: TokenKind) => {
    if (current().kind !== kind) return null;
    return tokens[cursor++];
  };

  const parseBlock = (exclude: boolean) => {
    const open = consume("lparen");
    if (!open) {
      errors.push({ position: current().position, message: "Expected '(' to start a block." });
      return;
    }

    const terms: string[] = [];
    let expectTerm = true;
    while (current().kind !== "rparen" && current().kind !== "eof") {
      if (expectTerm) {
        if (current().kind !== "term") {
          const message = current().kind === "lparen" ? "Nested groups are not supported." : "Expected a search term.";
          errors.push({ position: current().position, message });
          return;
        }
        terms.push(current().value);
        cursor++;
        expectTerm = false;
      } else {
        if (!consume("or")) {
          const message = current().kind === "and" ? "AND is only supported between blocks." : "Terms inside a block must be joined by OR.";
          errors.push({ position: current().position, message });
          return;
        }
        expectTerm = true;
      }
    }

    if (!consume("rparen")) {
      errors.push({ position: open.position, message: "Unmatched '('." });
      return;
    }
    if (expectTerm && terms.length) {
      errors.push({ position: current().position, message: "A block cannot end with OR." });
      return;
    }
    if (!terms.length) {
      errors.push({ position: open.position, message: "Blocks cannot be empty." });
      return;
    }

    blocks.push({ name: `Block ${blocks.length + 1}`, terms, exclude, isRegex: false });
  };

  let first = true;
  while (current().kind !== "eof" && !errors.length) {
    let exclude = false;
    if (!first) {
      if (consume("and")) exclude = !!consume("not");
      else if (consume("not")) exclude = true;
      else {
        const message = current().kind === "or" ? "Top-level OR is not supported; place OR terms inside one block." : "Expected AND or NOT between blocks.";
        errors.push({ position: current().position, message });
        break;
      }
    } else {
      exclude = !!consume("not");
    }

    parseBlock(exclude);
    first = false;
  }

  if (errors.length) return { ok: false, errors };
  if (!blocks.length) return { ok: false, errors: [{ position: 0, message: "No query blocks were found." }] };
  return { ok: true, blocks };
}
