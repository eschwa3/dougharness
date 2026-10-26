import type { Item } from "../catalog/item.js";
import type { Customer } from "../customers/customer.js";
import type { Reservation } from "../reservations/reservation.js";
import { fill } from "../util/text.js";

export const TEMPLATES = {
  confirmation: "Hello {name}, your rental of {item} from {start} to {end} is confirmed.",
  pickup: "Hello {name}, your {item} is ready for pickup tomorrow, {start}.",
  thanks: "Thank you {name} for renting the {item}.",
} as const;

export type TemplateName = keyof typeof TEMPLATES;

export function render(name: TemplateName, customer: Customer, reservation: Reservation, item: Item): string {
  return fill(TEMPLATES[name], {
    name: customer.name,
    item: item.name,
    start: reservation.start,
    end: reservation.end,
  });
}

export function subjectFor(name: TemplateName): string {
  switch (name) {
    case "confirmation":
      return "Your rental is confirmed";
    case "pickup":
      return "Pickup tomorrow";
    case "thanks":
      return "Thank you";
  }
}
