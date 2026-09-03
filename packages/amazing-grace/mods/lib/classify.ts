// Provider failure classification from error text.
//
// The patterns below were verified against live API responses on 2026-08-22:
// - Z.ai GLM image rejection: "messages.content.type is invalid, allowed values: ['text']" (400)
// - Unknown handle: "Model handle not found: <handle>" (500)
// Auth and quota shapes follow the provider-standard 401/403/402/429 families.

export type FailureKind = "auth" | "quota" | "image" | "invalid-model" | "transient";

interface Rule {
  kind: FailureKind;
  pattern: RegExp;
}

// Order matters: first matching rule wins. Model-resolution failures are the
// most specific, then auth, then quota/billing, then image-content errors.
const RULES: Rule[] = [
  {
    kind: "invalid-model",
    pattern: /model handle not found|model not found|unknown model|invalid model (handle|name|id)|does not exist[^.]*model/i,
  },
  {
    kind: "auth",
    pattern: /invalid[ _-]?(api[ _-]?key|token)|unauthorized|authentication|forbidden|\b40[13]\b|permission denied/i,
  },
  {
    kind: "quota",
    pattern: /rate[ _-]?limit|quota|usage[ _-]?limit|limit reached|exceeded your|exceeds?.*(limit|quota)|insufficient (credits?|funds|balance)|\b(402|429)\b|billing|past due|too many requests/i,
  },
  {
    kind: "image",
    pattern: /messages\.content\.type is invalid|allowed values: ?\[.?text|image(s)? (is|are) not (supported|allowed)|does not (support|accept) images?|multimodal (support )?(is )?(not|required)|\.image\b/i,
  },
];

// Unmatched text (timeouts, 5xx, network blips, unknown shapes) is transient:
// the mod never benches a rung without a provider-attributable signal.
export function classifyFailure(text: string | null | undefined): FailureKind {
  if (!text) return "transient";
  const value = String(text);
  for (const rule of RULES) {
    if (rule.pattern.test(value)) return rule.kind;
  }
  return "transient";
}

// Decision mapping used by the runtime.
export interface FailureAction {
  bench: "dead" | "cooldown" | null;
  needsMultimodal: boolean;
}

export function actionFor(kind: FailureKind): FailureAction {
  switch (kind) {
    case "auth":
      return { bench: "dead", needsMultimodal: false };
    case "invalid-model":
      return { bench: "dead", needsMultimodal: false };
    case "quota":
      return { bench: "cooldown", needsMultimodal: false };
    case "image":
      return { bench: null, needsMultimodal: true };
    default:
      return { bench: null, needsMultimodal: false };
  }
}
