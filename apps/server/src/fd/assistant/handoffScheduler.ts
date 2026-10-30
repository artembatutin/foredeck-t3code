/**
 * The fair order every project assistant grant follows, shared by the tick, which claims queued
 * assignments and grants waiting demands, and the automatic turn gate, which admits a turn at once
 * only when it is the one the next grant would go to. Pure: the caller reads the candidates and
 * writes back what a grant changed.
 *
 * Each candidate takes a unique position (`seq`) when it enters the waiting set, from one counter,
 * and a fresh one whenever it enters again: a retry, a resume, a redispatch found stale, an expired
 * reservation, a new wake or an unblocked demand. Priority decides, but every grant that passes
 * over an eligible candidate waiting since before the granted one counts against it, and once
 * `STARVATION_LIMIT` grants have passed it, it goes before every candidate that is not starving.
 * So an eligible candidate is granted within `STARVATION_LIMIT` plus the number waiting before it
 * of the grants made while it is eligible.
 */

/** How many assignments' families may hold a project assistant slot at once. */
export const CAPACITY = 2;

/** How many grants may pass over a waiting candidate before it goes first. */
export const STARVATION_LIMIT = 2;

export interface Candidate<Id> {
  readonly id: Id;
  /** Its unique position, taken when it last entered the waiting set. */
  readonly seq: number;
  /** How many grants passed over it while it was eligible. */
  readonly overtaken: number;
  /** Its brief's rank: lower goes first, and an unranked candidate after every ranked one. */
  readonly priority: number | null;
  /** Waiting, not blocked, and authorized as it stands. Only eligible candidates are granted. */
  readonly eligible: boolean;
}

export const isStarving = (candidate: Candidate<unknown>) =>
  candidate.overtaken >= STARVATION_LIMIT;

const rank = (candidate: Candidate<unknown>) => candidate.priority ?? Number.POSITIVE_INFINITY;

const compare = (left: Candidate<unknown>, right: Candidate<unknown>) => {
  const starving = Number(isStarving(right)) - Number(isStarving(left));
  if (starving !== 0) return starving;
  if (isStarving(left)) return left.seq - right.seq;
  return rank(left) - rank(right) || left.seq - right.seq;
};

/**
 * The eligible candidates in the order they are granted: starving ones first by position, then by
 * priority, unranked last, and position.
 */
export const fairOrder = <C extends Candidate<unknown>>(
  candidates: ReadonlyArray<C>,
): ReadonlyArray<C> => candidates.filter((candidate) => candidate.eligible).toSorted(compare);

/** The candidate the next grant goes to, if any is eligible. */
export const head = <C extends Candidate<unknown>>(candidates: ReadonlyArray<C>): C | undefined =>
  fairOrder(candidates)[0];

/**
 * What granting `granted` does to the rest: each eligible candidate waiting since before it
 * (a smaller position) is passed over once more. Returns the candidates left waiting, with their
 * counts, and those whose count rose, for the caller to store.
 */
export const grant = <Id, C extends Candidate<Id>>(
  candidates: ReadonlyArray<C>,
  granted: Id,
): { readonly waiting: ReadonlyArray<C>; readonly overtaken: ReadonlyArray<C> } => {
  const target = candidates.find((candidate) => candidate.id === granted);
  const overtaken: Array<C> = [];
  const waiting = candidates.flatMap((candidate) => {
    if (candidate.id === granted) return [];
    if (target === undefined || !candidate.eligible || candidate.seq >= target.seq) {
      return [candidate];
    }
    const passed = { ...candidate, overtaken: candidate.overtaken + 1 };
    overtaken.push(passed);
    return [passed];
  });
  return { waiting, overtaken };
};
