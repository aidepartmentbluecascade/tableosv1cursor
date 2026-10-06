/** Values produced by formula evaluation (public output never contains Date). */
export type FormulaValue = string | number | boolean | null | FormulaValue[];

/** Internal runtime value (dates stay as Date until output). */
export type RuntimeValue = string | number | boolean | null | Date | RuntimeValue[];

export type BinaryOp = "+" | "-" | "*" | "/" | "&" | "=" | "!=" | "<" | ">" | "<=" | ">=";

export type FormulaAst =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "blank" }
  /** `name` is the raw reference text: a field name, or a field id (`fld_…`). */
  | { kind: "field"; name: string }
  | { kind: "unary"; op: "not" | "neg" | "pos"; expr: FormulaAst }
  | { kind: "binary"; op: BinaryOp; left: FormulaAst; right: FormulaAst }
  | { kind: "call"; name: string; args: FormulaAst[] };
