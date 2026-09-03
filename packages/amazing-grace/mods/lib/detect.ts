// Image content detection for proactive multimodal downgrading.
//
// GLM-family rungs reject image content (Z.ai 400: "messages.content.type is
// invalid, allowed values: ['text']"). The mod scans outbound turn input and
// tool results so the switch happens before the request goes out.

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|avif)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function contentHasImagePart(content: unknown): boolean {
  if (typeof content === "string") return false;
  if (!Array.isArray(content)) return false;
  for (const part of content) {
    if (!isRecord(part)) continue;
    const type = part.type;
    if (type === "image" || type === "image_url" || type === "input_image") return true;
    if (isRecord(part.source) && part.source.type === "base64") return true;
    if (isRecord(part.image_url) || isRecord(part.image)) return true;
  }
  return false;
}

export function messageHasImage(message: unknown): boolean {
  if (!isRecord(message)) return false;
  if (contentHasImagePart(message.content)) return true;
  // Approvals carry tool results whose content can include image parts.
  if (Array.isArray(message.approvals)) {
    for (const approval of message.approvals) {
      if (!isRecord(approval)) continue;
      if (isRecord(approval.tool_return) && contentHasImagePart(approval.tool_return.content)) return true;
    }
  }
  if (isRecord(message.tool_return) && contentHasImagePart(message.tool_return.content)) return true;
  return false;
}

export function inputHasImages(input: unknown[] | null | undefined): boolean {
  if (!Array.isArray(input)) return false;
  return input.some((item) => messageHasImage(item));
}

/**
 * Heuristic for image-bearing tool results observed via tool_end.
 *
 * The tool_end event exposes the output as a string, so multimodal results
 * (e.g. the Read tool returning image bytes for an image file) are inferred
 * from the tool name plus an image-extension path argument. Narrow by design:
 * unknown tools are never treated as image-bearing.
 */
const IMAGE_RESULT_TOOLS = new Set(["read", "read_file", "readfile", "open_files"]);

export function toolResultLikelyImage(toolName: string | null | undefined, args: Record<string, unknown> | null | undefined): boolean {
  if (!toolName || !args) return false;
  const normalized = toolName.toLowerCase().replace(/^multi_tool_use\./, "");
  if (!IMAGE_RESULT_TOOLS.has(normalized)) return false;
  for (const key of ["file_path", "path", "file", "filename"]) {
    const value = args[key];
    if (typeof value === "string" && IMAGE_EXTENSIONS.test(value)) return true;
  }
  return false;
}
