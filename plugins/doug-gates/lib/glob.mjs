// Minimal glob matching with no dependencies.
// Supports **, *, ?, {a,b}, and leading "!" negation in matchAny.
// Paths are matched as forward-slash relative paths.

const cache = new Map();

export function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more directories; "**" at end matches everything
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i += 1;
      } else {
        const alts = glob
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
        re += "(?:" + alts.join("|") + ")";
        i = end + 1;
      }
    } else if (/[.+^$()|[\]\\]/.test(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  const compiled = new RegExp("^" + re + "$");
  cache.set(glob, compiled);
  return compiled;
}

export function normalizePath(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function matchGlob(glob, path) {
  const n = normalizePath(path);
  const g = normalizePath(glob);
  if (globToRegExp(g).test(n)) return true;
  // A bare directory-ish pattern like "dist" also matches "dist/anything"
  if (!g.includes("*") && !g.includes("?") && n.startsWith(g + "/")) return true;
  // Patterns without a slash match a basename anywhere (like .gitignore)
  if (!g.includes("/")) {
    const base = n.split("/").pop();
    if (globToRegExp(g).test(base)) return true;
  }
  return false;
}

// Returns the first matching pattern, or null. Negations ("!x") exclude.
export function matchAny(patterns, path) {
  let hit = null;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pat = negated ? raw.slice(1) : raw;
    if (matchGlob(pat, path)) {
      if (negated) return null;
      hit = hit ?? raw;
    }
  }
  return hit;
}
