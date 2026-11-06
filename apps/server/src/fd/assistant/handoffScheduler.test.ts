import { assert, describe, it } from "@effect/vitest";

import {
  type Candidate,
  fairOrder,
  grant,
  head,
  isStarving,
  STARVATION_LIMIT,
} from "./handoffScheduler.ts";

type Waiting = Candidate<string>;

/** A small deterministic generator, so a failing seed replays exactly. */
const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * A waiting set run the way the tick and the gate run it: positions from one counter, grants only
 * to the head, and every re-entry at a fresh position. For each eligible candidate it tracks the
 * grants made to others while it stayed eligible, and how many candidates waited before it when
 * it entered or last became eligible.
 */
const simulate = (seed: number, steps: number) => {
  const next = random(seed);
  const pick = <A>(items: ReadonlyArray<A>) => items[Math.floor(next() * items.length)];
  let counter = 1;
  let waiting: Array<Waiting> = [];
  const granted: Array<string> = [];
  const watch = new Map<string, { passed: number; before: number }>();
  let names = 0;
  let grants = 0;
  let worst = 0;

  const startWatch = (id: string) => {
    const self = waiting.find((candidate) => candidate.id === id)!;
    watch.set(id, {
      passed: 0,
      before: waiting.filter((candidate) => candidate.seq < self.seq).length,
    });
  };
  const enter = (id: string, priority: number | null) => {
    waiting = waiting.filter((candidate) => candidate.id !== id);
    waiting.push({ id, seq: counter++, overtaken: 0, priority, eligible: true });
    startWatch(id);
  };
  const priority = () => (next() < 0.25 ? null : 1 + Math.floor(next() * 4));

  for (let step = 0; step < steps; step++) {
    const roll = next();
    const ids = waiting.map((candidate) => candidate.id);
    if (roll < 0.25 || waiting.length === 0) {
      // An arrival: a new assignment queued, a wake presented, an effect deferred.
      enter(`c${names++}`, priority());
    } else if (roll < 0.55) {
      const chosen = head(waiting);
      if (chosen === undefined) continue;
      const self = watch.get(chosen.id)!;
      assert.isAtMost(self.passed, STARVATION_LIMIT + self.before, `seed ${seed} ${chosen.id}`);
      worst = Math.max(worst, self.passed - self.before);
      const after = grant(waiting, chosen.id);
      waiting = [...after.waiting];
      grants += 1;
      granted.push(chosen.id);
      watch.delete(chosen.id);
      for (const candidate of waiting) {
        const watched = watch.get(candidate.id);
        if (candidate.eligible && watched !== undefined) watched.passed += 1;
      }
    } else if (roll < 0.68 && granted.length > 0) {
      // Re-entry after a grant: a retry, a resume, a stale redispatch, an expired reservation or
      // a later wake of the same key. It always takes a fresh position.
      const id = pick(granted)!;
      if (!ids.includes(id)) enter(id, priority());
    } else if (roll < 0.76) {
      // Blocked: its Work could not be confirmed.
      const id = pick(ids)!;
      waiting = waiting.map((candidate) =>
        candidate.id === id ? { ...candidate, eligible: false } : candidate,
      );
      watch.delete(id);
    } else if (roll < 0.84) {
      // Unblocked: restored, it enters again at a fresh position.
      const blocked = waiting.filter((candidate) => !candidate.eligible);
      const chosen = pick(blocked);
      if (chosen !== undefined) enter(chosen.id, chosen.priority);
    } else if (roll < 0.9) {
      // Its authorization lapses and returns, keeping its position, as a queued assignment's does.
      const id = pick(ids)!;
      const was = waiting.find((candidate) => candidate.id === id)!;
      waiting = waiting.map((candidate) =>
        candidate.id === id ? { ...candidate, eligible: !candidate.eligible } : candidate,
      );
      if (was.eligible) watch.delete(id);
      else startWatch(id);
    } else {
      // The owner changes a brief's priority while it waits.
      const id = pick(ids)!;
      waiting = waiting.map((candidate) =>
        candidate.id === id ? { ...candidate, priority: priority() } : candidate,
      );
    }
    const positions = waiting.map((candidate) => candidate.seq);
    assert.strictEqual(new Set(positions).size, positions.length, `seed ${seed}: unique`);
    for (const candidate of waiting) {
      const watched = watch.get(candidate.id);
      if (!candidate.eligible || watched === undefined) continue;
      assert.isAtMost(
        watched.passed,
        STARVATION_LIMIT + watched.before,
        `seed ${seed} step ${step}: ${candidate.id} waited past its bound`,
      );
    }
  }
  return { grants, worst };
};

describe("handoffScheduler", () => {
  it("grants every eligible candidate within the starvation limit plus those before it", () => {
    let grants = 0;
    let overtakenHappened = false;
    for (let seed = 1; seed <= 300; seed++) {
      const result = simulate(seed, 400);
      grants += result.grants;
      if (result.worst > 0) overtakenHappened = true;
    }
    assert.isAbove(grants, 10_000);
    // Priority did pass over earlier candidates, so the bound was exercised, not idle.
    assert.isTrue(overtakenHappened);
  });

  it("orders by priority until a candidate starves, then by position", () => {
    const candidates: ReadonlyArray<Waiting> = [
      { id: "unranked", seq: 1, overtaken: 0, priority: null, eligible: true },
      { id: "low", seq: 2, overtaken: 1, priority: 3, eligible: true },
      { id: "high", seq: 3, overtaken: 0, priority: 1, eligible: true },
      { id: "blocked", seq: 4, overtaken: 5, priority: 1, eligible: false },
      { id: "tie", seq: 5, overtaken: 0, priority: 1, eligible: true },
    ];
    assert.deepStrictEqual(
      fairOrder(candidates).map(({ id }) => id),
      ["high", "tie", "low", "unranked"],
    );
    // Granting `high` passes over the two eligible candidates before it, not the blocked one.
    const after = grant(candidates, "high");
    assert.deepStrictEqual(
      after.overtaken.map(({ id, overtaken }) => [id, overtaken]),
      [
        ["unranked", 1],
        ["low", 2],
      ],
    );
    assert.isTrue(isStarving(after.waiting.find(({ id }) => id === "low")!));
    assert.deepStrictEqual(
      fairOrder(after.waiting).map(({ id }) => id),
      ["low", "tie", "unranked"],
    );
    // A second grant passing over `unranked` makes it starve too; starving ones go by position.
    const again = grant(after.waiting, "tie");
    assert.deepStrictEqual(
      fairOrder(again.waiting).map(({ id }) => id),
      ["unranked", "low"],
    );
  });

  // The order of ProjectAssistant.test.ts's priority scenarios, as the fair order sees them.
  it("keeps the existing priority scenarios' order", () => {
    // Four projects queued by rank; two slots take alpha and beta. Delta's rank becomes 1 while
    // they run, so it goes before gamma when a slot frees.
    let waiting: ReadonlyArray<Waiting> = [
      { id: "alpha", seq: 1, overtaken: 0, priority: 1, eligible: true },
      { id: "beta", seq: 2, overtaken: 0, priority: 2, eligible: true },
      { id: "gamma", seq: 3, overtaken: 0, priority: 3, eligible: true },
      { id: "delta", seq: 4, overtaken: 0, priority: 4, eligible: true },
    ];
    const order: Array<string> = [];
    for (let slot = 0; slot < 2; slot++) {
      const chosen = head(waiting)!;
      order.push(chosen.id);
      waiting = grant(waiting, chosen.id).waiting;
    }
    waiting = waiting.map((candidate) =>
      candidate.id === "delta" ? { ...candidate, priority: 1 } : candidate,
    );
    order.push(head(waiting)!.id);
    assert.deepStrictEqual(order, ["alpha", "beta", "delta"]);

    // Three ideas across two projects: onboarding and reporting run; notifications' rank becomes
    // 1 and it is next.
    let ideas: ReadonlyArray<Waiting> = [
      { id: "onboarding", seq: 5, overtaken: 0, priority: 1, eligible: true },
      { id: "reporting", seq: 6, overtaken: 0, priority: 2, eligible: true },
      { id: "notifications", seq: 7, overtaken: 0, priority: 3, eligible: true },
    ];
    const launched: Array<string> = [];
    for (let slot = 0; slot < 2; slot++) {
      const chosen = head(ideas)!;
      launched.push(chosen.id);
      ideas = grant(ideas, chosen.id).waiting;
    }
    ideas = ideas.map((candidate) => ({ ...candidate, priority: 1 }));
    launched.push(head(ideas)!.id);
    assert.deepStrictEqual(launched, ["onboarding", "reporting", "notifications"]);
  });
});
