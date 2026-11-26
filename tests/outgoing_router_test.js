const assert = require('node:assert/strict');
const { test } = require('node:test');
const { OutgoingRouter } = require('../Electron/dist-electron/outgoing_router');
const { NeighborMonitor } = require('../Electron/dist-electron/shared/neighbor_monitor');
const { parseHealthReport } = require('../Electron/dist-electron/shared/health');

// Mirrors tests/outgoing_router_test.cpp.
test('outgoing router queues for neighbors that are not ready and delivers in order', () => {
    let clock = 0;
    const delivered = [];
    const router = new OutgoingRouter((neighbor, frame) => delivered.push([neighbor, frame]), () => clock);

    assert.equal(router.send(1, 'a', 0), false);
    assert.equal(router.send(1, 'b', 0), false);
    assert.equal(router.send(2, 'other', 0), false);
    assert.deepEqual(delivered, []);

    assert.equal(router.markReady(1), true);
    assert.equal(router.markReady(1), false);
    assert.deepEqual(delivered, [[1, 'a'], [1, 'b']]);
    assert.equal(router.queued(1), 0);
    assert.equal(router.queued(2), 1);

    assert.equal(router.send(1, 'c', 0), true);
    assert.deepEqual(delivered.at(-1), [1, 'c']);
});

test('outgoing router expires messages by time to live and never expires ttl 0', () => {
    let clock = 0;
    const delivered = [];
    const router = new OutgoingRouter((neighbor, frame) => delivered.push([neighbor, frame]), () => clock);

    router.send(3, 'short', 100);
    router.send(3, 'forever', 0);
    router.send(3, 'long', 1000);
    clock += 200;
    assert.equal(router.sweep(), 1);
    assert.equal(router.queued(3), 2);
    clock += 10000;
    router.markReady(3);
    assert.deepEqual(delivered, [[3, 'forever']]);

    delivered.length = 0;
    router.send(4, 'stale', 50);
    clock += 100;
    router.markReady(4);
    assert.deepEqual(delivered, []);
});

test('outgoing router keeps the queue when a neighbor leaves and drops it only when declared down', () => {
    const delivered = [];
    const router = new OutgoingRouter((neighbor, frame) => delivered.push([neighbor, frame]));
    router.markReady(4);
    assert.equal(router.markNotReady(4), true);
    assert.equal(router.markNotReady(4), false);
    router.send(4, 'x', 0);
    router.send(4, 'y', 0);
    assert.equal(router.discardQueue(4), 2);
    assert.equal(router.discardQueue(4), 0);
    router.send(4, 'z', 0);
    router.markReady(4);
    assert.deepEqual(delivered, [[4, 'z']]);
});

test('neighbor monitor probes until its budget expires and accepts a late READY', () => {
    let clock = 0;
    const sent = [], states = [];
    const router = new OutgoingRouter(() => {}, () => clock);
    const monitor = new NeighborMonitor((id, command) => sent.push([id, command]),
        (id) => router.state(id), (id, state) => { router.setState(id, state); states.push([id, state]); },
        () => clock);
    monitor.start(1);
    states.length = 0;
    clock = 1000;
    monitor.tick();
    monitor.observe(1, false);
    assert.deepEqual(states, []);
    clock = 10000;
    monitor.tick();
    assert.deepEqual(sent, [[1, 'probe']]);
    assert.deepEqual(states, [[1, 'unreachable']]);
    monitor.observe(1, true);
    assert.deepEqual(states.at(-1), [1, 'ready']);
});

test('neighbor monitor detects silence and recovers on traffic', () => {
    let clock = 0;
    const sent = [], states = [];
    const router = new OutgoingRouter(() => {}, () => clock);
    const monitor = new NeighborMonitor((id, command) => sent.push([id, command]),
        (id) => router.state(id), (id, state) => { router.setState(id, state); states.push([id, state]); },
        () => clock);
    monitor.start(1);
    states.length = 0;
    monitor.observe(1, true);
    clock = 3000;
    monitor.tick();
    clock = 10000;
    monitor.tick();
    assert.deepEqual(states, [[1, 'ready'], [1, 'suspect'], [1, 'down']]);
    assert.deepEqual(sent, [[1, 'ping'], [1, 'ping']]);
    monitor.report(1, { processedCount: '0', progressAgeMs: '0', heartbeat: '1', queues: [] });
    monitor.observe(1, false);
    assert.deepEqual(states.at(-1), [1, 'ready']);
});

test('health monitoring detects stale heartbeats and stalled queues and recovers', () => {
    let clock = 0;
    const router = new OutgoingRouter(() => {}, () => clock);
    const monitor = new NeighborMonitor(() => {}, (id) => router.state(id),
        (id, state) => router.setState(id, state), () => clock);
    monitor.start(1);
    monitor.observe(1, true);
    const report = (heartbeat, processedCount, depth) => {
        monitor.report(1, { heartbeat: String(heartbeat), processedCount: String(processedCount),
            progressAgeMs: '0', queues: depth ? [{ destination: 2, depth: String(depth), oldestAgeMs: '0' }] : [] });
        monitor.observe(1, false);
        monitor.tick();
    };
    report(1, 0, 0);
    for (clock = 1000; clock <= 3000; clock += 1000) report(1, 0, 0);
    assert.equal(router.state(1), 'degraded');
    report(2, 0, 0);
    assert.equal(router.state(1), 'ready');
    clock = 5000;
    report(3, 10, 1);
    for (clock = 6000; clock <= 8000; clock += 1000) report(clock / 1000, 10, 1);
    assert.equal(router.state(1), 'degraded');
    report(9, 11, 1);
    assert.equal(router.state(1), 'ready');
});

test('health reports expose queue age and reject invalid reports', () => {
    let clock = 0;
    const router = new OutgoingRouter(() => {}, () => clock);
    router.send(2, 'oldest', 0);
    clock = 100;
    router.send(2, 'newest', 0);
    clock = 250;
    assert.deepEqual(router.queueHealth(), [{ destination: 2, depth: 2, oldestAgeMs: 250 }]);
    assert.throws(() => parseHealthReport({ heartbeat: '1', processedCount: '0',
        progressAgeMs: '0', queues: [{ destination: 2, depth: '-1', oldestAgeMs: '0' }] }),
    /Invalid health queue/);
});

test('missing health reports keep application messages queued until a report arrives', () => {
    let clock = 0;
    const delivered = [];
    const router = new OutgoingRouter((id, frame) => delivered.push([id, frame]), () => clock);
    const monitor = new NeighborMonitor(() => {}, (id) => router.state(id),
        (id, state) => router.setState(id, state), () => clock);
    monitor.start(1);
    monitor.observe(1, true);
    for (clock = 1000; clock <= 3000; clock += 1000) {
        monitor.observe(1, false);
        monitor.tick();
    }
    assert.equal(router.state(1), 'degraded');
    router.send(1, 'held', 0);
    monitor.observe(1, true);
    assert.deepEqual(delivered, []);
    monitor.report(1, { processedCount: '0', progressAgeMs: '0', heartbeat: '1', queues: [] });
    monitor.observe(1, false);
    monitor.tick();
    assert.deepEqual(delivered, [[1, 'held']]);
});
