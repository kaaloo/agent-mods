// mods/index.ts
function activate(letta) {
  if (!letta.capabilities?.providers)
    return;
  return letta.providers.register("lc-kimi-code", {
    name: "Kimi Code",
    description: "Kimi models via the Kimi Code API (api.kimi.com/coding) with dynamic model discovery",
    api: "anthropic-messages",
    baseUrl: "https://api.kimi.com/coding",
    apiKey: "KIMI_API_KEY",
    authHeader: true,
    headers: { "User-Agent": "KimiCLI/1.5" },
    models: [],
    async listModels(connection) {
      const url = `${connection.baseUrl}/v1/models`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${connection.apiKey}`,
          "User-Agent": "KimiCLI/1.5",
          ...connection.headers
        }
      });
      if (!response.ok) {
        throw new Error(`Kimi Platform model list failed (${response.status})`);
      }
      const body = await response.json();
      if (!Array.isArray(body.data)) {
        throw new Error("Unexpected response from /v1/models");
      }
      return body.data.map((m) => ({
        id: m.id,
        name: m.id,
        reasoning: m.supports_reasoning ?? false,
        input: m.supports_image_in || m.supports_video_in ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.context_length ?? 262144,
        maxTokens: Math.min((m.context_length ?? 262144) / 4, 32768),
        thinkingLevelMap: m.supports_thinking_type === "only" ? { off: null, low: "low", high: "high", max: "max" } : undefined,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: true,
          thinkingFormat: "deepseek"
        }
      }));
    },
    connect: {
      fields: [{ key: "apiKey", label: "Kimi Code API Key", secret: true }]
    }
  });
}
export {
  activate as default
};
