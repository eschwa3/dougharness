export interface Product {
  sku: string;
  name: string;
  priceCents: number;
  category: string;
}

/** Creates a product. Throws on an empty sku or name, or a price that is not a non-negative whole number of cents. */
export function createProduct(sku: string, name: string, priceCents: number, category: string): Product {
  if (sku.trim().length === 0) throw new Error("sku must not be empty");
  if (name.trim().length === 0) throw new Error("name must not be empty");
  if (!Number.isInteger(priceCents) || priceCents < 0) throw new Error("price must be a non-negative whole number of cents");
  return { sku, name, priceCents, category };
}
