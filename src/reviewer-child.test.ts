import { Buffer } from "node:buffer";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { paginateOutput, REVIEW_SYSTEM_PROMPT } from "./reviewer-child.js";

function readAllPages(output: string): { reconstructed: string; pages: number } {
  let cursor = 0;
  let reconstructed = "";
  let pages = 0;

  while (true) {
    const page = paginateOutput(output, cursor);
    reconstructed += page.content;
    pages += 1;
    expect(Buffer.byteLength(page.content)).toBeLessThan(DEFAULT_MAX_BYTES);
    if (page.complete) return { reconstructed, pages };
    expect(page.nextCursor).toBeGreaterThan(cursor);
    cursor = page.nextCursor ?? cursor;
  }
}

describe("reviewer policy", () => {
  it("keeps unlikely environmental scenarios out of actionable findings", () => {
    expect(REVIEW_SYSTEM_PROMPT).toContain("realistic in normal supported use");
    expect(REVIEW_SYSTEM_PROMPT).toContain("configuration drift");
    expect(REVIEW_SYSTEM_PROMPT).toContain("in residual risks instead of findings");
    expect(REVIEW_SYSTEM_PROMPT).toContain("Do not invent requirements");
    expect(REVIEW_SYSTEM_PROMPT).toContain("solely for hypothetical edge cases");
    expect(REVIEW_SYSTEM_PROMPT).toContain("demonstrated maintenance or correctness risk");
    expect(REVIEW_SYSTEM_PROMPT).toContain("smallest proportionate recommendation");
  });
});

describe("paginateOutput", () => {
  it("retrieves output larger than both tool limits without losing content", () => {
    const output = Array.from(
      { length: DEFAULT_MAX_LINES + 20 },
      (_, index) => `${index}:${"é".repeat(40)}`,
    ).join("\n");

    const result = readAllPages(output);
    expect(result.pages).toBeGreaterThan(1);
    expect(result.reconstructed).toBe(output);
  });

  it("continues through a single line larger than the byte limit", () => {
    const output = "é".repeat(DEFAULT_MAX_BYTES);
    const result = readAllPages(output);

    expect(result.pages).toBeGreaterThan(1);
    expect(result.reconstructed).toBe(output);
  });

  it("rejects invalid cursors", () => {
    expect(() => paginateOutput("diff", 5)).toThrow("Invalid output cursor");
  });
});
