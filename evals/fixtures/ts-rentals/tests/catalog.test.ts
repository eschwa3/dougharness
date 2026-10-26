import { describe, it, expect } from "vitest";
import { addItem, cheapestPerDay, findItem, itemsInCategory, listLines, seedCatalog } from "../src/catalog/catalog.js";
import { makeItem } from "../src/catalog/item.js";
import type { Item } from "../src/catalog/item.js";

const lamp: Item = { id: "itm-0100", name: " Work lamp ", category: "tool", dayRateCents: 500, weekRateCents: 2500, depositCents: 1000 };

describe("makeItem", () => {
  it("trims the name and keeps the rest", () => {
    expect(makeItem(lamp)).toEqual({ ...lamp, name: "Work lamp" });
  });
  it("refuses a blank name, an unknown category and fractional cents", () => {
    expect(() => makeItem({ ...lamp, name: "  " })).toThrow("needs a name");
    expect(() => makeItem({ ...lamp, category: "boat" as Item["category"] })).toThrow("unknown category");
    expect(() => makeItem({ ...lamp, dayRateCents: 5.5 })).toThrow("whole cents");
    expect(() => makeItem({ ...lamp, depositCents: -1 })).toThrow("whole cents");
  });
  it("refuses a missing id", () => {
    expect(() => makeItem({ ...lamp, id: "" })).toThrow("needs an id");
  });
});

describe("catalog", () => {
  it("seeds five items that all pass validation", () => {
    const catalog = seedCatalog();
    expect(catalog).toHaveLength(5);
    expect(new Set(catalog.map((item) => item.id)).size).toBe(5);
  });
  it("finds an item by id", () => {
    expect(findItem(seedCatalog(), "itm-0003")?.name).toBe("Mirrorless camera");
    expect(findItem(seedCatalog(), "itm-9999")).toBeUndefined();
  });
  it("adds an item and refuses a duplicate id", () => {
    const grown = addItem(seedCatalog(), lamp);
    expect(grown).toHaveLength(6);
    expect(findItem(grown, "itm-0100")?.name).toBe("Work lamp");
    expect(() => addItem(grown, lamp)).toThrow("duplicate item");
  });
  it("filters by category", () => {
    expect(itemsInCategory(seedCatalog(), "tool").map((item) => item.id)).toEqual(["itm-0001", "itm-0002"]);
    expect(itemsInCategory(seedCatalog(), "audio")).toHaveLength(1);
  });
  it("finds the cheapest item per day", () => {
    expect(cheapestPerDay(seedCatalog())?.id).toBe("itm-0001");
    expect(cheapestPerDay([])).toBeUndefined();
  });
  it("lists one line per item", () => {
    expect(listLines(seedCatalog())[0]).toBe("itm-0001 Cordless drill (tool)");
    expect(listLines([])).toEqual([]);
  });
});

describe("more catalog", () => {
  it("keeps the seed items in id order", () => {
    const ids = seedCatalog().map((item) => item.id);
    expect(ids).toEqual([...ids].sort());
  });
  it("gives every seed item a week rate below seven day rates", () => {
    for (const item of seedCatalog()) expect(item.weekRateCents).toBeLessThan(item.dayRateCents * 7);
  });
  it("gives every seed item a deposit", () => {
    for (const item of seedCatalog()) expect(item.depositCents).toBeGreaterThan(0);
  });
  it("does not change the catalog it adds to", () => {
    const before = seedCatalog();
    addItem(before, lamp);
    expect(before).toHaveLength(5);
  });
  it("finds no items in a category nobody stocks", () => {
    expect(itemsInCategory([], "camera")).toEqual([]);
  });
  it("lists an added item last", () => {
    const grown = addItem(seedCatalog(), lamp);
    expect(listLines(grown).at(-1)).toBe("itm-0100 Work lamp (tool)");
  });
});
