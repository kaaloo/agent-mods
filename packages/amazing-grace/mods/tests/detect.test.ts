import { describe, expect, it } from "vitest";
import { contentHasImagePart, inputHasImages, messageHasImage, toolResultLikelyImage } from "../lib/detect.ts";

describe("contentHasImagePart", () => {
  it("accepts base64 image parts (verified wire format)", () => {
    expect(
      contentHasImagePart([{ type: "image", source: { type: "base64", media_type: "image/png", data: "xx" } }, { type: "text", text: "hi" }]),
    ).toBe(true);
  });

  it("accepts image_url style parts", () => {
    expect(contentHasImagePart([{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }])).toBe(true);
  });

  it("rejects text-only content", () => {
    expect(contentHasImagePart("plain string")).toBe(false);
    expect(contentHasImagePart([{ type: "text", text: "hello" }])).toBe(false);
    expect(contentHasImagePart([])).toBe(false);
  });
});

describe("messageHasImage", () => {
  it("detects images in user message content", () => {
    expect(messageHasImage({ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "x" } }] })).toBe(true);
  });

  it("detects images inside approval tool returns", () => {
    expect(
      messageHasImage({
        type: "approval",
        approvals: [{ tool_call_id: "t1", tool_return: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] } }],
      }),
    ).toBe(true);
  });

  it("passes on plain text messages", () => {
    expect(messageHasImage({ role: "user", content: "hello" })).toBe(false);
    expect(messageHasImage(null)).toBe(false);
  });
});

describe("inputHasImages", () => {
  it("scans the full turn input", () => {
    expect(inputHasImages([{ role: "user", content: "a" }, { role: "user", content: [{ type: "text", text: "b" }] }])).toBe(false);
    expect(inputHasImages([{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }])).toBe(true);
    expect(inputHasImages(null)).toBe(false);
  });
});

describe("toolResultLikelyImage", () => {
  it("matches the Read tool with image file paths", () => {
    expect(toolResultLikelyImage("Read", { file_path: "/tmp/shot.PNG" })).toBe(true);
    expect(toolResultLikelyImage("Read", { file_path: "/tmp/img.jpeg" })).toBe(true);
    expect(toolResultLikelyImage("read_file", { path: "chart.webp" })).toBe(true);
  });

  it("does not match non-image paths or unknown tools", () => {
    expect(toolResultLikelyImage("Read", { file_path: "/tmp/main.ts" })).toBe(false);
    expect(toolResultLikelyImage("Bash", { command: "cat x.png" })).toBe(false);
    expect(toolResultLikelyImage(null, { file_path: "a.png" })).toBe(false);
    expect(toolResultLikelyImage("Read", null)).toBe(false);
  });
});
