export type Status = "requested" | "confirmed" | "picked-up" | "returned" | "cancelled";

const TRANSITIONS: Record<Status, Status[]> = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["picked-up", "cancelled"],
  "picked-up": ["returned"],
  returned: [],
  cancelled: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Returns the new status, or throws when the move is not allowed. */
export function advance(from: Status, to: Status): Status {
  if (!canTransition(from, to)) throw new Error(`cannot move a reservation from ${from} to ${to}`);
  return to;
}

/** A reservation in a final status never changes again. */
export function isFinal(status: Status): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Statuses that hold the item for their dates. */
export function holdsItem(status: Status): boolean {
  return status === "requested" || status === "confirmed" || status === "picked-up";
}
