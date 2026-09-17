import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * Test-environment shims (environment defects, not product defects).
 *
 * 1) Node 22+ ships a global Web Storage *stub* whose methods are unavailable unless
 *    `--localstorage-file` is configured. It shadows jsdom's localStorage, so zustand's persist
 *    middleware throws "storage.setItem is not a function" and every store test fails.
 */
if (typeof globalThis.localStorage?.setItem !== "function") {
  const memory = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return memory.size;
    },
    clear() {
      memory.clear();
    },
    getItem(key: string) {
      return memory.has(key) ? memory.get(key)! : null;
    },
    key(index: number) {
      return Array.from(memory.keys())[index] ?? null;
    },
    removeItem(key: string) {
      memory.delete(key);
    },
    setItem(key: string, value: string) {
      memory.set(key, String(value));
    },
  };
  for (const name of ["localStorage", "sessionStorage"] as const) {
    const current = (globalThis as unknown as Record<string, { setItem?: unknown }>)[name];
    if (typeof current?.setItem === "function") continue;
    Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
  }
}

/**
 * 2) Media tests exercise drawtext / subtitles / showwavespic, and every media assertion runs
 *    ffprobe. The project ships static binaries for exactly that; a system ffmpeg may be built
 *    without libfreetype / libass, and a pnpm install that skipped
 *    @ffprobe-installer's postinstall leaves the shipped ffprobe non-executable. Prefer the
 *    shipped binaries, but only when they actually run.
 */
function runnable(bin: unknown): bin is string {
  if (typeof bin !== "string" || !bin || !existsSync(bin)) return false;
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const require = createRequire(import.meta.url);
if (!runnable(process.env.FFMPEG_PATH)) {
  try {
    const bundled = require("ffmpeg-static") as unknown;
    if (runnable(bundled)) process.env.FFMPEG_PATH = bundled;
  } catch {
    /* keep whatever the environment provides */
  }
}
if (!runnable(process.env.FFPROBE_PATH)) {
  try {
    const probe = require("@ffprobe-installer/ffprobe") as { path?: unknown } | null;
    if (runnable(probe?.path)) process.env.FFPROBE_PATH = probe.path;
  } catch {
    /* keep whatever the environment provides */
  }
}
