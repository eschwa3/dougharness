import type { Product } from "./product.js";

export type Catalog = Product[];

/** Returns a new catalog with the product added. Throws when the sku is already listed. */
export function addProduct(catalog: Catalog, product: Product): Catalog {
  if (catalog.some((p) => p.sku === product.sku)) throw new Error(`duplicate sku: ${product.sku}`);
  return [...catalog, product];
}

export function findProduct(catalog: Catalog, sku: string): Product | undefined {
  return catalog.find((p) => p.sku === sku);
}

/** Products whose name contains the query, in catalog order. */
export function searchProducts(catalog: Catalog, query: string): Product[] {
  return catalog.filter((p) => p.name.includes(query));
}
