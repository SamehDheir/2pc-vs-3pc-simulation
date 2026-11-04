# 2PC vs 3PC commit-protocol simulator

Node.js simulator used for the paper *Comparative Study of 2PC and 3PC in Fintech Systems* (ICRE 2026).
It compares Two-Phase Commit (2PC) and Three-Phase Commit (3PC) in **virtual time** with fixed random
seeds, so it is fast and fully reproducible. It is a simulator, not a measurement of a production database.

## Run

```bash
node simulation.js
```

- No dependencies. Node.js 18 or newer.
- Runs in about one second and always prints the same numbers (fixed seeds).
- Prints the result tables to the console and writes the raw data to `results/`.

| File | Content |
|---|---|
| `results/results.json` | configuration, raw per-repetition values and aggregates |
| `results/normal_operation.csv` | latency (mean, SD, min, max, 95% CI), per-transaction SD and p99, TPS, messages |
| `results/failure_scenarios.csv` | outcome shares and recovery time per scenario, profile and protocol |

## Model

- One coordinator and 5 participants per transaction.
- A protocol round lasts as long as the slowest of *k* parallel one-way delays, plus 1 ms of local processing.
  Each one-way delay is drawn from `Uniform(mean × 0.8, mean × 1.2)`.
- Mean one-way delay per profile: LAN 10 ms, WAN-Near 30 ms, WAN-Far 50 ms, Cross-Region 100 ms.
- 2PC takes 2 rounds (prepare, commit); 3PC takes 3 rounds (can-commit, pre-commit, do-commit).
  A round sends one message to each participant: 10 messages per transaction for 2PC, 15 for 3PC.
- **Repetitions:** every configuration runs 10,000 transactions, repeated 5 times with different seeds
  (base seed 72026). Values are reported as the mean and the sample standard deviation across repetitions.
  The 95% confidence interval and the min/max of the repetition means are in the CSV files.
  The standard deviation and the 99th percentile across individual transactions are reported as well.
- **Throughput** is `100 transactions in flight / mean latency`. No contention is modeled, so this is a
  rescaling of latency and not an independent measurement.

## Failure handling

Outcomes are produced by applying each protocol's termination rule to the participant states, not assigned:

- **2PC (cooperative termination):** reachable participants compare states. A participant that never voted
  (INIT) or already aborted lets everyone abort. A committed participant lets everyone commit. If all are
  PREPARED, the group is blocked.
- **3PC (classical, timeout-based, no quorum):** after the election timeout (200 ms) the highest-ID alive
  participant becomes coordinator and collects states. Any ABORTED means abort. Any COMMITTED or PRE-COMMITTED
  means commit. If all are uncertain, abort.
- **Recovery time** is measured from the moment the failure is detected. The detection timeout (500 ms)
  is a parameter and is not included in it.

| Scenario | Event probability | Setup |
|---|---|---|
| S1 Coordinator crash in the first phase | 10% | 0 to 4 participants received the first-phase message |
| S2 Coordinator crash after all votes are YES | 10% | all participants PREPARED (2PC) or READY (3PC); nothing else sent |
| S3 Coordinator crash after PRE-COMMIT (3PC only) | 10% | all participants PRE-COMMITTED; do-commit not sent |
| S4 Participant crash before voting | 10% | one participant never answers; coordinator aborts the others after the detection timeout |
| S5 Network partition after all votes are YES | 30% | a minority of 1 to 2 participants is cut off; the majority finishes normally; the minority runs its own termination |

In each scenario a transaction is affected with the stated probability, and all metrics are computed over the
affected transactions.

## Main results (also in the paper)

- Failure-free, 3PC needs 50% more latency and 50% more messages than 2PC, which is +12 ms (LAN) to +114 ms (Cross-Region).
- S2: 2PC blocks in every affected transaction; 3PC aborts after 224 to 426 ms.
- S5: 2PC blocks the cut-off minority (decisions stay consistent); classical 3PC produces divergent decisions
  in every affected transaction.

## Configuration

All parameters are in the `CONFIG` object at the top of `simulation.js` (participants, transactions per run,
repetitions, seed, jitter, processing time, timeouts, event probabilities and network profiles).

## Limitations

- Virtual time with bounded uniform delays. No message loss, clock drift, disk behavior or lock contention.
- Outcome shares in the failure scenarios are 0% or 100% because each scenario fixes the participant states;
  only the timing varies between transactions.
- The partition scenario uses the classical 3PC termination rule without a quorum, so the isolated minority
  aborts while the majority commits (reported as `INCONSISTENT`). Quorum-based 3PC variants are not modeled.
- Participant crashes are modeled only before voting.

## Citation

If you use this code, please cite the paper:

> S. O. Dheir and A. Maghari, "Comparative Study of 2PC and 3PC in Fintech Systems," ICRE 2026.
