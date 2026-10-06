import type { FormulaAst } from "./ast.js";
import { evaluateFormula, type FormulaContext } from "./evaluate.js";

export type CompiledFormula = (ctx: FormulaContext) => ReturnType<typeof evaluateFormula>;

/** Compile AST to a reusable evaluator closure (Pratt parse → evaluate). */
export function compileFormula(ast: FormulaAst): CompiledFormula {
  return (ctx) => evaluateFormula(ast, ctx);
}
