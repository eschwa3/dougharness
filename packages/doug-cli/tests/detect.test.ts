import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readdirSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Lets one test drive `listDir` with a directory listing that is deliberately out of
// order, so the sort in fs.ts can be observed to fail without relying on the local
// filesystem returning readdirSync entries unsorted (macOS APFS normally does not).
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (...args: unknown[]) => {
      if (String(args[0]).endsWith("__unsorted__")) return ["zz-last.yml", "aa-first.yml", "mm-mid.yml"];
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { detect } from "../src/detect/index.js";
import { listDir } from "../src/detect/fs.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => join(here, "fixtures", name);

describe("detect: ts-pnpm fixture", () => {
  const d = detect(fx("ts-pnpm"));
  it("finds the package manager from the packageManager field", () => {
    expect(d.node.packageManager).toBe("pnpm");
    expect(d.node.packageManagerSource).toBe("packageManager-field");
    expect(d.node.lockfile).toBe("pnpm-lock.yaml");
  });
  it("maps scripts to commands", () => {
    expect(d.node.commands.test?.command).toBe("pnpm test");
    expect(d.node.commands.lint?.command).toBe("pnpm lint");
    expect(d.node.commands.typecheck?.command).toBe("pnpm typecheck");
    expect(d.node.commands.build?.command).toBe("pnpm build");
    expect(d.node.commands.install).toBe("pnpm install --frozen-lockfile");
  });
  it("detects formatter, linter, tests and typescript", () => {
    expect(d.node.formatter?.name).toBe("prettier");
    expect(d.node.formatter?.command).toEqual(["pnpm", "exec", "prettier", "--write"]);
    expect(d.node.linter).toBe("eslint");
    expect(d.node.testFramework).toBe("vitest");
    expect(d.node.singleTestCommand).toContain("vitest run");
    expect(d.node.typescript).toBe(true);
    expect(d.node.tsStrict).toBe(true);
    expect(d.node.nodeVersion).toBe(">=20");
  });
  it("detects repo conventions and protected paths", () => {
    expect(d.repo.ci).toEqual([".github/workflows/ci.yml"]);
    expect(d.repo.gitHooks).toContain("husky");
    expect(d.repo.envFiles.sort()).toEqual([".env", ".env.local"]);
    expect(d.repo.migrationDirs).toEqual(["prisma/migrations"]);
    expect(d.repo.generatedDirs).toContain("dist");
    expect(d.repo.readmeHasSetup).toBe(true);
    expect(d.repo.hasClaudeMd).toBe(false);
  });
});

describe("detect: npm-bare fixture", () => {
  const d = detect(fx("npm-bare"));
  it("falls back to npm from the lockfile and node:test from the script", () => {
    expect(d.node.packageManager).toBe("npm");
    expect(d.node.packageManagerSource).toBe("lockfile");
    expect(d.node.testFramework).toBe("node:test");
    expect(d.node.commands.test?.command).toBe("npm test");
    expect(d.node.formatter).toBeNull();
    expect(d.node.linter).toBeNull();
    expect(d.node.typescript).toBe(false);
  });
});

describe("detect: ci-order fixture", () => {
  it("sorts CI workflow files, independent of the order readdirSync returns them", () => {
    const dir = fx("ci-order");
    const raw = readdirSync(join(dir, ".github/workflows"));
    const d = detect(dir);
    // This test is vacuous on any filesystem that already returns entries sorted,
    // macOS APFS included: readdirSync came back sorted here even with the files
    // created in reverse order, so this assertion passes whether or not detectRepo
    // sorts. It may still fire on a filesystem that returns hash order, e.g. ext4
    // with dir_index. The listDir test below is the one that actually proves the
    // sort: it mocks readdirSync to return unsorted entries and cannot pass by
    // accident. This test's job is acceptance item 3 — real coverage of the
    // detect -> detectRepo -> repo.ci path with more than one workflow file.
    expect(d.repo.ci).toEqual([...raw].sort().map((f) => `.github/workflows/${f}`));
    expect(d.repo.ci).toEqual([
      ".github/workflows/aa-build.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/zz-tmp.yml",
    ]);
  });
});

describe("detect/fs: listDir", () => {
  it("sorts entries even when readdirSync itself returns them out of order", () => {
    // A directory read that genuinely comes back unsorted (mocked above, since this
    // filesystem always hands back sorted entries): listDir must still sort it.
    expect(listDir("/anything/__unsorted__")).toEqual(["aa-first.yml", "mm-mid.yml", "zz-last.yml"]);
  });
});

describe("detect: empty dir", () => {
  it("reports nothing present without throwing", () => {
    const d = detect(fx("does-not-exist"));
    expect(d.node.present).toBe(false);
    expect(d.repo.ci).toEqual([]);
    expect(d.repo.infraPaths).toEqual([]);
  });
});

// card bash-rules-prod, T5: RepoDetection.infraPaths, filled by detectRepo, so doug init can propose the
// infra/prod/**, *.tfvars, and terraform.tfstate protected paths when they exist. Built with mkdtempSync
// fixtures (not the checked-in fixtures directory, which other tests pin) since these files must not exist in
// the repo-checked-in fixtures.
//
// Reviewer correction: plugins/doug-gates/lib/glob.mjs gives a slash-free pattern basename semantics, so
// `*.tfvars` and `terraform.tfstate` already match at any depth and a `**/`-prefixed form is dead weight.
// The detector emits only the card's three flat patterns, regardless of how deep a match was found.
describe("detect: infraPaths (card bash-rules-prod, T5)", () => {
  function tempRepoWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "doug-infra-"));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  }

  it("collects exactly the three flat patterns, in order and without duplicates, root and nested markers alike", () => {
    const dir = tempRepoWith({
      "infra/prod/main.tf": "x",
      "prod.tfvars": "x",
      "envs/staging/staging.tfvars": "x",
      "envs/staging/terraform.tfstate": "x",
    });
    expect(detect(dir).repo.infraPaths).toEqual(["infra/prod/**", "*.tfvars", "terraform.tfstate"]);
  });

  it("is empty when none of the infra markers are present", () => {
    const dir = tempRepoWith({ "src/index.ts": "x" });
    expect(detect(dir).repo.infraPaths).toEqual([]);
  });

  it("skips a .tfvars file under node_modules", () => {
    const dir = tempRepoWith({ "node_modules/x/y.tfvars": "x" });
    expect(detect(dir).repo.infraPaths).toEqual([]);
  });

  // Reviewer r4: the skip list must apply at every level the walk visits, not only the root. The first version
  // of this pin nested node_modules at depth 4, past the walk's own three-level depth limit, so it was vacuous
  // (it would pass even with no skip logic at all, on the depth limit alone). Depth 2 and depth 3 place the
  // marker file within a level the walk does visit, so the skip is the only thing keeping it out.
  it("skips a .tfvars file under a nested node_modules, at depth 2 and depth 3 (r4)", () => {
    const depth2 = tempRepoWith({ "packages/app/node_modules/y.tfvars": "x" });
    expect(detect(depth2).repo.infraPaths).toEqual([]);
    const depth3 = tempRepoWith({ "packages/node_modules/y.tfvars": "x" });
    expect(detect(depth3).repo.infraPaths).toEqual([]);
  });

  it("respects the three-directory-level depth limit for the walk", () => {
    const deep = tempRepoWith({ "a/b/c/d/x.tfvars": "x" }); // 4 directory levels deep: too deep
    expect(detect(deep).repo.infraPaths).toEqual([]);
    const shallow = tempRepoWith({ "a/b/c/x.tfvars": "x" }); // 3 directory levels deep: within the limit
    expect(detect(shallow).repo.infraPaths).toEqual(["*.tfvars"]);
  });

  it("a nested terraform.tfstate alone gives the flat pattern, not a **/-prefixed one", () => {
    const dir = tempRepoWith({ "envs/terraform.tfstate": "x" });
    expect(detect(dir).repo.infraPaths).toEqual(["terraform.tfstate"]);
  });
});
