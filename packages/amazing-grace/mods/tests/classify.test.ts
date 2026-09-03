import { describe, expect, it } from "vitest";
import { actionFor, classifyFailure } from "../lib/classify.ts";

describe("classifyFailure", () => {
  it("classifies verified Z.ai image rejection", () => {
    const text = 'Z.ai Chat Completions API stream failed (400): messages.content.type is invalid, allowed values: [\'text\']';
    expect(classifyFailure(text)).toBe("image");
  });

  it("classifies verified unknown-handle error", () => {
    expect(classifyFailure("Model handle not found: lc-zai-coding/definitely-not-real")).toBe("invalid-model");
  });

  it("classifies auth failures", () => {
    expect(classifyFailure("401 invalid_api_key")).toBe("auth");
    expect(classifyFailure("Unauthorized: Invalid API key provided")).toBe("auth");
    expect(classifyFailure("403 Forbidden")).toBe("auth");
  });

  it("classifies quota failures", () => {
    expect(classifyFailure("429 Too Many Requests")).toBe("quota");
    expect(classifyFailure("rate limit exceeded, retry after 60s")).toBe("quota");
    expect(classifyFailure("You exceeded your current quota")).toBe("quota");
    expect(classifyFailure("402 insufficient credits")).toBe("quota");
    expect(classifyFailure("usage limit reached for this plan")).toBe("quota");
  });

  it("treats transient shapes as transient", () => {
    expect(classifyFailure("overloaded_error")).toBe("transient");
    expect(classifyFailure("Connection timed out")).toBe("transient");
    expect(classifyFailure("503 Service Unavailable")).toBe("transient");
    expect(classifyFailure("")).toBe("transient");
    expect(classifyFailure(null)).toBe("transient");
  });

  it("does not misread numbers embedded in identifiers", () => {
    expect(classifyFailure("run 40123 failed")).toBe("transient");
    expect(classifyFailure("error in step 4299")).toBe("transient");
  });

  it("prefers the most specific match", () => {
    expect(classifyFailure("Model handle not found after 429")).toBe("invalid-model");
    expect(classifyFailure("401 while loading model metadata")).toBe("auth");
  });
});

describe("actionFor", () => {
  it("benches auth and invalid-model as dead", () => {
    expect(actionFor("auth")).toEqual({ bench: "dead", needsMultimodal: false });
    expect(actionFor("invalid-model")).toEqual({ bench: "dead", needsMultimodal: false });
  });

  it("benches quota as cooldown", () => {
    expect(actionFor("quota")).toEqual({ bench: "cooldown", needsMultimodal: false });
  });

  it("requests multimodal for image failures without benching", () => {
    expect(actionFor("image")).toEqual({ bench: null, needsMultimodal: true });
  });

  it("never benches transient failures", () => {
    expect(actionFor("transient")).toEqual({ bench: null, needsMultimodal: false });
  });
});
