// Kimi Code provider with dynamic model discovery.
// Registers as "lc-kimi-code" to inherit the built-in Kimi Coding runtime
// handling (provider overrides in pi-ai). Connects to api.kimi.com/coding
// and discovers models dynamically from the /v1/models endpoint.

interface KimiModel {
  id: string;
  context_length?: number;
  supports_image_in?: boolean;
  supports_video_in?: boolean;
  supports_reasoning?: boolean;
  supports_thinking_type?: string;
}

interface Connection {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

export default function activate(letta: any) {
  if (!letta.capabilities?.providers) return;

  return letta.providers.register("lc-kimi-code", {
    name: "Kimi Code",
    description:
      "Kimi models via the Kimi Code API (api.kimi.com/coding) with dynamic model discovery",
    api: "anthropic-messages",
    baseUrl: "https://api.kimi.com/coding",
    apiKey: "KIMI_API_KEY",
    authHeader: true,
    headers: { "User-Agent": "KimiCLI/1.5" },
    models: [],

    async listModels(connection: Connection) {
      const url = `${connection.baseUrl}/v1/models`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          "User-Agent": "KimiCLI/1.5",
          ...connection.headers,
        },
      });
      if (!response.ok) {
        throw new Error(
          `Kimi Platform model list failed (${response.status})`,
        );
      }
      const body = (await response.json()) as { data?: KimiModel[] };

      if (!Array.isArray(body.data)) {
        throw new Error("Unexpected response from /v1/models");
      }

      return body.data.map((m) => ({
        id: m.id,
        name: m.id,
        reasoning: m.supports_reasoning ?? false,
        input: (m.supports_image_in || m.supports_video_in
          ? ["text", "image"]
          : ["text"]) as Array<"text" | "image">,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.context_length ?? 262144,
        maxTokens: Math.min((m.context_length ?? 262144) / 4, 32768),
        // k3 and similar models require thinking to always be enabled
        // (supports_thinking_type: "only"). Setting off: null prevents
        // the runtime from disabling thinking.
        thinkingLevelMap: m.supports_thinking_type === "only"
          ? { off: null, low: "low", high: "high", max: "max" }
          : undefined,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          thinkingFormat: "deepseek" as const,
        },
      }));
    },

    connect: {
      fields: [{ key: "apiKey", label: "Kimi Code API Key", secret: true }],
    },
  });
}
