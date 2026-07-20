// Minimal client for the Letta Cloud API. Posts a user message to a
// persistent agent and returns the assistant's final text. Used by
// letta-inline-review.mjs to call the same agent that the
// letta-ai/letta-code-action conversational workflow uses, but
// without the CLI driver in the loop.
//
// Docs: https://docs.letta.com/api-reference/agents/messages

const DEFAULT_BASE_URL = 'https://api.letta.com';

/**
 * Send a single user message to a Letta agent and resolve with the
 * assistant's final text response.
 *
 * @param {object} args
 * @param {string} args.agentId - Target agent ID.
 * @param {string} args.userMessage - The user-role message body.
 * @param {string} args.systemPrompt - System prompt sent as the first message in the request.
 * @param {string} args.apiKey - Letta API key.
 * @param {string} [args.baseUrl] - Override for the API base URL (testing only).
 * @param {string} [args.model] - Model handle to override, or "auto" for the agent default.
 * @param {number} [args.timeoutMs=120000] - Request timeout.
 * @returns {Promise<{text: string, messages: Array}>}
 */
export async function sendAgentMessage({
  agentId,
  userMessage,
  systemPrompt,
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model,
  timeoutMs = 120_000,
}) {
  if (!agentId) throw new Error('sendAgentMessage: agentId is required');
  if (!userMessage) throw new Error('sendAgentMessage: userMessage is required');
  if (!apiKey) throw new Error('sendAgentMessage: apiKey is required');

  const url = `${baseUrl.replace(/\/$/, '')}/v1/agents/${encodeURIComponent(agentId)}/messages`;

  const body = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    // Ask the model not to think out loud; we only want the JSON block.
    streaming: false,
  };
  if (model && model !== 'auto') body.override_model = model;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Letta API ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
    );
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error(`Letta API returned non-JSON body: ${text.slice(0, 500)}`);
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const assistantMessages = messages.filter((m) => m?.message_type === 'assistant_message' || m?.role === 'assistant');
  const finalText = extractAssistantText(assistantMessages.at(-1)) ?? extractAssistantText(messages.at(-1)) ?? '';

  return { text: finalText, messages };
}

function extractAssistantText(message) {
  if (!message) return null;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        return null;
      })
      .filter((s) => s !== null);
    if (parts.length) return parts.join('\n');
  }
  return null;
}
