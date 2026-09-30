import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function exists(dir: string, rel: string): boolean {
  return existsSync(join(dir, rel));
}

export function readText(dir: string, rel: string): string | null {
  try {
    return readFileSync(join(dir, rel), "utf8");
  } catch {
    return null;
  }
}

export function readJson<T = unknown>(dir: string, rel: string): T | null {
  const text = readText(dir, rel);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function firstExisting(dir: string, candidates: string[]): string | null {
  for (const c of candidates) if (exists(dir, c)) return c;
  return null;
}

// Directory listings are used to build fact strings shown to the user (e.g. the CI
// workflow list). Sort them so the result depends only on the set of files present,
// not on the order the filesystem happens to return from readdirSync.
export function listDir(dir: string, rel = "."): string[] {
  try {
    return readdirSync(join(dir, rel)).sort();
  } catch {
    return [];
  }
}

export function isDir(dir: string, rel: string): boolean {
  try {
    return statSync(join(dir, rel)).isDirectory();
  } catch {
    return false;
  }
}
