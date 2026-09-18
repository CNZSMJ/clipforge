import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A raw control byte written into a source file (instead of its escape) turns the
 * file into "data" for every tool that sniffs content: the file reader refuses it,
 * \`git diff\` prints "Binary files differ", and no one can review the change.
 *
 * That happened once: a regex character class meant to be written \`[\\x00-,...\\x7f]\`
 * was stored with the NUL and DEL bytes inline. These files are UTF-8 text; any
 * control byte other than tab/newline/CR is a bug in the source, not content.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".css", ".json"];
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

describe("source encoding", () => {
  it("uses escape sequences, never raw control bytes, in text sources", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const bytes = readFileSync(file);
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        if (ALLOWED.has(byte)) continue;
        if (byte < 0x20 || byte === 0x7f) {
          offenders.push(`${relative("src", file)}:${i} has raw control byte 0x${byte.toString(16).padStart(2, "0")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no NUL byte in any text source", () => {
    const offenders = sourceFiles("src").filter((file) => readFileSync(file).includes(0));
    expect(offenders).toEqual([]);
  });
});
