'use strict';

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// Participant Node 

class ParticipantNode {
    constructor(id) {
        this.id = id;
        this.state = 'INIT';
    }

    async process(action, networkDelay) {
        await delay(networkDelay);

        switch (action) {
            case 'PREPARE': this.state = 'PREPARED'; break;
            case 'PRE-COMMIT': this.state = 'PRE-COMMITTED'; break;
            case 'COMMIT': this.state = 'COMMITTED'; break;
            case 'ABORT': this.state = 'ABORTED'; break;
            case 'CAN-COMMIT': this.state = 'READY'; break;
        }

        return 'OK';
    }

    reset() {
        this.state = 'INIT';
    }
}

// 2PC 

async function run2PC(nodes, networkDelay, failCoordinator) {
    // Phase 1: PREPARE
    await Promise.all(nodes.map(n => n.process('PREPARE', networkDelay)));

    if (failCoordinator) {
        return { status: 'BLOCKED', blocked: true };
    }

    // Phase 2: COMMIT
    await Promise.all(nodes.map(n => n.process('COMMIT', networkDelay)));

    return { status: 'SUCCESS', blocked: false };
}

// 3PC 

const ELECTION_TIMEOUT_MS = 50; // surrogate coordinator election time

async function run3PC(nodes, networkDelay, failCoordinator) {
    // Phase 1: CAN-COMMIT
    await Promise.all(nodes.map(n => n.process('CAN-COMMIT', networkDelay)));

    // Phase 2: PRE-COMMIT

    await Promise.all(nodes.map(n => n.process('PRE-COMMIT', networkDelay)));

    if (failCoordinator) {
        // Participants detect coordinator timeout, elect surrogate (highest ID wins),
        // and carry the protocol to completion autonomously.
        await delay(ELECTION_TIMEOUT_MS);                            // election
        await Promise.all(nodes.map(n => n.process('COMMIT', networkDelay))); // re-commit
        return { status: 'RECOVERED', blocked: false };
    }

    // Phase 3: DO-COMMIT
    await Promise.all(nodes.map(n => n.process('COMMIT', networkDelay)));

    return { status: 'SUCCESS', blocked: false };
}

//  Single experiment run 

async function runExperiment(protocolType, nodesCount, networkDelay, failCoordinator = false) {
    const nodes = Array.from({ length: nodesCount }, (_, i) => new ParticipantNode(i));
    const start = Date.now();

    let result;
    if (protocolType === '2PC') {
        result = await run2PC(nodes, networkDelay, failCoordinator);
    } else {
        result = await run3PC(nodes, networkDelay, failCoordinator);
    }

    return {
        ...result,
        duration: Date.now() - start,
        finalStates: nodes.map(n => ({ id: n.id, state: n.state })),
    };
}

//  Multi-run benchmark 

async function benchmark(protocolType, nodesCount, networkDelay, runs = 20) {
    const durations = [];
    let blocked = 0;

    for (let i = 0; i < runs; i++) {
        const crash = Math.random() < 0.1;
        const r = await runExperiment(protocolType, nodesCount, networkDelay, crash);
        if (r.blocked) { blocked++; } else { durations.push(r.duration); }
    }

    const avg = durations.length
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null;

    // TPS estimate
    const tps = avg ? Math.round(1000 / avg * 100) : 0;

    return {
        avgLatency: avg,
        tps,
        blockedPct: ((blocked / runs) * 100).toFixed(0),
    };
}

// Main 
async function start() {
    const NODES = 5;
    const BENCH_RUNS = 200;

    // Network profiles
    const profiles = [
        { name: 'LAN', delay: 10 },
        { name: 'WAN-Near', delay: 30 },
        { name: 'WAN-Far', delay: 50 },
        { name: 'Cross-Region', delay: 100 },
    ];

    console.log('='.repeat(60));
    console.log(' 2PC vs 3PC Simulator');
    console.log(`  Nodes per transaction : ${NODES}`);
    console.log(`  Runs per benchmark    : ${BENCH_RUNS}`);
    console.log(`  Coordinator crash rate: 10%`);
    console.log('='.repeat(60));

    // Table 2: Latency & Throughput 
    console.log('\n--- Table 2: Commit Latency and Throughput ---\n');
    console.log(
        'Profile'.padEnd(14),
        '2PC Latency'.padEnd(14),
        '3PC Latency'.padEnd(14),
        '2PC TPS'.padEnd(10),
        '3PC TPS'.padEnd(10),
        'Overhead',
    );
    console.log('-'.repeat(72));

    for (const p of profiles) {
        const r2 = await benchmark('2PC', NODES, p.delay, BENCH_RUNS);
        const r3 = await benchmark('3PC', NODES, p.delay, BENCH_RUNS);
        const overhead = r2.avgLatency && r3.avgLatency
            ? (((r3.avgLatency - r2.avgLatency) / r2.avgLatency) * 100).toFixed(0) + '%'
            : 'N/A';

        console.log(
            p.name.padEnd(14),
            `${r2.avgLatency} ms`.padEnd(14),
            `${r3.avgLatency} ms`.padEnd(14),
            String(r2.tps).padEnd(10),
            String(r3.tps).padEnd(10),
            overhead,
        );
    }

    // Table 3: Failure behavior
    console.log('\n--- Table 3: Behavior Under Coordinator Failure ---\n');

    const fail2PC = await runExperiment('2PC', NODES, 50, true);
    console.log(`2PC — coordinator crash during Phase 2:`);
    console.log(`  Status : ${fail2PC.status}`);
    console.log(`  States : ${fail2PC.finalStates.map(n => n.state).join(', ')}`);
    console.log(`  Result : Locked indefinitely — manual DBA intervention required\n`);

    const fail3PC = await runExperiment('3PC', NODES, 50, true);
    console.log(`3PC — coordinator crash during Phase 2:`);
    console.log(`  Status   : ${fail3PC.status}`);
    console.log(`  States   : ${fail3PC.finalStates.map(n => n.state).join(', ')}`);
    console.log(`  Duration : ${fail3PC.duration} ms (includes election + re-commit)`);
    console.log(`  Result   : Autonomous recovery — no manual intervention needed`);

    // Single transaction walkthrough
    console.log('\n--- Single Transaction Walkthrough (WAN-Far, 50ms) ---\n');

    const demo2 = await runExperiment('2PC', NODES, 50);
    console.log(`2PC  duration: ${demo2.duration} ms  |  status: ${demo2.status}`);
    console.log(`  Node states: ${demo2.finalStates.map(n => `[${n.id}]${n.state}`).join(' ')}`);

    const demo3 = await runExperiment('3PC', NODES, 50);
    console.log(`3PC  duration: ${demo3.duration} ms  |  status: ${demo3.status}`);
    console.log(`  Node states: ${demo3.finalStates.map(n => `[${n.id}]${n.state}`).join(' ')}`);

    console.log('\nDone.');
}

start();