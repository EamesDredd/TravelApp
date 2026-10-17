import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetLocate, pendingLocate, rememberLocate } from '../pendingLocate';

describe('pendingLocate', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('remembers the dialog for a while, without the restored flag', () => {
    rememberLocate('t1', { locateId: 's1', restored: true }, 1000);
    expect(pendingLocate(1000 + 60_000)).toEqual({ tripId: 't1', opts: { locateId: 's1' }, at: 1000 });
    expect(pendingLocate(1000 + 21 * 60_000)).toBeNull();
    // Expired entries are cleaned up.
    expect(store.size).toBe(0);
  });

  it('keeps a new place being typed, and forgets on request', () => {
    rememberLocate('t1', { day: 2, category: 'meal', name: '南翔馒头店' }, 5000);
    expect(pendingLocate(6000)?.opts).toEqual({ day: 2, category: 'meal', name: '南翔馒头店' });
    forgetLocate();
    expect(pendingLocate(6000)).toBeNull();
  });

  it('ignores broken data and a clock that went back', () => {
    store.set('travel-planner-pending-locate', '{oops');
    expect(pendingLocate()).toBeNull();
    rememberLocate('t1', { locateId: 's1' }, 10_000);
    expect(pendingLocate(5_000)).toBeNull();
  });

  it('works without storage', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => rememberLocate('t1', {})).not.toThrow();
    expect(pendingLocate()).toBeNull();
  });
});
