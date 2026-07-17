export const WORKFLOW_VERSION = "1";
export const DEFAULT_MAX_CONCURRENT = 4;
export const MAX_WORKFLOW_NAME_LENGTH = 64;

export interface WorkflowDefinition {
  name: string;
  version: typeof WORKFLOW_VERSION;
  description: string;
  phases: Phase[];
  budgets?: {
    max_tokens?: number;
    max_concurrent?: number;
    max_duration_ms?: number;
  };
}

export type Phase = FanOutPhase | BarrierPhase;

export interface FanOutPhase {
  id: string;
  type: "fan-out";
  model?: string;
  concurrency?: number;
  agents: AgentTask[];
}

export interface BarrierPhase {
  id: string;
  type: "barrier";
  depends_on: string[];
  model?: string;
  prompt: string;
}

export interface AgentTask {
  id: string;
  prompt: string;
  output_schema?: Record<string, unknown>;
}

export interface ValidationError {
  path: string;
  message: string;
}

export function validateWorkflow(value: unknown): { workflow?: WorkflowDefinition; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!value || typeof value !== "object") {
    return { errors: [{ path: "", message: "Workflow must be an object." }] };
  }

  const obj = value as Record<string, unknown>;

  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) {
    errors.push({ path: "name", message: "Workflow name is required." });
  } else if (name.length > MAX_WORKFLOW_NAME_LENGTH) {
    errors.push({ path: "name", message: `Workflow name must be at most ${MAX_WORKFLOW_NAME_LENGTH} characters.` });
  }

  if (obj.version !== WORKFLOW_VERSION) {
    errors.push({ path: "version", message: `Workflow version must be "${WORKFLOW_VERSION}".` });
  }

  if (typeof obj.description !== "string" || !obj.description.trim()) {
    errors.push({ path: "description", message: "Workflow description is required." });
  }

  if (!Array.isArray(obj.phases) || obj.phases.length === 0) {
    errors.push({ path: "phases", message: "Workflow must have at least one phase." });
  } else {
    const phaseIds = new Set<string>();
    for (let i = 0; i < obj.phases.length; i++) {
      const phase = obj.phases[i];
      if (!phase || typeof phase !== "object") {
        errors.push({ path: `phases[${i}]`, message: "Phase must be an object." });
        continue;
      }
      const p = phase as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id.trim() : "";
      if (!id) {
        errors.push({ path: `phases[${i}].id`, message: "Phase id is required." });
      } else if (phaseIds.has(id)) {
        errors.push({ path: `phases[${i}].id`, message: `Duplicate phase id "${id}".` });
      } else {
        phaseIds.add(id);
      }

      const type = typeof p.type === "string" ? p.type : "";
      if (type === "fan-out") {
        if (!Array.isArray(p.agents) || p.agents.length === 0) {
          errors.push({ path: `phases[${i}].agents`, message: "fan-out phase must have at least one agent." });
        } else {
          const agentIds = new Set<string>();
          for (let j = 0; j < p.agents.length; j++) {
            const agent = p.agents[j];
            if (!agent || typeof agent !== "object") {
              errors.push({ path: `phases[${i}].agents[${j}]`, message: "Agent must be an object." });
              continue;
            }
            const a = agent as Record<string, unknown>;
            const agentId = typeof a.id === "string" ? a.id.trim() : "";
            if (!agentId) {
              errors.push({ path: `phases[${i}].agents[${j}].id`, message: "Agent id is required." });
            } else if (agentIds.has(agentId)) {
              errors.push({ path: `phases[${i}].agents[${j}].id`, message: `Duplicate agent id "${agentId}".` });
            } else {
              agentIds.add(agentId);
            }
            if (typeof a.prompt !== "string" || !a.prompt.trim()) {
              errors.push({ path: `phases[${i}].agents[${j}].prompt`, message: "Agent prompt is required." });
            }
          }
        }
      } else if (type === "barrier") {
        if (!Array.isArray(p.depends_on) || p.depends_on.length === 0) {
          errors.push({ path: `phases[${i}].depends_on`, message: "barrier phase must have at least one depends_on phase id." });
        } else {
          for (let k = 0; k < p.depends_on.length; k++) {
            if (typeof p.depends_on[k] !== "string" || !p.depends_on[k].trim()) {
              errors.push({ path: `phases[${i}].depends_on[${k}]`, message: "depends_on entry must be a non-empty string." });
            }
          }
        }
        if (typeof p.prompt !== "string" || !p.prompt.trim()) {
          errors.push({ path: `phases[${i}].prompt`, message: "barrier phase prompt is required." });
        }
      } else {
        errors.push({ path: `phases[${i}].type`, message: `Phase type must be "fan-out" or "barrier", got "${type}".` });
      }
    }

    // Resolve depends_on after all ids are collected.
    if (phaseIds.size > 0) {
      for (let i = 0; i < obj.phases.length; i++) {
        const phase = obj.phases[i] as Record<string, unknown>;
        if (phase.type === "barrier" && Array.isArray(phase.depends_on)) {
          for (const dep of phase.depends_on) {
            if (typeof dep === "string" && dep.trim() && !phaseIds.has(dep.trim())) {
              errors.push({ path: `phases[${i}].depends_on`, message: `Unknown phase id "${dep.trim()}".` });
            }
          }
        }
      }
    }
  }

  if (obj.budgets && typeof obj.budgets === "object") {
    const b = obj.budgets as Record<string, unknown>;
    if (b.max_tokens !== undefined && (typeof b.max_tokens !== "number" || !Number.isFinite(b.max_tokens) || b.max_tokens <= 0)) {
      errors.push({ path: "budgets.max_tokens", message: "max_tokens must be a positive number." });
    }
    if (b.max_concurrent !== undefined && (typeof b.max_concurrent !== "number" || !Number.isInteger(b.max_concurrent) || b.max_concurrent <= 0)) {
      errors.push({ path: "budgets.max_concurrent", message: "max_concurrent must be a positive integer." });
    }
    if (b.max_duration_ms !== undefined && (typeof b.max_duration_ms !== "number" || !Number.isFinite(b.max_duration_ms) || b.max_duration_ms <= 0)) {
      errors.push({ path: "budgets.max_duration_ms", message: "max_duration_ms must be a positive number." });
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  return { workflow: obj as unknown as WorkflowDefinition, errors: [] };
}

export function isFanOutPhase(phase: Phase): phase is FanOutPhase {
  return phase.type === "fan-out";
}

export function isBarrierPhase(phase: Phase): phase is BarrierPhase {
  return phase.type === "barrier";
}

export function getPhaseMaxConcurrent(phase: Phase, workflowBudgets?: WorkflowDefinition["budgets"]): number {
  const workflowCap = workflowBudgets?.max_concurrent;
  if (isFanOutPhase(phase)) {
    const phaseCap = phase.concurrency;
    if (phaseCap && phaseCap > 0) return phaseCap;
  }
  if (workflowCap && workflowCap > 0) return workflowCap;
  return DEFAULT_MAX_CONCURRENT;
}

export function phaseById(workflow: WorkflowDefinition, phaseId: string): Phase | undefined {
  return workflow.phases.find((p) => p.id === phaseId);
}

export function isPhaseComplete(workflow: WorkflowDefinition, phaseId: string, completedAgents: Set<string>): boolean {
  const phase = phaseById(workflow, phaseId);
  if (!phase) return false;
  if (isFanOutPhase(phase)) {
    return phase.agents.every((a) => completedAgents.has(a.id));
  }
  if (isBarrierPhase(phase)) {
    return phase.depends_on.every((depId) => {
      const depPhase = phaseById(workflow, depId);
      if (!depPhase) return false;
      if (isFanOutPhase(depPhase)) {
        return depPhase.agents.every((a) => completedAgents.has(a.id));
      }
      return true;
    });
  }
  return false;
}

export function nextPhase(workflow: WorkflowDefinition, completedPhaseIds: Set<string>): Phase | undefined {
  for (const phase of workflow.phases) {
    if (completedPhaseIds.has(phase.id)) continue;
    if (isBarrierPhase(phase)) {
      const depsComplete = phase.depends_on.every((id) => completedPhaseIds.has(id));
      if (!depsComplete) return undefined;
    }
    return phase;
  }
  return undefined;
}

export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join("\n");
}
