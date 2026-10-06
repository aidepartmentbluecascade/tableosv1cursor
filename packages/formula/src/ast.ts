export type FormulaValue = string | number | boolean | null;

export type FormulaAst =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "blank" }
  | { kind: "field"; name: string }
  | { kind: "unary"; op: "not" | "neg"; expr: FormulaAst }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "&"; left: FormulaAst; right: FormulaAst }
  | { kind: "call"; name: string; args: FormulaAst[] };
