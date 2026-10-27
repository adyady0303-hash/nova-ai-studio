const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nativeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataStore = require('../data-store');

test('deleted user workspaces cannot be recreated by concurrent or stale writes', async t => {
  const root = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'nova-delete-lock-'));
  t.after(() => nativeFs.rmSync(root, { recursive: true, force: true }));
  await dataStore.init(root);
  const dataFs = dataStore.filesystem(root);
  const userId = crypto.randomBytes(16).toString('hex');
  const userRoot = path.join(root, 'users', userId);
  await dataFs.promises.mkdir(userRoot, { recursive: true });
  await dataFs.promises.writeFile(path.join(userRoot, 'before.txt'), 'before');

  const operations = [];
  for (let index = 0; index < 20; index++) {
    operations.push(dataFs.promises.writeFile(path.join(userRoot, `${index}.txt`), String(index)));
    if (index === 9) operations.push(dataStore.deleteUserData(userId));
  }
  await Promise.allSettled(operations);

  assert.equal(nativeFs.existsSync(userRoot), false);
  await assert.rejects(
    dataFs.promises.writeFile(path.join(userRoot, 'stale.txt'), 'stale'),
    error => error?.code === 'EACCES'
  );
  assert.equal(nativeFs.existsSync(userRoot), false);
});
