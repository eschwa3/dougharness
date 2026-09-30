// Ambient types for the board library in the doug-flow plugin (plain ESM, no shipped types).
// Keep in step with plugins/doug-flow/lib/board.mjs and docs/board.md.

declare module "@dougharness/flow/lib/board.mjs" {
  export interface BoardColumn {
    id: string;
    title: string;
    hint?: string;
  }

  export interface BoardCard {
    id: string;
    column: string;
    component?: string;
    title: string;
    size?: string;
    track?: "flow" | "hand";
    class?: string;
    deps?: string[];
    goal: string;
    source?: string;
    tags?: string[];
  }

  export interface Board {
    version: number;
    updated?: string;
    columns: BoardColumn[];
    components: string[];
    tags?: string[];
    cards: BoardCard[];
  }

  export interface NewCard {
    id: string;
    title: string;
    goal: string;
    component?: string;
    size?: string;
    track?: string;
    class?: string;
    deps?: string[];
    column?: string;
    tags?: string[];
  }

  export interface RunReport {
    plan?: string;
    integrationBranch?: string;
    modelsSource?: string;
    ok?: boolean;
    stoppedAtLevel?: number;
    levels?: unknown[];
    [key: string]: unknown;
  }

  export const BOARD_RELPATH: string;
  export const FALLBACK_RELPATH: string;
  export const RESEARCH_NOTE_DIR: string;
  export const RESEARCH_DOCS_DIR: string;
  export const DEFAULT_COLUMNS: BoardColumn[];
  export const DEFAULT_TAGS: string[];
  export function boardTags(board: Board): string[];
  export function promoteResearchNote(dir: string, id: string): string | null;

  export function boardPath(dir: string): string;
  export function loadBoard(dir: string): Board;
  export function saveBoard(dir: string, board: Board): void;
  export function findCard(board: Board, id: string): BoardCard;
  export type SkippedCard = { id: string; waitingOn: string[] } | { id: string; hand: true } | { id: string; flow: true };
  export function nextReadyCard(board: Board, opts?: { track?: "flow" | "hand"; tag?: string }): { card: BoardCard | null; skipped: SkippedCard[] };
  export function nextReadyCards(board: Board, opts: { track?: "flow" | "hand"; batch: number; tag?: string }): { cards: BoardCard[]; skipped: SkippedCard[] };
  export function filterReportForCard(report: RunReport, cardId: string, taskIds?: string[]): RunReport;
  export function moveCard(board: Board, id: string, column: string, opts?: { source?: string; date?: string }): Board;
  export interface EditFields {
    title?: string;
    goal?: string;
    size?: string;
    component?: string;
    track?: string;
    class?: string;
    deps?: string[];
    source?: string;
    tags?: string[];
  }
  export function editCard(
    board: Board,
    id: string,
    fields: EditFields,
    opts?: { force?: boolean; date?: string; plan?: import("@dougharness/flow/lib/plan.mjs").Plan | null },
  ): { board: Board; warnings: string[] };
  export function removeCard(
    board: Board,
    id: string,
    opts?: { force?: boolean; date?: string; plan?: import("@dougharness/flow/lib/plan.mjs").Plan | null },
  ): { board: Board; removed: BoardCard; warnings: string[] };
  export type Placement = { before: string } | { after: string } | { index: number };
  export function reorderCard(board: Board, id: string, placement: Placement, opts?: { date?: string }): Board;
  export function newBoard(opts?: { date?: string }): Board;
  export function addCard(board: Board, card: NewCard, opts?: { date?: string }): Board;
  export function validateBoard(board: unknown): string[];
  export interface AdversaryClass {
    id: string;
    class: "real" | "marginal" | "false";
    reason: string | null;
  }
  export interface AdversaryBlock {
    task: string;
    id: string;
    pass: number | null;
    status: string | null;
    description: string;
  }
  export const ADVERSARY_CLASSES: string[];
  export function adversaryBlocks(report: RunReport): AdversaryBlock[];
  export function blockKey(block: AdversaryBlock, blocks: AdversaryBlock[]): string;
  export function parseAdversaryClasses(values: string | string[]): AdversaryClass[];
  export function classifyBlocks(report: RunReport, classes?: AdversaryClass[]): (AdversaryBlock & { key: string; class: string | null; reason: string | null })[];
  export function precisionLine(blocks: { class: string | null }[]): string;
  export function runEntry(args: {
    card: BoardCard;
    report: RunReport;
    cost?: number | null;
    codexCost?: number | null;
    wallClock?: string | null;
    mergeCommit?: string | null;
    record?: string | null;
    adversary?: AdversaryClass[];
    date?: string;
    batch?: string[] | null;
    sharedCost?: number | null;
    taskIds?: string[];
    note?: string | null;
    rehearsal?: string | null;
  }): string;
  export function handEntry(args: {
    card: BoardCard;
    commit?: string | null;
    wallClock?: string | null;
    gate?: string | null;
    note?: string | null;
    record?: string | null;
    date?: string;
    rehearsal?: string | null;
  }): string;
  export function runSummary(args: { report: RunReport; cost?: number | null; codexCost?: number | null; wallClock?: string | null; mergeCommit?: string | null }): string;
  export function appendRun(dir: string, markdown: string): string;
  export function recordLanding(dir: string, id: string, markdown: string): { file: string; promoted: string | null };
}

declare module "@dougharness/flow/lib/cost.mjs" {
  export function projectSlug(projectDir: string): string;
}

declare module "@dougharness/flow/lib/plan.mjs" {
  export interface PlanTask {
    id: string;
    card?: string;
    [key: string]: unknown;
  }
  export interface Plan {
    cards?: string[];
    tasks: PlanTask[];
    [key: string]: unknown;
  }
  export function loadPlan(dir: string, relpath?: string): Plan | null;
  export function unwrapReport<T = unknown>(obj: T): T;
}
