import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectByName, projectByRepo, readProjects } from './projects.js';

const dir = mkdtempSync(join(tmpdir(), 'seam-projects-'));
const file = join(dir, 'projects.json');

writeFileSync(
  file,
  JSON.stringify({
    dedicate: {
      issuesRepo: 'Dedicate-com/platform-web',
      configDir: 'projects/dedicate',
      watch: ['Dedicate-com/platform-service', 'Dedicate-com/idp-service'],
    },
    side: { issuesRepo: 'me/my-app', configDir: 'projects/side', watch: ['me/my-api'] },
  }),
);

const projects = readProjects(file);

// A webhook carries the repo that fired, and nothing else tells us which project it belongs to.
assert.equal(projectByRepo(projects, 'Dedicate-com/idp-service')?.name, 'dedicate');
assert.equal(projectByRepo(projects, 'me/my-api')?.name, 'side');

// GitHub is case-insensitive about repo names and payload casing is not guaranteed to match
// whatever someone typed into projects.json.
assert.equal(projectByRepo(projects, 'dedicate-com/PLATFORM-SERVICE')?.name, 'dedicate');

// An unwatched repo must resolve to nothing rather than to the first project, or a stray webhook
// would file issues in someone else's tracker.
assert.equal(projectByRepo(projects, 'Dedicate-com/vault-service'), undefined);

assert.equal(projectByName(projects, 'side').issuesRepo, 'me/my-app');
assert.throws(() => projectByName(projects, 'nope'), /known: dedicate, side/);

// A malformed file must be loud: a silently-empty project list means every webhook is ignored and
// the service looks healthy while checking nothing.
const bad = join(dir, 'bad.json');
writeFileSync(bad, JSON.stringify({ x: { issuesRepo: 'not-a-repo', configDir: 'c', watch: [] } }));
assert.throws(() => readProjects(bad), /is not valid/);

console.log('ok');
