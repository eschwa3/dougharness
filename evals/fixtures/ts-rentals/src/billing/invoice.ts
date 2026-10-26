import type { Item } from "../catalog/item.js";
import type { Customer } from "../customers/customer.js";
import { memberDiscountCents } from "../pricing/discounts.js";
import { billableDays, rentalCostCents } from "../pricing/rates.js";
import type { Reservation } from "../reservations/reservation.js";
import { sumCents } from "../util/money.js";
import type { Cents } from "../util/money.js";
import { pluralise } from "../util/text.js";
import { DEFAULT_TAX_BP, taxCents } from "./tax.js";

export interface InvoiceLine {
  label: string;
  cents: Cents;
}

export interface Invoice {
  id: string;
  reservationId: string;
  lines: InvoiceLine[];
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
}

export interface InvoiceOptions {
  customer?: Customer;
  taxBp?: number;
  /** A late fee already worked out for the return, added as its own line. */
  lateFeeCents?: Cents;
}

/** The charge lines for a reservation: the rental, any member discount, any late fee. */
export function invoiceLines(reservation: Reservation, item: Item, options: InvoiceOptions = {}): InvoiceLine[] {
  const days = billableDays(reservation.start, reservation.end);
  const rental = rentalCostCents(item, days);
  const lines: InvoiceLine[] = [{ label: `${item.name}, ${pluralise(days, "day")}`, cents: rental }];
  const discount = memberDiscountCents(options.customer, rental);
  if (discount > 0) lines.push({ label: "Member discount", cents: -discount });
  if (options.lateFeeCents && options.lateFeeCents > 0) lines.push({ label: "Late fee", cents: options.lateFeeCents });
  return lines;
}

export function buildInvoice(id: string, reservation: Reservation, item: Item, options: InvoiceOptions = {}): Invoice {
  const lines = invoiceLines(reservation, item, options);
  const subtotalCents = sumCents(lines.map((line) => line.cents));
  const tax = taxCents(subtotalCents, options.taxBp ?? DEFAULT_TAX_BP);
  return { id, reservationId: reservation.id, lines, subtotalCents, taxCents: tax, totalCents: subtotalCents + tax };
}
