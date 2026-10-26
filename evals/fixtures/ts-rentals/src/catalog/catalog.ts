import { makeItem } from "./item.js";
import type { Category, Item } from "./item.js";

export const SEED_ITEMS: Item[] = [
  { id: "itm-0001", name: "Cordless drill", category: "tool", dayRateCents: 1500, weekRateCents: 7500, depositCents: 5000 },
  { id: "itm-0002", name: "Tile saw", category: "tool", dayRateCents: 4000, weekRateCents: 20000, depositCents: 15000 },
  { id: "itm-0003", name: "Mirrorless camera", category: "camera", dayRateCents: 6000, weekRateCents: 30000, depositCents: 40000 },
  { id: "itm-0004", name: "PA speaker pair", category: "audio", dayRateCents: 5000, weekRateCents: 25000, depositCents: 20000 },
  { id: "itm-0005", name: "Two person tent", category: "outdoor", dayRateCents: 2000, weekRateCents: 10000, depositCents: 6000 },
];

export type Catalog = Item[];

export function seedCatalog(): Catalog {
  return SEED_ITEMS.map((item) => makeItem(item));
}

export function findItem(catalog: Catalog, id: string): Item | undefined {
  return catalog.find((item) => item.id === id);
}

/** Adds an item. A second item with the same id is refused. */
export function addItem(catalog: Catalog, item: Item): Catalog {
  const checked = makeItem(item);
  if (findItem(catalog, checked.id)) throw new Error(`duplicate item ${checked.id}`);
  return [...catalog, checked];
}

export function itemsInCategory(catalog: Catalog, category: Category): Item[] {
  return catalog.filter((item) => item.category === category);
}

/** The item with the lowest day rate, or undefined for an empty catalog. */
export function cheapestPerDay(catalog: Catalog): Item | undefined {
  return [...catalog].sort((a, b) => a.dayRateCents - b.dayRateCents)[0];
}

/** One line per item: id, name and category. */
export function listLines(catalog: Catalog): string[] {
  return catalog.map((item) => `${item.id} ${item.name} (${item.category})`);
}
