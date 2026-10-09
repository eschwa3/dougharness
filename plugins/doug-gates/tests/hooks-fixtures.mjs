export const baseConfig = {
  packageManager: "pnpm",
  protectedPaths: [".env", ".env.*", "pnpm-lock.yaml", "prisma/migrations/**", "dist/**"],
  commands: { test: "node -e \"process.exit(0)\"" },
  // requireEvidence is on by default; these fixtures turn it off so each gate is tested on its own, and the
  // verification-evidence block has its own cases below.
  stopGate: { commands: ["test"], onlyIfEdited: true, maxBlocks: 3, timeoutMs: 10000, requireEvidence: false },
  editLoop: { threshold: 3, windowMinutes: 30 },
  anchor: ["Use pnpm, never npm."],
};
