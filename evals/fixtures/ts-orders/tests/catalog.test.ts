import { describe, it, expect } from "vitest";
import { createProduct } from "../src/catalog/product.js";
import { addProduct, findProduct, searchProducts } from "../src/catalog/catalog.js";

const widget = createProduct("W-1", "widget", 250, "parts");
const gadget = createProduct("G-1", "gadget", 1999, "tools");

describe("catalog", () => {
  it("rejects a bad product", () => {
    expect(() => createProduct("", "x", 1, "c")).toThrow();
    expect(() => createProduct("S", " ", 1, "c")).toThrow();
    expect(() => createProduct("S", "x", 1.5, "c")).toThrow();
  });
  it("adds, finds and refuses duplicates", () => {
    const catalog = addProduct(addProduct([], widget), gadget);
    expect(findProduct(catalog, "G-1")).toEqual(gadget);
    expect(findProduct(catalog, "nope")).toBeUndefined();
    expect(() => addProduct(catalog, widget)).toThrow();
  });
  it("searches names in catalog order", () => {
    const catalog = [widget, gadget];
    expect(searchProducts(catalog, "get")).toEqual([widget, gadget]);
    expect(searchProducts(catalog, "wid")).toEqual([widget]);
    expect(searchProducts(catalog, "zzz")).toEqual([]);
  });
});
