/**
 * D6: Unit tests for sanitizeDigestHtml — the allowlist HTML sanitizer
 * applied to Gemini output before embedding in digest emails.
 */
import { describe, expect, it } from "vitest";
import { sanitizeDigestHtml } from "../src/digest-render.js";

describe("sanitizeDigestHtml", () => {
  it("strips <script> tags and their content", () => {
    const out = sanitizeDigestHtml('<p>Hi</p><script>alert("xss")</script><p>Bye</p>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert");
    expect(out).toContain("<p>Hi</p>");
    expect(out).toContain("<p>Bye</p>");
  });

  it("strips onclick and other on* event attributes", () => {
    const out = sanitizeDigestHtml('<p onclick="evil()">click me</p>');
    expect(out).not.toContain("onclick");
    expect(out).toContain("click me");
  });

  it("strips javascript: href and neutralizes the link", () => {
    const out = sanitizeDigestHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain('<a href="javascript:');
    expect(out).toContain("click");
  });

  it("allows safe https:// href in <a> tags", () => {
    const out = sanitizeDigestHtml('<a href="https://example.com">link</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain("link");
  });

  it("allows http:// href in <a> tags", () => {
    const out = sanitizeDigestHtml('<a href="http://example.com">link</a>');
    expect(out).toContain('href="http://example.com"');
  });

  it("allows h2, h3, p, ul, ol, li, strong, em, br tags", () => {
    const input =
      "<h2>Title</h2><h3>Sub</h3><p>Para</p><ul><li>Item</li></ul><ol><li>A</li></ol><strong>Bold</strong><em>Italic</em><br>";
    const out = sanitizeDigestHtml(input);
    expect(out).toContain("<h2>");
    expect(out).toContain("<h3>");
    expect(out).toContain("<p>");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>");
    expect(out).toContain("<ol>");
    expect(out).toContain("<strong>");
    expect(out).toContain("<em>");
    expect(out).toContain("<br>");
  });

  it("preserves plain text content", () => {
    const out = sanitizeDigestHtml("<p>Hello world</p>");
    expect(out).toContain("Hello world");
  });

  it("strips non-allowlisted tags but preserves their text content", () => {
    const out = sanitizeDigestHtml('<div class="foo">content</div>');
    expect(out).not.toContain("<div");
    expect(out).toContain("content");
  });

  it("strips <style> blocks including their content", () => {
    const out = sanitizeDigestHtml("<style>body{color:red}</style><p>text</p>");
    expect(out).not.toContain("<style");
    expect(out).not.toContain("color:red");
    expect(out).toContain("<p>text</p>");
  });

  it("strips <iframe> blocks including their content", () => {
    const out = sanitizeDigestHtml('<iframe src="https://evil.com">content</iframe><p>ok</p>');
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("evil.com");
    expect(out).toContain("<p>ok</p>");
  });

  it("strips class and style attributes from allowed tags", () => {
    const out = sanitizeDigestHtml('<p class="big" style="color:red">text</p>');
    expect(out).not.toContain("class=");
    expect(out).not.toContain("style=");
    expect(out).toContain("text");
  });

  it("handles empty input gracefully", () => {
    expect(sanitizeDigestHtml("")).toBe("");
  });

  it("handles plain text with no tags", () => {
    const out = sanitizeDigestHtml("Just plain text.");
    expect(out).toBe("Just plain text.");
  });
});
