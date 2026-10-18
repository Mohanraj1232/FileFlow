import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { StorageScanStore, type RunningScan } from './store';
import * as repo from './repo';
import { openTestDb, makeTmpTree } from '../../test/helpers';

let db: any;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

async function finished(store: StorageScanStore, id: number): Promise<RunningScan> {
  for (let i = 0; i < 400; i++) {
    const s = store.get(id)!;
    if (s.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('scan did not finish');
}

describe('StorageScanStore', () => {
  it('scans in the background and publishes the result when it completes', async () => {
    const root = makeTmpTree({ 'a.txt': 'abc', 'sub/b.bin': 'defgh' });
    const store = new StorageScanStore();
    const started = store.start({ db, roots: [root] });
    expect(started.state).toBe('running');
    expect(repo.listScans(db)).toEqual([]); // not visible yet

    const done = await finished(store, started.id);
    expect(done.state).toBe('done');
    expect(repo.listScans(db)[0]).toMatchObject({ id: started.id, file_count: 2, stored_bytes: 8, state: 'done' });
    expect(repo.queryFiles(db, started.id, {}).total_count).toBe(2);
  });

  it('allows only one scan at a time', async () => {
    const root = makeTmpTree({ 'a.txt': 'x' });
    const store = new StorageScanStore();
    const first = store.start({ db, roots: [root] });
    expect(() => store.start({ db, roots: [root] })).toThrow(/already running/);
    await finished(store, first.id);
    expect(() => store.start({ db, roots: [root] })).not.toThrow();
  });

  it('a re-scan replaces the earlier report only when it completes', async () => {
    const root = makeTmpTree({ 'a.txt': 'abc' });
    const store = new StorageScanStore();
    const first = await finished(store, store.start({ db, roots: [root] }).id);

    const second = store.start({ db, roots: [root] });
    // While the new scan runs, the old report is still the one on offer.
    expect(repo.listScans(db).map((s) => s.id)).toEqual([first.id]);
    await finished(store, second.id);
    expect(repo.listScans(db).map((s) => s.id)).toEqual([second.id]);
  });

  it('cancelling discards the new scan and keeps the old report intact', async () => {
    const spec: Record<string, string> = {};
    for (let i = 0; i < 400; i++) spec[`f${i}.txt`] = 'x';
    const root = makeTmpTree(spec);
    const store = new StorageScanStore();
    const first = await finished(store, store.start({ db, roots: [root] }).id);
    expect(repo.getScan(db, first.id)?.file_count).toBe(400);

    const second = store.start({ db, roots: [root] });
    expect(store.cancel(second.id)).toBe(true);
    const ended = await finished(store, second.id);

    expect(ended.state).toBe('cancelled');
    expect(repo.getScan(db, second.id)).toBeUndefined();
    expect(repo.listScans(db).map((s) => s.id)).toEqual([first.id]);
    expect(repo.queryFiles(db, first.id, {}).total_count).toBe(400);
    expect(store.cancel(second.id)).toBe(false);
  });

  it('records unreadable folders as errors without failing the scan', async () => {
    const root = makeTmpTree({ 'a.txt': 'x' });
    const store = new StorageScanStore();
    const done = await finished(store, store.start({ db, roots: [root, path.join(root, 'missing')] }).id);
    expect(done.state).toBe('done');
    expect(repo.getScan(db, done.id)?.error_count).toBe(1);
    expect(repo.getErrors(db, done.id)[0].path).toContain('missing');
  });

  it('applies ignore patterns and the hidden-files option', async () => {
    const root = makeTmpTree({ 'a.txt': '1', 'b.log': '2', '.hidden': '3' });
    const store = new StorageScanStore();
    const done = await finished(
      store,
      store.start({ db, roots: [root], includeHidden: false, isIgnored: (p) => p.endsWith('.log') }).id
    );
    expect(repo.queryFiles(db, done.id, {}).files.map((f) => f.name)).toEqual(['a.txt']);
  });

  it('reports progress updates and a final update', async () => {
    const root = makeTmpTree({ 'a.txt': 'abc' });
    const store = new StorageScanStore();
    const states: string[] = [];
    const started = store.start({ db, roots: [root], onUpdate: (s) => states.push(s.state) });
    await finished(store, started.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(states[states.length - 1]).toBe('done');
  });
});
