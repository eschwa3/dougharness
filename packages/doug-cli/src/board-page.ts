// Renders the board page from the board record. The page's own source is templates/board-app.js;
// a move is written by `doug board serve`.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { LIVE_RUNS_RELPATH, boardPath, loadBoard, rollup, type Board, type Rollup } from "@dougharness/flow/lib/board.mjs";

export type BoardPageMode = "local";

export interface BoardPageConfig {
  mode: BoardPageMode;
  record: string;
}

type RenderDoc = (board: Board, appSource: string, config: BoardPageConfig, rollup: Rollup) => string;

// The template is a classic script: it is embedded in the page verbatim and evaluated here for its
// renderDoc. A literal closing script tag in it would cut the page's own <script id="app"> short.
function templateSource(): string {
  const source = readFileSync(new URL("../templates/board-app.js", import.meta.url), "utf8");
  if (source.includes("</script>")) {
    throw new Error("the board page template contains a literal </script>; write it as <\\/script>");
  }
  return source;
}

// The text of docs/live-runs.md, or null when it is absent or unreadable. Never throws.
export function liveRunsText(dir: string): string | null {
  try {
    const file = join(dir, LIVE_RUNS_RELPATH);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

export function boardRollup(dir: string, board: Board): Rollup {
  return rollup(board, liveRunsText(dir));
}

export function renderBoardPage(board: Board, opts: { mode: BoardPageMode; record: string; rollup?: Rollup }): string {
  const source = templateSource();
  const renderDoc = new Function(source + "\nreturn renderDoc;")() as RenderDoc;
  const appSource = source + "\napp();\n";
  return renderDoc(board, appSource, { mode: opts.mode, record: opts.record }, opts.rollup ?? rollup(board, null));
}

// The complete document: what `doug board serve` and `doug board build` both send.
export function buildBoardPage(dir: string): { html: string; board: Board; record: string; rollup: Rollup } {
  const board = loadBoard(dir);
  const record = relative(dir, boardPath(dir));
  const roll = boardRollup(dir, board);
  return { html: renderBoardPage(board, { mode: "local", record, rollup: roll }), board, record, rollup: roll };
}
