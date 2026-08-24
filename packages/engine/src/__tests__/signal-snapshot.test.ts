/**
 * Unit tests for the public signal-snapshot API (`SignalBook.snapshotAt` /
 * `signalSnapshotAt`): deterministic projection of the internal phase/timing
 * law onto a wire-ready record — phase boundaries, offset alignment, runtime
 * overrides, and failure states must all be observable without re-implementing
 * any engine arithmetic.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DARK_DWELL_S,
  SIGNAL_SNAPSHOT_TICK_HZ,
  SignalBook,
  signalSnapshotAt,
  type SignalProgram,
} from '../index.js';

const DT_S = 0.02; // 50 Hz engine step
const HZ = 1 / DT_S;

/** Looping three-phase program: green 5 s, yellow 2 s, red 10 s (cycle 17 s),
 * offset +3 s against a 2 s warm-up → in-cycle position is `(t + 5) mod 17`.
 * Green spans t ∈ [-5,0)+17ℤ, yellow [0,2)+17ℤ, red [2,12)+17ℤ. */
function mainProgram(overrides: Partial<SignalProgram> = {}): SignalProgram {
  return {
    id: 'sig:main',
    phases: [
      { phase: 'green', durationS: 5 },
      { phase: 'yellow', durationS: 2 },
      { phase: 'red', durationS: 10 },
    ],
    offsetS: 3,
    loop: true,
    stopLines: [{ rsl: '10:-1', s: 4, connectingLaneRsls: ['11:0:-1'] }],
    mapBinding: {
      junctionId: 'J1',
      controllerIds: ['ctrl:A'],
      headIds: ['h2', 'h1'],
      timingSource: 'authored',
    },
    ...overrides,
  } as SignalProgram;
}

function bookWith(programs: SignalProgram[], warmupSeconds = 2): SignalBook {
  return new SignalBook(programs, warmupSeconds);
}

describe('SignalBook.snapshotAt — program phase & boundaries', () => {
  const book = bookWith([mainProgram()]);

  it('reports identity bindings from the map binding', () => {
    const snap = book.snapshotAt('sig:main', 0)!;
    expect(snap.signalId).toBe('sig:main');
    expect(snap.headIds).toEqual(['h1', 'h2']); // sorted, order-independent of authoring
    expect(snap.controllerId).toBe('ctrl:A');
    expect(snap.junctionId).toBe('J1');
    expect(snap.timingSource).toBe('authored');
    expect(snap.source).toBe('program');
    expect(snap.cycleLengthTicks).toBe(17 * HZ);
  });

  it('is exact mid-phase', () => {
    // t=1 → in-cycle 6 → yellow (cycle seconds [5,7), absolute [0,2)).
    const snap = book.snapshotAt('sig:main', 1)!;
    expect(snap.phase).toBe('yellow');
    expect(snap.phaseStartTick).toBe(0);
    expect(snap.phaseEndTick).toBe(Math.round(2 * HZ));
    expect(snap.remainingTicks).toBe(Math.round(1 * HZ));
    expect(snap.nextPhase).toBe('red');
  });

  it('places the boundary instant in the incoming phase with a full remaining budget', () => {
    // Yellow→red boundary lands at t=2 (in-cycle 7); the boundary tick itself
    // reads red, and red's own end (t=12) is still a full 10 s away.
    const snap = book.snapshotAt('sig:main', 2)!;
    expect(book.stateAt('sig:main', 2)!.phase).toBe('red'); // consistency with the internal law
    expect(snap.phase).toBe('red');
    expect(snap.remainingTicks).toBe(Math.round(10 * HZ));
    expect(snap.phaseEndTick).toBe(snap.phaseStartTick! + Math.round(10 * HZ));
  });

  it('keeps snapshots consistent with phaseAt everywhere on the cycle', () => {
    for (let t = -20; t <= 40; t += 0.13) {
      const snap = book.snapshotAt('sig:main', t)!;
      expect(snap.phase).toBe(book.phaseAt('sig:main', t));
      if (snap.phaseEndTick !== null && snap.remainingTicks !== null) {
        // Remaining is published in the same rounded tick space as the boundaries.
        expect(snap.remainingTicks).toBe(snap.phaseEndTick - Math.round(t * HZ));
        expect(snap.remainingTicks).toBeGreaterThan(0);
        expect(snap.remainingTicks).toBeLessThanOrEqual(Math.round(17 * HZ));
      }
    }
  });

  it('derives tick fields from the caller-supplied step, not a hard-coded rate', () => {
    const snap = book.snapshotAt('sig:main', 1, 0.01)!;
    expect(snap.remainingTicks).toBe(Math.round(1 * 100));
    expect(snap.cycleLengthTicks).toBe(1700);
  });

  it('defaults to the shared engine tick rate constant', () => {
    expect(SIGNAL_SNAPSHOT_TICK_HZ).toBe(50);
    expect(book.snapshotAt('sig:main', 1)!.remainingTicks).toBe(50);
  });
});

describe('SignalBook.snapshotAt — offset alignment', () => {
  it('shifts the whole timeline by offsetS against the warm-up origin', () => {
    const offset = bookWith([mainProgram({ offsetS: 0 })], 2);
    const shifted = bookWith([mainProgram({ offsetS: 3 })], 2);
    // Removing the 3 s offset is equivalent to sampling the shifted program
    // 3 s later: same phase, same remaining budget; because +offsetS runs the
    // program ahead, the shifted program's boundaries sit exactly 3 s earlier
    // in absolute time.
    const a = offset.snapshotAt('sig:main', 6)!;
    const b = shifted.snapshotAt('sig:main', 3)!;
    expect(a.phase).toBe(b.phase);
    expect(a.remainingTicks).toBe(b.remainingTicks);
    expect(a.nextPhase).toBe(b.nextPhase);
    expect(b.phaseEndTick! - a.phaseEndTick!).toBe(-Math.round(3 * HZ));
  });

  it('wraps negative time into the previous cycle', () => {
    // t=-6 → in-cycle (−6+5) mod 17 = 16 → still red, one second before green.
    const snap = bookWith([mainProgram()]).snapshotAt('sig:main', -6)!;
    expect(snap.phase).toBe('red');
    expect(snap.nextPhase).toBe('green');
    expect(snap.remainingTicks).toBe(50); // one second = 50 engine ticks
    // And the wrap boundary is absolute: green starts at t=-5.
    expect(snap.phaseEndTick).toBe(Math.round(-5 * HZ));
  });

  it('agrees with phaseAt across the warm-up prologue', () => {
    const book = bookWith([mainProgram()]);
    for (let i = -400; i <= 400; i++) {
      const t = i / HZ;
      expect(book.snapshotAt('sig:main', t)!.phase).toBe(book.phaseAt('sig:main', t));
    }
  });
});

describe('SignalBook.snapshotAt — runtime overrides', () => {
  const book = bookWith([mainProgram()]);

  it('pins the forced phase and suspends scheduled timing', () => {
    expect(book.setOverride('sig:main', 'green')).toBe(true);
    const snap = book.snapshotAt('sig:main', 2)!;
    expect(snap.phase).toBe('green');
    expect(snap.source).toBe('override');
    expect(snap.phaseStartTick).toBeNull();
    expect(snap.phaseEndTick).toBeNull();
    expect(snap.remainingTicks).toBeNull();
    expect(snap.nextPhase).toBeNull();
    // Cycle metadata survives an override: consumers still know the law underneath.
    expect(snap.cycleLengthTicks).toBe(17 * HZ);
  });

  it('restores exact program timing when the override clears', () => {
    book.setOverride('sig:main', null); // earlier tests in this block may have pinned a phase
    const before = book.snapshotAt('sig:main', 2.5);
    book.setOverride('sig:main', 'flashing_yellow');
    book.setOverride('sig:main', null);
    expect(book.snapshotAt('sig:main', 2.5)).toEqual(before);
  });

  it('carries failure states forced through an override', () => {
    book.setOverride('sig:main', 'off');
    expect(book.snapshotAt('sig:main', 0)!.failureState).toBe('off');
    book.setOverride('sig:main', 'flashing_red_arrow');
    expect(book.snapshotAt('sig:main', 0)!.failureState).toBe('flashing-red');
    book.setOverride('sig:main', null);
  });
});

describe('SignalBook.snapshotAt — failure states', () => {
  it("preserves an authored 'off' phase", () => {
    const dark = bookWith([
      mainProgram({
        id: 'sig:dark',
        phases: [
          { phase: 'red', durationS: 8 },
          { phase: 'off', durationS: 4 },
        ],
        mapBinding: undefined,
      }),
    ]);
    // offsetS 3 + warmup 2: the off phase (cycle seconds [8,12)) spans t ∈ [3,7).
    const snap = dark.snapshotAt('sig:dark', 4)!;
    expect(snap.failureState).toBe('off');
    // Heads fall back to the bound stop-line lanes when no physical ids exist.
    expect(snap.headIds).toEqual(['10:-1']);
    expect(snap.junctionId).toBeNull();
    // Working phases carry no failure field at all.
    const working = dark.snapshotAt('sig:dark', 0)!;
    expect(working.phase).toBe('red');
    expect('failureState' in working).toBe(false);
  });

  it("maps flashing red variants to 'flashing-red'", () => {
    const flashing = bookWith([
      mainProgram({
        id: 'sig:flash',
        phases: [
          { phase: 'flashing_red', durationS: 3 },
          { phase: 'flashing_red_arrow', durationS: 3 },
        ],
      }),
    ]);
    expect(flashing.snapshotAt('sig:flash', 0)!.failureState).toBe('flashing-red');
    expect(flashing.snapshotAt('sig:flash', 3.5)!.failureState).toBe('flashing-red');
  });

  it('omits the field for ordinary indications', () => {
    const book = bookWith([mainProgram()]);
    for (const t of [0, 1, 3, 9]) {
      expect('failureState' in book.snapshotAt('sig:main', t)!).toBe(false);
    }
  });
});

describe('SignalBook.snapshotAt — non-looping programs', () => {
  const finite = bookWith([mainProgram({ id: 'sig:once', loop: false })], 0);

  it('clamps before the authored window with no scheduled transition', () => {
    // Window starts at t = −offset = −3.
    const snap = finite.snapshotAt('sig:once', -4)!;
    expect(snap.phase).toBe('green');
    expect(snap.source).toBe('program');
    expect(snap.phaseStartTick).toBeNull();
    expect(snap.phaseEndTick).toBeNull();
    expect(snap.remainingTicks).toBeNull();
    expect(snap.nextPhase).toBeNull();
  });

  it('holds the final phase after the window, equally unscheduled', () => {
    // Cycle ends at t = 14.
    const snap = finite.snapshotAt('sig:once', 15)!;
    expect(snap.phase).toBe('red');
    expect(snap.phaseEndTick).toBeNull();
    expect(snap.nextPhase).toBeNull();
  });

  it('reports real boundaries inside the window', () => {
    // With warm-up 0 and offset 3 the window opens at t=-3; t=0 sits 3 s into green.
    const snap = finite.snapshotAt('sig:once', 0)!;
    expect(snap.phase).toBe('green');
    expect(snap.phaseStartTick).toBe(Math.round(-3 * HZ));
    expect(snap.phaseEndTick).toBe(Math.round(2 * HZ));
    expect(snap.nextPhase).toBe('yellow');
  });
});

describe('public API surface', () => {
  it('returns null for unknown signals', () => {
    const book = bookWith([mainProgram()]);
    expect(book.snapshotAt('sig:nope', 0)).toBeNull();
  });

  it('exposes the free `signalSnapshotAt` form identical to the method', () => {
    const book = bookWith([mainProgram()]);
    expect(signalSnapshotAt(book, 'sig:main', 1)).toEqual(book.snapshotAt('sig:main', 1));
  });

  it('lists every program via snapshotsAt in sorted-id order', () => {
    const book = bookWith([
      mainProgram({ id: 'sig:b' }),
      mainProgram({ id: 'sig:a' }),
    ]);
    expect(book.snapshotsAt(1).map((s) => s.signalId)).toEqual(['sig:a', 'sig:b']);
  });
});
