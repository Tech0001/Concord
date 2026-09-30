export type Neighbor = { id: string; title: string };

let order: Neighbor[] = [];

/** Remember the Library's current order so the player can offer previous/next. */
export function setLibraryOrder(items: Neighbor[]): void {
  order = items.map(({ id, title }) => ({ id, title }));
}

export function neighbors(id: string): { previous?: Neighbor; next?: Neighbor } {
  const i = order.findIndex((n) => n.id === id);
  return i < 0 ? {} : { previous: order[i - 1], next: order[i + 1] };
}
