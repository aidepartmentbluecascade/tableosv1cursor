import type { BinaryOp, FormulaAst } from "./ast.js";

export class FormulaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaParseError";
  }
}

export type Token =
  | { type: "number"; value: string; start: number; end: number }
  | { type: "string"; value: string; start: number; end: number }
  | { type: "ident"; value: string; start: number; end: number }
  | { type: "field"; value: string; start: number; end: number }
  | { type: "op"; value: string; start: number; end: number }
  | { type: "lparen"; start: number; end: number }
  | { type: "rparen"; start: number; end: number }
  | { type: "comma"; start: number; end: number };

const CONSTANTS = new Set(["TRUE", "FALSE", "BLANK"]);

const PRECEDENCE: Record<string, number> = {
  "=": 1,
  "!=": 1,
  "<": 1,
  ">": 1,
  "<=": 1,
  ">=": 1,
  "&": 2,
  "+": 3,
  "-": 3,
  "*": 4,
  "/": 4,
};

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (ch === "{") {
      let value = "";
      i++;
      while (i < input.length && input[i] !== "}") {
        if (input[i] === "\\" && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
          continue;
        }
        value += input[i];
        i++;
      }
      if (i >= input.length) throw new FormulaParseError("Unclosed field reference: missing }");
      i++;
      const name = value.trim();
      if (!name) throw new FormulaParseError("Empty field reference {}");
      tokens.push({ type: "field", value: name, start, end: i });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let value = "";
      let closed = false;
      while (i < input.length) {
        const c = input[i]!;
        if (c === "\\" && i + 1 < input.length) {
          const n = input[i + 1]!;
          value += n === "n" ? "\n" : n === "t" ? "\t" : n;
          i += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!closed) throw new FormulaParseError("Unterminated string");
      tokens.push({ type: "string", value, start, end: i });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(input[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(input.slice(i))!;
      i += m[0].length;
      tokens.push({ type: "number", value: m[0], start, end: i });
      continue;
    }
    if (/[\p{L}_$]/u.test(ch)) {
      let value = ch;
      i++;
      while (i < input.length && /[\p{L}\p{N}_$.]/u.test(input[i]!)) {
        value += input[i];
        i++;
      }
      tokens.push({ type: "ident", value, start, end: i });
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === "!=" || two === "<>" || two === "<=" || two === ">=" || two === "==" || two === "&&" || two === "||") {
      const map: Record<string, string> = { "<>": "!=", "==": "=", "&&": "AND", "||": "OR" };
      const v = map[two] ?? two;
      i += 2;
      if (v === "AND" || v === "OR") tokens.push({ type: "ident", value: v, start, end: i });
      else tokens.push({ type: "op", value: v, start, end: i });
      continue;
    }
    if ("+-*/&=<>".includes(ch)) {
      i++;
      tokens.push({ type: "op", value: ch, start, end: i });
      continue;
    }
    if (ch === ",") {
      i++;
      tokens.push({ type: "comma", start, end: i });
      continue;
    }
    if (ch === "(") {
      i++;
      tokens.push({ type: "lparen", start, end: i });
      continue;
    }
    if (ch === ")") {
      i++;
      tokens.push({ type: "rparen", start, end: i });
      continue;
    }
    throw new FormulaParseError(`Unexpected character "${ch}"`);
  }

  return tokens;
}

/** True if the ident token at index `idx` is used as a bare field reference. */
function isBareFieldIdent(tokens: Token[], idx: number): boolean {
  const t = tokens[idx];
  if (!t || t.type !== "ident") return false;
  const upper = t.value.toUpperCase();
  if (tokens[idx + 1]?.type === "lparen") return false;
  if (CONSTANTS.has(upper)) return false;
  if (upper === "AND" || upper === "OR") {
    // Infix AND/OR (legacy syntax) when between two operands.
    const prev = tokens[idx - 1];
    if (prev && prev.type !== "op" && prev.type !== "lparen" && prev.type !== "comma") return false;
  }
  return true;
}

export function parseFormula(input: string): FormulaAst {
  const tokens = tokenize(input);
  if (tokens.length === 0) return { kind: "blank" };
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const atEnd = (): boolean => pos >= tokens.length;

  const advance = (): Token => {
    const t = tokens[pos];
    if (!t) throw new FormulaParseError("Unexpected end of formula");
    pos++;
    return t;
  };

  const expect = (type: Token["type"], what: string): Token => {
    const t = peek();
    if (!t || t.type !== type) {
      throw new FormulaParseError(`Expected ${what}${t ? ` at position ${t.start + 1}` : " at end of formula"}`);
    }
    return advance();
  };

  // Precedence climbing. Levels: OR(-1) AND(0) comparison(1) &(2) +-(3) */(4)
  const parseExpression = (minPrec: number): FormulaAst => {
    let left = parseUnary();

    while (!atEnd()) {
      const t = peek()!;

      if (t.type === "ident" && !isBareFieldIdent(tokens, pos)) {
        const upper = t.value.toUpperCase();
        if (upper === "OR" && minPrec <= -1) {
          advance();
          left = { kind: "call", name: "OR", args: [left, parseExpression(0)] };
          continue;
        }
        if (upper === "AND" && minPrec <= 0) {
          advance();
          left = { kind: "call", name: "AND", args: [left, parseExpression(1)] };
          continue;
        }
        break;
      }

      if (t.type !== "op") break;
      const prec = PRECEDENCE[t.value];
      if (prec === undefined || prec < minPrec) break;
      advance();
      left = {
        kind: "binary",
        op: t.value as BinaryOp,
        left,
        right: parseExpression(prec + 1),
      };
    }

    return left;
  };

  const parseUnary = (): FormulaAst => {
    const t = peek();
    if (t?.type === "op" && (t.value === "-" || t.value === "+")) {
      advance();
      const expr = parseUnary();
      if (t.value === "-" && expr.kind === "number") return { kind: "number", value: -expr.value };
      return { kind: "unary", op: t.value === "-" ? "neg" : "pos", expr };
    }
    return parsePrimary();
  };

  const parsePrimary = (): FormulaAst => {
    const t = peek();
    if (!t) throw new FormulaParseError("Unexpected end of formula");

    if (t.type === "number") {
      advance();
      return { kind: "number", value: Number(t.value) };
    }
    if (t.type === "string") {
      advance();
      return { kind: "string", value: t.value };
    }
    if (t.type === "field") {
      advance();
      return { kind: "field", name: t.value };
    }
    if (t.type === "ident") {
      const name = t.value.toUpperCase();
      if (isBareFieldIdent(tokens, pos)) {
        advance();
        return { kind: "field", name: t.value };
      }
      advance();
      if (peek()?.type === "lparen") {
        advance();
        const args: FormulaAst[] = [];
        if (peek()?.type !== "rparen") {
          args.push(parseExpression(-1));
          while (peek()?.type === "comma") {
            advance();
            args.push(parseExpression(-1));
          }
        }
        expect("rparen", `")" to close ${name}(`);
        if (name === "TRUE" && args.length === 0) return { kind: "boolean", value: true };
        if (name === "FALSE" && args.length === 0) return { kind: "boolean", value: false };
        if (name === "BLANK" && args.length === 0) return { kind: "blank" };
        return { kind: "call", name, args };
      }
      if (name === "TRUE") return { kind: "boolean", value: true };
      if (name === "FALSE") return { kind: "boolean", value: false };
      if (name === "BLANK") return { kind: "blank" };
      throw new FormulaParseError(`Unexpected "${t.value}"`);
    }
    if (t.type === "lparen") {
      advance();
      const expr = parseExpression(-1);
      expect("rparen", '")"');
      return expr;
    }
    if (t.type === "rparen") throw new FormulaParseError(`Unexpected ")" at position ${t.start + 1}`);
    if (t.type === "comma") throw new FormulaParseError(`Unexpected "," at position ${t.start + 1}`);
    throw new FormulaParseError(`Unexpected operator "${t.value}" at position ${t.start + 1}`);
  };

  const ast = parseExpression(-1);
  if (!atEnd()) {
    const t = peek()!;
    throw new FormulaParseError(`Unexpected ${t.type === "rparen" ? '")"' : "token"} at position ${t.start + 1}`);
  }
  return ast;
}

/** Unique field references (raw text) in an AST, in first-seen order. */
export function formulaFieldRefs(ast: FormulaAst): string[] {
  const out: string[] = [];
  const walk = (n: FormulaAst): void => {
    switch (n.kind) {
      case "field":
        if (!out.includes(n.name)) out.push(n.name);
        return;
      case "unary":
        walk(n.expr);
        return;
      case "binary":
        walk(n.left);
        walk(n.right);
        return;
      case "call":
        n.args.forEach(walk);
        return;
      default:
        return;
    }
  };
  walk(ast);
  return out;
}

function escapeFieldRef(ref: string): string {
  return ref.replace(/[\\}]/g, (c) => `\\${c}`);
}

/**
 * Rewrite every field reference in `expr` (braced or bare) using `map`.
 * `map` returns the replacement reference text, or null to keep the original.
 * The rest of the expression text is preserved byte-for-byte.
 */
export function rewriteFormulaRefs(expr: string, map: (ref: string) => string | null): string {
  const tokens = tokenize(expr);
  let out = "";
  let last = 0;
  tokens.forEach((t, idx) => {
    const isRef = t.type === "field" || (t.type === "ident" && isBareFieldIdent(tokens, idx));
    if (!isRef) return;
    const next = map(t.value);
    if (next === null) return;
    out += expr.slice(last, t.start) + `{${escapeFieldRef(next)}}`;
    last = t.end;
  });
  return out + expr.slice(last);
}
