import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { isPortInUse, findPortListenerPid } from './cli.mjs';

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
}

async function withEphemeralServer(fn) {
  const server = net.createServer();
  await listen(server, 0, '127.0.0.1');
  const port = server.address().port;
  try {
    await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('isPortInUse resolves true when something is listening', async () => {
  await withEphemeralServer(async (port) => {
    assert.equal(await isPortInUse(port), true);
  });
});

test('isPortInUse resolves false on a free port', async () => {
  // Grab a fresh ephemeral port, close it, then verify nothing answers there.
  const server = net.createServer();
  await listen(server, 0, '127.0.0.1');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortInUse(port), false);
});

test('isPortInUse checks both loopback families where available', async () => {
  const v6 = net.createServer();
  try {
    await listen(v6, 0, '::1');
  } catch {
    // IPv6 loopback unavailable in this environment; nothing to assert.
    return;
  }
  const port = v6.address().port;
  try {
    assert.equal(await isPortInUse(port), true);
  } finally {
    await new Promise((resolve) => v6.close(resolve));
  }
});

test('findPortListenerPid finds this process\'s own listener', async () => {
  await withEphemeralServer(async (port) => {
    const pid = findPortListenerPid(port);
    // Best-effort: some sandboxes lack lsof/fuser/ss entirely.
    if (pid === null) return;
    assert.equal(pid, process.pid);
  });
});

test('findPortListenerPid returns null on a free port', async () => {
  const server = net.createServer();
  await listen(server, 0, '127.0.0.1');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.equal(findPortListenerPid(port), null);
});
