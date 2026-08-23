export type StudioSessionMode = 'authoring' | 'preparing' | 'paused' | 'playing' | 'ended' | 'error';

export interface StudioSessionState {
  readonly mode: StudioSessionMode;
  readonly time: number;
  readonly duration: number;
  readonly validation: 'unchecked' | 'validating' | 'valid' | 'invalid';
  readonly error: string | null;
}

export type StudioSessionEvent =
  | { type: 'prepare'; duration: number }
  | { type: 'ready' }
  | { type: 'ready-and-play' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  | { type: 'tick'; delta: number }
  | { type: 'clock'; time: number }
  | { type: 'stop' }
  | { type: 'fail'; message: string };

export function initialSession(duration: number): StudioSessionState {
  return { mode: 'authoring', time: 0, duration, validation: 'unchecked', error: null };
}

export function reduceSession(state: StudioSessionState, event: StudioSessionEvent): StudioSessionState {
  switch (event.type) {
    case 'prepare':
      return { mode: 'preparing', time: 0, duration: event.duration, validation: 'validating', error: null };
    case 'ready':
      return state.mode === 'preparing' ? { ...state, mode: 'paused', validation: 'valid' } : state;
    case 'ready-and-play':
      return state.mode === 'preparing' ? { ...state, mode: 'playing', time: 0, validation: 'valid' } : state;
    case 'play':
      return state.mode === 'paused' || state.mode === 'ended'
        ? { ...state, mode: 'playing', time: state.mode === 'ended' ? 0 : state.time }
        : state;
    case 'pause':
      return state.mode === 'playing' ? { ...state, mode: 'paused' } : state;
    case 'seek': {
      if (state.mode === 'authoring' || state.mode === 'preparing' || state.mode === 'error') return state;
      const time = clamp(event.time, 0, state.duration);
      return { ...state, time, mode: time >= state.duration ? 'ended' : state.mode === 'ended' ? 'paused' : state.mode };
    }
    case 'tick': {
      if (state.mode !== 'playing') return state;
      const time = Math.min(state.duration, state.time + Math.max(0, event.delta));
      return { ...state, time, mode: time >= state.duration ? 'ended' : 'playing' };
    }
    case 'clock': {
      if (state.mode !== 'playing') return state;
      const time = clamp(event.time, 0, state.duration);
      return { ...state, time, mode: time >= state.duration ? 'ended' : 'playing' };
    }
    case 'stop':
      return initialSession(state.duration);
    case 'fail':
      return { ...state, mode: 'error', validation: 'invalid', error: event.message };
  }
}

export function canMutate(mode: StudioSessionMode): boolean {
  return mode === 'authoring';
}

/** Play starts (or retries) preparation whenever no usable trace exists. */
export function shouldPreparePlayback(mode: StudioSessionMode): boolean {
  return mode === 'authoring' || mode === 'error';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
