"use strict";

const fs = require("fs");
const path = require("path");

// configuration

const CONFIG = {
  participants: 5,
  transactionsPerRun: 10000, // transactions per configuration, per repetition
  repetitions: 5, // independent repetitions (different seeds)
  baseSeed: 72026,
  networkJitter: 0.2, // one-way delay ~ Uniform(mean*(1-j), mean*(1+j))
  localProcessingMs: 1, // local processing / log write added to every round
  failureDetectionTimeoutMs: 500, // how long a node waits before declaring a peer failed
  electionTimeoutMs: 200, // coordinator-election time (highest ID among alive nodes wins)
  concurrency: 100, // in-flight transactions assumed for the throughput figure
  probabilities: {
    // per-transaction probability of the injected event
    coordinatorCrash: 0.1,
    participantCrash: 0.1,
    partition: 0.3,
  },
  profiles: [
    { name: "LAN", meanDelayMs: 10 },
    { name: "WAN-Near", meanDelayMs: 30 },
    { name: "WAN-Far", meanDelayMs: 50 },
    { name: "Cross-Region", meanDelayMs: 100 },
  ],
};

const PROTOCOLS = ["2PC", "3PC"];

// random numbers and network

// Seeded random number generator (same seed gives same numbers)
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Creates the random generator and message counter for one run
function makeContext(seed, meanDelayMs) {
  return { rng: mulberry32(seed), meanDelayMs, messages: 0 };
}

// Random one-way network delay around the profile's mean
function oneWayDelay(ctx) {
  const j = CONFIG.networkJitter;
  return ctx.meanDelayMs * (1 - j + 2 * j * ctx.rng());
}

// One protocol round with k participants: slowest delay + local processing
function round(ctx, k) {
  let slowest = 0;
  for (let i = 0; i < k; i++) slowest = Math.max(slowest, oneWayDelay(ctx));
  ctx.messages += k;
  return slowest + CONFIG.localProcessingMs;
}

// normal operation

// One transaction without failures: returns its latency and message count
function commitNormally(ctx, protocol) {
  const n = CONFIG.participants;
  const rounds = protocol === "2PC" ? 2 : 3; // 2PC: prepare, commit. 3PC: can-commit, pre-commit, do-commit
  ctx.messages = 0;
  let latency = 0;
  for (let r = 0; r < rounds; r++) latency += round(ctx, n);
  return { latency, messages: ctx.messages };
}

// termination rules

// 2PC decision from the states of reachable participants
function terminate2PC(states) {
  if (states.includes("ABORTED") || states.includes("INIT")) return "ABORT";
  if (states.includes("COMMITTED")) return "COMMIT";
  return "BLOCKED";
}

// 3PC decision by the new coordinator
function terminate3PC(states) {
  if (states.includes("ABORTED")) return "ABORT";
  if (states.includes("COMMITTED") || states.includes("PRE-COMMITTED"))
    return "COMMIT";
  return "ABORT";
}

// Recovery time and decision after a failure is detected (null time = stays blocked)
function recover(ctx, protocol, states) {
  const others = Math.max(states.length - 1, 0);
  if (protocol === "2PC") {
    const decision = terminate2PC(states);
    const t = round(ctx, others); // state-query round between participants
    return { decision, recoveryMs: decision === "BLOCKED" ? null : t };
  }
  const decision = terminate3PC(states);
  let t = CONFIG.electionTimeoutMs; // highest-ID alive node becomes coordinator
  t += round(ctx, others); // collect states
  if (decision === "COMMIT" && states.includes("READY"))
    t += round(ctx, others); // move uncertain nodes to PRE-COMMITTED
  t += round(ctx, others); // distribute the final decision
  return { decision, recoveryMs: t };
}

// Converts a decision into an outcome label
function toOutcome(decision) {
  return decision === "COMMIT"
    ? "COMMITTED"
    : decision === "ABORT"
      ? "ABORTED"
      : "BLOCKED";
}

// failure scenarios
const FIRST_PHASE_STATE = { "2PC": "PREPARED", "3PC": "READY" };

const SCENARIOS = [
  {
    key: "coordinatorCrashFirstPhase",
    label: "Coordinator crash during first phase",
    probability: CONFIG.probabilities.coordinatorCrash,
    protocols: PROTOCOLS,
    // k participants (0..n-1) received the first-phase message before the crash; the rest never did.
    run(ctx, protocol) {
      const n = CONFIG.participants;
      const k = Math.floor(ctx.rng() * n);
      const states = Array.from({ length: n }, (_, i) =>
        i < k ? FIRST_PHASE_STATE[protocol] : "INIT",
      );
      const r = recover(ctx, protocol, states);
      return {
        outcome: toOutcome(r.decision),
        recoveryMs: r.recoveryMs,
        violation: false,
      };
    },
  },
  {
    key: "coordinatorCrashAfterVotes",
    label: "Coordinator crash after all votes are YES (no decision sent)",
    probability: CONFIG.probabilities.coordinatorCrash,
    protocols: PROTOCOLS,
    // Every participant has voted YES; the coordinator crashes before sending anything else.
    run(ctx, protocol) {
      const n = CONFIG.participants;
      const states = Array(n).fill(FIRST_PHASE_STATE[protocol]);
      const r = recover(ctx, protocol, states);
      return {
        outcome: toOutcome(r.decision),
        recoveryMs: r.recoveryMs,
        violation: false,
      };
    },
  },
  {
    key: "coordinatorCrashAfterPreCommit",
    label: "Coordinator crash after PRE-COMMIT delivered (3PC only)",
    probability: CONFIG.probabilities.coordinatorCrash,
    protocols: ["3PC"],
    // All participants are PRE-COMMITTED when the coordinator crashes before DO-COMMIT.
    run(ctx, protocol) {
      const states = Array(CONFIG.participants).fill("PRE-COMMITTED");
      const r = recover(ctx, protocol, states);
      return {
        outcome: toOutcome(r.decision),
        recoveryMs: r.recoveryMs,
        violation: false,
      };
    },
  },
  {
    key: "participantCrash",
    label: "Participant crash before voting",
    probability: CONFIG.probabilities.participantCrash,
    protocols: PROTOCOLS,
    run(ctx) {
      const t = round(ctx, CONFIG.participants - 1);
      return { outcome: "ABORTED", recoveryMs: t, violation: false };
    },
  },
  {
    key: "networkPartition",
    label: "Network partition after all votes are YES",
    probability: CONFIG.probabilities.partition,
    protocols: PROTOCOLS,
    run(ctx, protocol) {
      const n = CONFIG.participants;
      const minority = 1 + Math.floor(ctx.rng() * 2);
      const states = Array(minority).fill(FIRST_PHASE_STATE[protocol]);
      const r = recover(ctx, protocol, states);
      // The majority side commits in both protocols.
      if (r.decision === "BLOCKED") {
        return { outcome: "BLOCKED", recoveryMs: null, violation: false }; // minority waits for the partition to heal
      }
      if (r.decision === "ABORT") {
        // minority aborts while the majority committed -> atomicity violation
        return {
          outcome: "INCONSISTENT",
          recoveryMs: r.recoveryMs,
          violation: true,
        };
      }
      return {
        outcome: "COMMITTED",
        recoveryMs: r.recoveryMs,
        violation: false,
      };
    },
  },
];

// statistics
const T_CRIT_95 = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
};

// Mean, standard deviation, min, max and 95% CI of a list of numbers
function summarize(values) {
  const xs = values.filter((v) => v !== null && v !== undefined);
  if (xs.length === 0) return null;
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd =
    n > 1
      ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1))
      : 0;
  const t = T_CRIT_95[n - 1] || 1.96;
  return {
    n,
    mean,
    sd,
    min: Math.min(...xs),
    max: Math.max(...xs),
    ci95: n > 1 ? (t * sd) / Math.sqrt(n) : 0,
  };
}

const fmt = (s, d = 1) =>
  s ? `${s.mean.toFixed(d)} ± ${s.sd.toFixed(d)}` : "n/a";

// Different seed for every repetition / profile / protocol / scenario
function seedFor(rep, profileIdx, protocolIdx, scenarioIdx) {
  return (
    CONFIG.baseSeed +
    rep * 100000 +
    profileIdx * 1000 +
    protocolIdx * 100 +
    scenarioIdx
  );
}

// Runs all transactions of one repetition without failures
function runNormalOperation(rep, profile, profileIdx, protocol, protocolIdx) {
  const ctx = makeContext(
    seedFor(rep, profileIdx, protocolIdx, 99),
    profile.meanDelayMs,
  );
  const latencies = new Float64Array(CONFIG.transactionsPerRun);
  let sum = 0;
  let messages = 0;
  for (let i = 0; i < CONFIG.transactionsPerRun; i++) {
    const r = commitNormally(ctx, protocol);
    latencies[i] = r.latency;
    sum += r.latency;
    messages = r.messages;
  }
  const meanLatency = sum / CONFIG.transactionsPerRun;
  // dispersion across individual transactions inside this run
  let sq = 0;
  for (const x of latencies) sq += (x - meanLatency) ** 2;
  const txStd = Math.sqrt(sq / (CONFIG.transactionsPerRun - 1));
  const sorted = Float64Array.from(latencies).sort();
  const p99 = sorted[Math.floor(0.99 * (sorted.length - 1))];
  return {
    meanLatencyMs: meanLatency,
    txStdMs: txStd,
    p99LatencyMs: p99,
    throughputTps: (CONFIG.concurrency * 1000) / meanLatency,
    messagesPerTx: messages,
  };
}

// Runs one repetition of a failure scenario and counts the outcomes
function runScenario(
  rep,
  profile,
  profileIdx,
  protocol,
  protocolIdx,
  scenario,
  scenarioIdx,
) {
  const ctx = makeContext(
    seedFor(rep, profileIdx, protocolIdx, scenarioIdx),
    profile.meanDelayMs,
  );
  const counts = { COMMITTED: 0, ABORTED: 0, BLOCKED: 0, INCONSISTENT: 0 };
  let affected = 0;
  let recoverySum = 0;
  let recovered = 0;
  for (let i = 0; i < CONFIG.transactionsPerRun; i++) {
    if (ctx.rng() >= scenario.probability) continue;
    affected++;
    const r = scenario.run(ctx, protocol);
    counts[r.outcome]++;
    if (r.recoveryMs !== null) {
      recoverySum += r.recoveryMs;
      recovered++;
    }
  }
  const pct = (c) => (affected ? (c / affected) * 100 : 0);
  return {
    affected,
    pctCommitted: pct(counts.COMMITTED),
    pctAborted: pct(counts.ABORTED),
    pctBlocked: pct(counts.BLOCKED),
    pctInconsistent: pct(counts.INCONSISTENT),
    meanRecoveryMs: recovered ? recoverySum / recovered : null,
  };
}

// Runs every configuration for every repetition
function runAll() {
  const normal = []; // one entry per (profile, protocol, rep)
  const failures = []; // one entry per (scenario, profile, protocol, rep)

  for (let rep = 0; rep < CONFIG.repetitions; rep++) {
    CONFIG.profiles.forEach((profile, pi) => {
      PROTOCOLS.forEach((protocol, qi) => {
        normal.push({
          rep: rep + 1,
          profile: profile.name,
          protocol,
          ...runNormalOperation(rep, profile, pi, protocol, qi),
        });
        SCENARIOS.forEach((scenario, si) => {
          if (!scenario.protocols.includes(protocol)) return;
          failures.push({
            rep: rep + 1,
            scenario: scenario.key,
            profile: profile.name,
            protocol,
            ...runScenario(rep, profile, pi, protocol, qi, scenario, si),
          });
        });
      });
    });
  }
  return { normal, failures };
}

// Combines the repetitions into mean and standard deviation
function aggregate({ normal, failures }) {
  const pick = (rows, f) => rows.filter(f);
  const normalAgg = [];
  for (const profile of CONFIG.profiles) {
    const r2 = pick(
      normal,
      (r) => r.profile === profile.name && r.protocol === "2PC",
    );
    const r3 = pick(
      normal,
      (r) => r.profile === profile.name && r.protocol === "3PC",
    );
    const overheadPct = r2.map(
      (x, i) =>
        ((r3[i].meanLatencyMs - x.meanLatencyMs) / x.meanLatencyMs) * 100,
    );
    const tpsDropPct = r2.map(
      (x, i) =>
        ((x.throughputTps - r3[i].throughputTps) / x.throughputTps) * 100,
    );
    normalAgg.push({
      profile: profile.name,
      latency2PC: summarize(r2.map((x) => x.meanLatencyMs)),
      latency3PC: summarize(r3.map((x) => x.meanLatencyMs)),
      txStd2PC: summarize(r2.map((x) => x.txStdMs)),
      txStd3PC: summarize(r3.map((x) => x.txStdMs)),
      p99_2PC: summarize(r2.map((x) => x.p99LatencyMs)),
      p99_3PC: summarize(r3.map((x) => x.p99LatencyMs)),
      tps2PC: summarize(r2.map((x) => x.throughputTps)),
      tps3PC: summarize(r3.map((x) => x.throughputTps)),
      latencyOverheadPct: summarize(overheadPct),
      throughputDropPct: summarize(tpsDropPct),
      messages2PC: r2[0].messagesPerTx,
      messages3PC: r3[0].messagesPerTx,
    });
  }

  const failureAgg = [];
  for (const scenario of SCENARIOS) {
    for (const profile of CONFIG.profiles) {
      for (const protocol of scenario.protocols) {
        const rows = pick(
          failures,
          (r) =>
            r.scenario === scenario.key &&
            r.profile === profile.name &&
            r.protocol === protocol,
        );
        failureAgg.push({
          scenario: scenario.key,
          profile: profile.name,
          protocol,
          affectedPerRun: summarize(rows.map((r) => r.affected)),
          pctCommitted: summarize(rows.map((r) => r.pctCommitted)),
          pctAborted: summarize(rows.map((r) => r.pctAborted)),
          pctBlocked: summarize(rows.map((r) => r.pctBlocked)),
          pctInconsistent: summarize(rows.map((r) => r.pctInconsistent)),
          meanRecoveryMs: summarize(rows.map((r) => r.meanRecoveryMs)),
        });
      }
    }
  }
  return { normalAgg, failureAgg };
}

// Prints the result tables
function printReport({ normalAgg, failureAgg }) {
  const line = "=".repeat(86);
  console.log(line);
  console.log(" 2PC vs 3PC simulator (virtual time, seeded)");
  console.log(
    `  participants=${CONFIG.participants}  tx/run=${CONFIG.transactionsPerRun}  repetitions=${CONFIG.repetitions}  baseSeed=${CONFIG.baseSeed}`,
  );
  console.log(
    `  jitter=±${CONFIG.networkJitter * 100}%  processing=${CONFIG.localProcessingMs} ms/round  detection timeout=${CONFIG.failureDetectionTimeoutMs} ms  election=${CONFIG.electionTimeoutMs} ms`,
  );
  console.log(
    `  throughput = ${CONFIG.concurrency} in-flight transactions / mean latency (no contention modelled)`,
  );
  console.log("  All values: mean ± sample std over repetitions");
  console.log(line);

  console.log(
    "\n--- Normal operation: latency (ms) and throughput (TPS) ---\n",
  );
  console.log(
    [
      "Profile".padEnd(14),
      "2PC latency".padEnd(16),
      "3PC latency".padEnd(16),
      "Overhead %".padEnd(14),
      "2PC TPS".padEnd(18),
      "3PC TPS".padEnd(18),
      "TPS drop %",
    ].join(""),
  );
  for (const r of normalAgg) {
    console.log(
      [
        r.profile.padEnd(14),
        fmt(r.latency2PC).padEnd(16),
        fmt(r.latency3PC).padEnd(16),
        fmt(r.latencyOverheadPct).padEnd(14),
        fmt(r.tps2PC, 0).padEnd(18),
        fmt(r.tps3PC, 0).padEnd(18),
        fmt(r.throughputDropPct),
      ].join(""),
    );
  }
  console.log(
    "\n--- Normal operation: dispersion across individual transactions (ms; std and p99 within a run, mean over repetitions) ---\n",
  );
  console.log(
    [
      "Profile".padEnd(14),
      "2PC std".padEnd(12),
      "2PC p99".padEnd(12),
      "3PC std".padEnd(12),
      "3PC p99".padEnd(12),
    ].join(""),
  );
  for (const r of normalAgg) {
    console.log(
      [
        r.profile.padEnd(14),
        r.txStd2PC.mean.toFixed(1).padEnd(12),
        r.p99_2PC.mean.toFixed(1).padEnd(12),
        r.txStd3PC.mean.toFixed(1).padEnd(12),
        r.p99_3PC.mean.toFixed(1).padEnd(12),
      ].join(""),
    );
  }
  console.log(
    `\nMessages per transaction (n=${CONFIG.participants}): 2PC = ${normalAgg[0].messages2PC}, 3PC = ${normalAgg[0].messages3PC}`,
  );

  const outcomeText = (a) => {
    const parts = [];
    if (a.pctCommitted.mean > 0) parts.push(`commit ${fmt(a.pctCommitted)}%`);
    if (a.pctAborted.mean > 0) parts.push(`abort ${fmt(a.pctAborted)}%`);
    if (a.pctBlocked.mean > 0) parts.push(`blocked ${fmt(a.pctBlocked)}%`);
    if (a.pctInconsistent.mean > 0)
      parts.push(`INCONSISTENT ${fmt(a.pctInconsistent)}%`);
    return parts.join(", ");
  };

  console.log(
    "\n--- Failure scenarios: outcome (share of affected transactions, WAN-Far profile) and recovery time from detection (ms) ---",
  );
  for (const scenario of SCENARIOS) {
    console.log(
      `\n${scenario.label}  [event probability ${scenario.probability * 100}%]`,
    );
    for (const protocol of scenario.protocols) {
      const a = failureAgg.find(
        (x) =>
          x.scenario === scenario.key &&
          x.protocol === protocol &&
          x.profile === "WAN-Far",
      );
      console.log(
        `  ${protocol}: ${outcomeText(a).padEnd(44)} recovery ${a.meanRecoveryMs ? fmt(a.meanRecoveryMs) + " ms" : "n/a (never resolves)"}`,
      );
    }
  }

  console.log("\n--- Recovery time by profile (ms, mean ± std) ---\n");
  console.log(
    [
      "Scenario / protocol".padEnd(52),
      ...CONFIG.profiles.map((p) => p.name.padEnd(16)),
    ].join(""),
  );
  for (const scenario of SCENARIOS) {
    for (const protocol of scenario.protocols) {
      const cells = CONFIG.profiles.map((p) => {
        const a = failureAgg.find(
          (x) =>
            x.scenario === scenario.key &&
            x.protocol === protocol &&
            x.profile === p.name,
        );
        return (a.meanRecoveryMs ? fmt(a.meanRecoveryMs) : "n/a").padEnd(16);
      });
      console.log(
        [`${scenario.key} / ${protocol}`.padEnd(52), ...cells].join(""),
      );
    }
  }
  console.log("\nDone.");
}

// Saves results.json and the two CSV files
function writeOutputs(raw, agg) {
  const dir = path.join(__dirname, "results");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "results.json"),
    JSON.stringify({ config: CONFIG, raw, aggregate: agg }, null, 2),
  );

  const n = (s, d = 3) => (s ? s.mean.toFixed(d) : "");
  const sd = (s, d = 3) => (s ? s.sd.toFixed(d) : "");
  const rows1 = [
    "profile,protocol,latency_mean_ms,latency_sd_ms,latency_min_ms,latency_max_ms,latency_ci95_ms,per_tx_sd_ms,p99_ms,tps_mean,tps_sd,messages_per_tx,overhead_vs_2pc_mean_pct,overhead_vs_2pc_sd_pct",
  ];
  for (const r of agg.normalAgg) {
    rows1.push(
      [
        r.profile,
        "2PC",
        n(r.latency2PC),
        sd(r.latency2PC),
        r.latency2PC.min.toFixed(3),
        r.latency2PC.max.toFixed(3),
        r.latency2PC.ci95.toFixed(3),
        n(r.txStd2PC),
        n(r.p99_2PC),
        n(r.tps2PC, 1),
        sd(r.tps2PC, 1),
        r.messages2PC,
        "",
        "",
      ].join(","),
    );
    rows1.push(
      [
        r.profile,
        "3PC",
        n(r.latency3PC),
        sd(r.latency3PC),
        r.latency3PC.min.toFixed(3),
        r.latency3PC.max.toFixed(3),
        r.latency3PC.ci95.toFixed(3),
        n(r.txStd3PC),
        n(r.p99_3PC),
        n(r.tps3PC, 1),
        sd(r.tps3PC, 1),
        r.messages3PC,
        n(r.latencyOverheadPct, 2),
        sd(r.latencyOverheadPct, 2),
      ].join(","),
    );
  }
  fs.writeFileSync(
    path.join(dir, "normal_operation.csv"),
    rows1.join("\n") + "\n",
  );

  const rows2 = [
    "scenario,profile,protocol,affected_per_run,committed_pct,aborted_pct,blocked_pct,inconsistent_pct,recovery_mean_ms,recovery_sd_ms,recovery_min_ms,recovery_max_ms",
  ];
  for (const a of agg.failureAgg) {
    rows2.push(
      [
        a.scenario,
        a.profile,
        a.protocol,
        n(a.affectedPerRun, 1),
        n(a.pctCommitted, 2),
        n(a.pctAborted, 2),
        n(a.pctBlocked, 2),
        n(a.pctInconsistent, 2),
        n(a.meanRecoveryMs, 2),
        sd(a.meanRecoveryMs, 2),
        a.meanRecoveryMs ? a.meanRecoveryMs.min.toFixed(2) : "",
        a.meanRecoveryMs ? a.meanRecoveryMs.max.toFixed(2) : "",
      ].join(","),
    );
  }
  fs.writeFileSync(
    path.join(dir, "failure_scenarios.csv"),
    rows2.join("\n") + "\n",
  );
}

// Entry point
function main() {
  const raw = runAll();
  const agg = aggregate(raw);
  printReport(agg);
  writeOutputs(raw, agg);
}

main();
