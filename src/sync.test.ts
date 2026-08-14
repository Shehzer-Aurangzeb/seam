import assert from 'node:assert/strict';
import { backendOf, type Desired, type Issue, reconcile } from './sync.js';

// The whole point of sync is that it is safe to run unattended, so what it decides to CLOSE is the
// dangerous half — an issue closed by mistake is a regression nobody is watching any more.

const desired = (backend: string, key: string): Desired => ({
  marker: `<!-- seam:${backend}:${key} -->`,
  title: `[seam] ${key}`,
  body: `whatever\n\n<!-- seam:${backend}:${key} -->`,
});

const issue = (number: number, backend: string, key: string): Issue => ({
  number,
  title: `[seam] ${key}`,
  body: `whatever\n\n<!-- seam:${backend}:${key} -->`,
});

const KEY = 'response-field-missing:GET /users/{id}:profile.email';
const OTHER = 'operation-missing:GET /gone';

// ---------- the three ordinary outcomes ----------
{
  const { open, close } = reconcile(
    [desired('platform', KEY), desired('platform', OTHER)],
    [issue(1, 'platform', KEY), issue(2, 'platform', 'operation-missing:GET /fixed')],
    new Set(['platform']),
  );

  assert.deepEqual(open.map((d) => d.title), [`[seam] ${OTHER}`], 'a finding with no issue opens one');
  assert.deepEqual(close.map((i) => i.number), [2], 'an issue with no finding closes');
  // Issue 1 appears in neither list: still failing, already filed, leave it alone.
}

// ---------- an unreachable backend must not look like a fixed one ----------
{
  const { open, close } = reconcile([], [issue(1, 'platform', KEY)], new Set());
  assert.deepEqual(close, [], 'zero findings from a backend that never ran closes nothing');
  assert.deepEqual(open, []);

  const ran = reconcile([], [issue(1, 'platform', KEY)], new Set(['platform']));
  assert.deepEqual(ran.close.map((i) => i.number), [1], 'the same emptiness DOES close once the backend ran');
}

// ---------- one backend failing must not take another's issues down with it ----------
{
  const { close } = reconcile([], [issue(1, 'platform', KEY), issue(2, 'idp', KEY)], new Set(['idp']));
  assert.deepEqual(close.map((i) => i.number), [2], 'only the verified backend has its issues closed');
}

// ---------- same route, two backends: markers must not collide ----------
{
  const { open, close } = reconcile([desired('idp', KEY)], [issue(1, 'platform', KEY)], new Set(['idp', 'platform']));
  assert.equal(open.length, 1, "idp's finding does not match platform's issue");
  assert.deepEqual(close.map((i) => i.number), [1], "platform's issue is unclaimed and closes");
}

// ---------- a human's issue that happens to carry the label is not ours ----------
{
  const mine: Issue = { number: 9, title: 'seam is too noisy', body: 'no marker here' };
  assert.equal(backendOf(mine.body), null);
  assert.deepEqual(reconcile([], [mine], new Set(['platform'])).close, [], 'an unmarked issue is never touched');
}

console.log('ok');
