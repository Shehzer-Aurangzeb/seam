import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Project } from './projects.js';
import { decideRun, verifySignature } from './webhook.js';

const SECRET = 'not-a-real-secret';
const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;

const project = (trigger?: Project['trigger']): Project => ({
  name: 'p',
  issuesRepo: 'me/app',
  configDir: 'projects/p',
  watch: ['me/api'],
  trigger,
});

// ---------- signatures: the endpoint is public, so this is the only thing standing in front of it ----------
{
  const body = '{"zen":"hi"}';
  assert.equal(verifySignature(SECRET, body, sign(body)), true);
  assert.equal(verifySignature(SECRET, body, sign('{"zen":"bye"}')), false, 'a signature for other content fails');
  assert.equal(verifySignature('wrong-secret', body, sign(body)), false);
  assert.equal(verifySignature(SECRET, body, undefined), false, 'an unsigned delivery is never trusted');
  assert.equal(verifySignature(SECRET, body, 'sha256=short'), false, 'a length mismatch rejects instead of throwing');
}

// ---------- deployment projects ----------
{
  const p = project({ on: 'deployment', environment: 'dev' });
  const ok = decideRun('deployment_status', { deployment_status: { state: 'success' }, deployment: { environment: 'dev' } }, p);
  assert.equal(ok.run, true);
  assert.equal(ok.run && ok.awaitSpecChange, false, 'the deploy already replaced the spec, so nothing is waited for');

  const failed = decideRun('deployment_status', { deployment_status: { state: 'failure' }, deployment: { environment: 'dev' } }, p);
  assert.equal(failed.run, false, 'a failed deploy did not change the spec');

  const wrongEnv = decideRun('deployment_status', { deployment_status: { state: 'success' }, deployment: { environment: 'prod' } }, p);
  assert.equal(wrongEnv.run, false, 'another environment is a different spec');

  // in_progress arrives BEFORE the new version is serving, and acting on it reads the old spec.
  const pending = decideRun('deployment_status', { deployment_status: { state: 'in_progress' }, deployment: { environment: 'dev' } }, p);
  assert.equal(pending.run, false);

  assert.equal(decideRun('push', { ref: 'refs/heads/main' }, p).run, false, 'a deployment project ignores pushes');

  // No environment filter means any environment counts.
  const any = decideRun('deployment_status', { deployment_status: { state: 'success' }, deployment: { environment: 'staging' } }, project({ on: 'deployment' }));
  assert.equal(any.run, true);
}

// ---------- push projects ----------
{
  const p = project({ on: 'push', branches: ['develop'] });
  const ok = decideRun('push', { ref: 'refs/heads/develop' }, p);
  assert.equal(ok.run, true);
  assert.equal(ok.run && ok.awaitSpecChange, true, 'a push lands before the deploy, so the spec has not moved yet');

  assert.equal(decideRun('push', { ref: 'refs/heads/feature/x' }, p).run, false);
  assert.equal(decideRun('push', { ref: 'refs/tags/v1' }, p).run, false, 'a tag is not a branch');
  assert.equal(decideRun('push', { ref: 'refs/heads/develop', deleted: true }, p).run, false, 'a deleted branch deploys nothing');

  // Unnamed branches fall back to the usual integration ones rather than to "everything".
  const fallback = project({ on: 'push' });
  assert.equal(decideRun('push', { ref: 'refs/heads/dev' }, fallback).run, true);
  assert.equal(decideRun('push', { ref: 'refs/heads/chore/readme' }, fallback).run, false);
}

// ---------- anything unrecognised must never fire ----------
{
  const p = project();
  assert.equal(decideRun('issues', { action: 'opened' }, p).run, false);
  assert.equal(decideRun('deployment_status', {}, p).run, false, 'a malformed payload is not a success');
  assert.equal(decideRun('deployment_status', null, p).run, false);
  // No trigger configured at all defaults to deployment, never to the riskier push path.
  assert.equal(decideRun('push', { ref: 'refs/heads/main' }, p).run, false);
}

console.log('ok');
