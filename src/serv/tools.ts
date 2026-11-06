/**
 * SERV Tools are switches, not functions: SERV strips any tool named serv_* before the
 * request reaches the model. Options are passed as JSON-schema defaults.
 */

export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ShadowAgentOptions {
  /** Extra validation criteria, e.g. "the decision must name the per-transaction cap". */
  hint?: string;
  /** Validation attempts, 1 to 10. SERV defaults to 3. */
  maxIterations?: number;
}

export function promptGuard(): FunctionTool {
  return { type: "function", function: { name: "serv_prompt_guard" } };
}

export function shadowAgent(options: ShadowAgentOptions = {}): FunctionTool {
  const properties: Record<string, unknown> = {};
  if (options.hint !== undefined) {
    if (options.hint.trim() === "") throw new Error("shadow agent hint must not be empty");
    properties.hint = { type: "string", default: options.hint };
  }
  if (options.maxIterations !== undefined) {
    const n = options.maxIterations;
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("shadow agent max_iterations must be an integer from 1 to 10");
    properties.max_iterations = { type: "integer", default: n };
  }
  return {
    type: "function",
    function: {
      name: "serv_shadow_agent",
      description: "Enable SERV shadow-agent validation.",
      parameters: { type: "object", properties },
    },
  };
}

export function isServTool(tool: FunctionTool): boolean {
  return tool.function.name.startsWith("serv_");
}
