export type Tier = "standard" | "member";

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone?: string;
  tier: Tier;
}

export interface CustomerInput {
  id: string;
  name: string;
  email: string;
  phone?: string;
  tier?: Tier;
}

/** Checks a customer record and returns it. A new customer is a standard customer unless said otherwise. */
export function makeCustomer(input: CustomerInput): Customer {
  if (!input.id) throw new Error("customer needs an id");
  if (!input.name.trim()) throw new Error(`customer ${input.id} needs a name`);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw new Error(`customer ${input.id} has a bad email`);
  const customer: Customer = { id: input.id, name: input.name.trim(), email: input.email, tier: input.tier ?? "standard" };
  if (input.phone) customer.phone = input.phone;
  return customer;
}

export function displayName(customer: Customer): string {
  return customer.tier === "member" ? `${customer.name} (member)` : customer.name;
}

export function findCustomer(customers: Customer[], id: string): Customer | undefined {
  return customers.find((customer) => customer.id === id);
}
