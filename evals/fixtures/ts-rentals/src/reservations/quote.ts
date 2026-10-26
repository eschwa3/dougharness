import type { Item } from "../catalog/item.js";
import type { Customer } from "../customers/customer.js";
import { memberDiscountCents } from "../pricing/discounts.js";
import { billableDays, rentalCostCents } from "../pricing/rates.js";
import type { Day } from "../util/dates.js";
import { pluralise } from "../util/text.js";
import type { Cents } from "../util/money.js";

export interface QuoteLine {
  label: string;
  cents: Cents;
}

export interface Quote {
  itemId: string;
  days: number;
  lines: QuoteLine[];
  subtotalCents: Cents;
  discountCents: Cents;
  totalCents: Cents;
  depositCents: Cents;
}

/** Prices a rental of one item. The deposit is held on top of the total. */
export function quoteFor(item: Item, start: Day, end: Day, customer?: Customer): Quote {
  const days = billableDays(start, end);
  const subtotalCents = rentalCostCents(item, days);
  const discountCents = memberDiscountCents(customer, subtotalCents);
  const lines: QuoteLine[] = [{ label: `${item.name}, ${pluralise(days, "day")}`, cents: subtotalCents }];
  if (discountCents > 0) lines.push({ label: "Member discount", cents: -discountCents });
  return {
    itemId: item.id,
    days,
    lines,
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
    depositCents: item.depositCents,
  };
}
