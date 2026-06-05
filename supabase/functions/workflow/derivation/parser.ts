// Closed-grammar parser for `derived_formula` expressions.
//
// Grammar:
//   formula    ::= null | bare_token | fn_call
//   bare_token ::= identifier ('.' identifier)?
//   fn_call    ::= identifier '(' arg_list ')'
//   arg_list   ::= arg (',' arg)*
//   arg        ::= bare_token
//
// Disambiguation rule:
//   A dotted token whose first segment is a known namespace prefix
//   (tenant | property | landlord | building) is a context path.
//   Otherwise it is a sibling placeholder name.

// ─── AST types ────────────────────────────────────────────────────────────────

export type ContextPath = {
  kind: "context_path";
  namespace: string; // e.g. "tenant"
  field: string; // e.g. "cpf"
};

export type SiblingRef = {
  kind: "sibling";
  name: string; // placeholder name
};

export type Arg = ContextPath | SiblingRef;

export type FnCall = {
  kind: "fn_call";
  fn: string;
  args: Arg[];
};

export type ParsedFormula =
  | { kind: "asked" } // null formula
  | ContextPath // identity copy of a context value
  | SiblingRef // identity copy of a sibling placeholder
  | FnCall; // registry call

// ─── Namespace set ─────────────────────────────────────────────────────────────

export const CONTEXT_NAMESPACES = new Set([
  "tenant",
  "property",
  "landlord",
  "building",
]);

// ─── Tokenizer ────────────────────────────────────────────────────────────────

type Token =
  | { type: "ident"; value: string }
  | { type: "dot" }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "comma" };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (ch === ".") {
      tokens.push({ type: "dot" });
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma" });
      i++;
      continue;
    }
    // identifier: [a-zA-Z_][a-zA-Z0-9_]*
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j])) {
        j++;
      }
      tokens.push({ type: "ident", value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new SyntaxError(
      `Unexpected character '${ch}' at position ${i} in formula: ${input}`,
    );
  }
  return tokens;
}

// ─── Recursive-descent parser ─────────────────────────────────────────────────

class FormulaParser {
  private tokens: Token[];
  private pos = 0;
  private original: string;

  constructor(tokens: Token[], original: string) {
    this.tokens = tokens;
    this.original = original;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(type?: string): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) {
      throw new SyntaxError(
        `Unexpected end of formula: ${this.original}`,
      );
    }
    if (type && tok.type !== type) {
      throw new SyntaxError(
        `Expected '${type}', got '${tok.type}' in formula: ${this.original}`,
      );
    }
    this.pos++;
    return tok;
  }

  private consumeIdent(): string {
    const tok = this.consume("ident") as { type: "ident"; value: string };
    return tok.value;
  }

  private atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  /** Parse an argument (bare token = context_path or sibling ref). */
  private parseArg(): Arg {
    const name = this.consumeIdent();
    if (this.peek()?.type === "dot") {
      this.consume("dot");
      const field = this.consumeIdent();
      return { kind: "context_path", namespace: name, field };
    }
    if (CONTEXT_NAMESPACES.has(name)) {
      throw new SyntaxError(
        `Context namespace '${name}' used without a field (missing '.field') in formula: ${this.original}`,
      );
    }
    return { kind: "sibling", name };
  }

  /** Parse the full formula expression. */
  parseFormula(): ParsedFormula {
    if (this.atEnd()) {
      return { kind: "asked" };
    }

    const name = this.consumeIdent();

    // fn_call: identifier followed by '('
    if (this.peek()?.type === "lparen") {
      this.consume("lparen");
      const args: Arg[] = [];
      if (this.peek()?.type !== "rparen") {
        args.push(this.parseArg());
        while (this.peek()?.type === "comma") {
          this.consume("comma");
          args.push(this.parseArg());
        }
      }
      this.consume("rparen");
      if (!this.atEnd()) {
        throw new SyntaxError(
          `Trailing content after function call in formula: ${this.original}`,
        );
      }
      return { kind: "fn_call", fn: name, args };
    }

    // dotted bare token (context path)
    if (this.peek()?.type === "dot") {
      this.consume("dot");
      const field = this.consumeIdent();
      if (!this.atEnd()) {
        throw new SyntaxError(
          `Trailing content after context path in formula: ${this.original}`,
        );
      }
      return { kind: "context_path", namespace: name, field };
    }

    // plain bare token (sibling ref or bare namespace = error)
    if (!this.atEnd()) {
      throw new SyntaxError(
        `Trailing content after identifier in formula: ${this.original}`,
      );
    }
    if (CONTEXT_NAMESPACES.has(name)) {
      throw new SyntaxError(
        `Context namespace '${name}' used without a field (missing '.field') in formula: ${this.original}`,
      );
    }
    return { kind: "sibling", name };
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a `derived_formula` string into a ParsedFormula AST node.
 *
 * Pass `null` (or the literal string "null" or empty string) to get
 * `{ kind: "asked" }`. Throws `SyntaxError` on any grammar violation.
 */
export function parseFormula(formula: string | null): ParsedFormula {
  if (formula === null || formula.trim() === "" || formula.trim() === "null") {
    return { kind: "asked" };
  }
  const trimmed = formula.trim();
  const tokens = tokenize(trimmed);
  const parser = new FormulaParser(tokens, trimmed);
  return parser.parseFormula();
}

/**
 * Extract the set of sibling placeholder names referenced by a parsed formula.
 * Context paths are excluded — they are not sibling dependencies.
 */
export function siblingDeps(formula: ParsedFormula): Set<string> {
  const deps = new Set<string>();
  if (formula.kind === "asked") return deps;
  if (formula.kind === "sibling") {
    deps.add(formula.name);
    return deps;
  }
  if (formula.kind === "context_path") return deps;
  if (formula.kind === "fn_call") {
    for (const arg of formula.args) {
      if (arg.kind === "sibling") deps.add(arg.name);
    }
    return deps;
  }
  return deps;
}
