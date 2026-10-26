export type Status = "pending" | "paid" | "shipped" | "cancelled";

const NEXT: Record<Status, Status[]> = {
  pending: ["paid", "cancelled"],
  paid: ["shipped", "cancelled"],
  shipped: [],
  cancelled: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return NEXT[from].includes(to);
}
