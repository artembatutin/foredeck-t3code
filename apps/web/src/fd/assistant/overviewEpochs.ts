/** The Factory and Work change epochs an environment last answered; null until one arrives. */
export interface OverviewEpochs {
  readonly factory: number | null;
  readonly work: number | null;
}

/**
 * Whether an overview read is owed: an epoch moved from one it had already answered. A first
 * answer only reports where the stream stands, which the panel's own first read already covers.
 */
export const epochsMoved = (previous: OverviewEpochs, next: OverviewEpochs): boolean =>
  (previous.factory !== null && next.factory !== null && previous.factory !== next.factory) ||
  (previous.work !== null && next.work !== null && previous.work !== next.work);
