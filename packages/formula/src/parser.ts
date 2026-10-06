import type { FormulaAst } from "./ast.js";

export class FormulaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaParseError";
  }
}

type Token =
  | { type: "number"; value: string }
  | { type: "string"; value: string }
  | { type: "ident"; value: string }
  | { type: "field"; value: string }
  | { type: "op"; value: string }
  | { type: "lparen" }
  | { type: "rparen" }
  | { type: "comma" };

export function parseFormula(input: string): FormulaAst {
  const tokens = tokenize(input);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const atEnd = (): boolean => pos >= tokens.length;

  const advance = (): Token => {
    const t = tokens[pos];
    if (!t) throw new FormulaParseError("Unexpected end of formula");
    pos++;
    return t;
  };

  const expect = (type: Token["type"]): Token => {
    const t = peek();
    if (!t || t.type !== type) {
      throw new FormulaParseError(`Expected ${type}`);
    }
    return advance();
  };

  const parseExpression = (minPrec: number): FormulaAst => {
    let left = parseUnary();

    while (!atEnd()) {
      const t = peek()!;

      if (t.type === "ident") {
        const upper = t.value.toUpperCase();
        if (upper === "AND" && 2 >= minPrec) {
          advance();
          left = { kind: "call", name: "AND", args: [left, parseExpression(3)] };
          continue;
        }
        if (upper === "OR" && 1 >= minPrec) {
          advance();
          left = { kind: "call", name: "OR", args: [left, parseExpression(2)] };
          continue;
        }
        break;
      }

      if (t.type !== "op") break;
      const op = t.value;
      let prec = 0;
      if (op === "&") prec = 3;
      else if (op === "+" || op === "-") prec = 4;
      else if (op === "*" || op === "/") prec = 5;
      else break;

      if (prec < minPrec) break;
      advance();
      left = {
        kind: "binary",
        op: op as "+" | "-" | "*" | "/" | "&",
        left,
        right: parseExpression(prec + 1),
      };
    }

    return left;
  };

  const parseUnary = (): FormulaAst => {
    const t = peek();
    if (t?.type === "op" && t.value === "-") {
      advance();
      return { kind: "unary", op: "neg", expr: parseUnary() };
    }
    if (t?.type === "ident" && t.value.toUpperCase() === "NOT") {
      advance();
      expect("lparen");
      const inner = parseExpression(0);
      expect("rparen");
      return { kind: "unary", op: "not", expr: inner };
    }
    return parsePrimary();
  };

  const parsePrimary = (): FormulaAst => {
    const t = peek();
    if (!t) throw new FormulaParseError("Expected expression");

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
      advance();
      const name = t.value.toUpperCase();
      if (name === "TRUE") return { kind: "boolean", value: true };
      if (name === "FALSE") return { kind: "boolean", value: false };
      if (name === "BLANK") return { kind: "blank" };

      if (peek()?.type === "lparen") {
        advance();
        const args: FormulaAst[] = [];
        if (peek()?.type !== "rparen") {
          args.push(parseExpression(0));
          while (peek()?.type === "comma") {
            advance();
            args.push(parseExpression(0));
          }
        }
        expect("rparen");
        return { kind: "call", name, args };
      }
      throw new FormulaParseError(`Unknown identifier ${name}`);
    }
    if (t.type === "lparen") {
      advance();
      const expr = parseExpression(0);
      expect("rparen");
      return expr;
    }
    throw new FormulaParseError(`Unexpected token ${t.type}`);
  };

  const ast = parseExpression(0);
  if (!atEnd()) {
    throw new FormulaParseError("Unexpected trailing tokens");
  }
  return ast;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "{") {
      const end = input.indexOf("}", i + 1);
      if (end < 0) throw new FormulaParseError("Unclosed field reference");
      tokens.push({ type: "field", value: input.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let value = "";
      while (i < input.length && input[i] !== quote) {
        value += input[i];
        i++;
      }
      i++;
      tokens.push({ type: "string", value });
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let value = ch;
      i++;
      while (i < input.length && /[0-9.]/.test(input[i]!)) {
        value += input[i];
        i++;
      }
      tokens.push({ type: "number", value });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let value = ch;
      i++;
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i]!)) {
        value += input[i];
        i++;
      }
      tokens.push({ type: "ident", value });
      continue;
    }
    if ("+-*/&,".includes(ch)) {
      tokens.push(ch === "," ? { type: "comma" } : { type: "op", value: ch });
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
    throw new FormulaParseError(`Unexpected character ${ch}`);
  }

  return tokens;
}
