# 2PC vs 3PC commit-protocol simulator

Node.js simulator used for the paper *Comparative Study of 2PC and 3PC in Fintech Systems* (ICRE 2026).
It compares Two-Phase Commit (2PC) and Three-Phase Commit (3PC) in **virtual time** with fixed random
seeds, so it is fast and fully reproducible. It is a simulator, not a measurement of a production database.

## Run

```bash
node simulation.js
```

- No dependencies. Node.js 18 or newer. (Only the optional figure script `make_figure.py` needs Python with matplotlib.)
- Runs in about one second and always prints the same numbers (fixed seeds).
- Prints the result tables to the console and writes the raw data to `results/`.

| File | Content |
|---|---|
| `results/results.json` | configuration, raw per-repetition values and aggregates |
| `results/figure1.png` | figure drawn from `results.json` by `make_figure.py` |
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

## Results

All values are the mean ± sample standard deviation over 5 repetitions of 10,000 transactions each
(5 participants, seeds fixed). They are generated from `results/results.json`.

![Failure-free latency and recovery time](results/figure1.png)

*Figure 1. (a) Failure-free commit latency with the 99th percentile. (b) Recovery time after failure detection
(S1 for 2PC and S4 coincide). Redraw with `python3 make_figure.py` (needs matplotlib).*

### Failure-free commit latency and throughput

| Profile | 2PC latency (ms) | 3PC latency (ms) | Overhead (%) | 2PC TPS | 3PC TPS |
|---|---|---|---|---|---|
| LAN | 24.7 ± 0.0 | 37.0 ± 0.0 | 50.0 ± 0.0 | 4053 | 2703 |
| WAN-Near | 70.0 ± 0.0 | 105.0 ± 0.0 | 50.0 ± 0.1 | 1429 | 953 |
| WAN-Far | 115.3 ± 0.0 | 173.0 ± 0.1 | 50.0 ± 0.1 | 867 | 578 |
| Cross-Region | 228.7 ± 0.1 | 342.9 ± 0.1 | 50.0 ± 0.1 | 437 | 292 |

Throughput is `100 / latency`, so it carries no information beyond the latency ratio. Messages per commit: 10 (2PC) and 15 (3PC).

### Latency dispersion across individual transactions (averaged over repetitions)

| Profile | 2PC SD (ms) | 2PC p99 (ms) | 3PC SD (ms) | 3PC p99 (ms) |
|---|---|---|---|---|
| LAN | 0.8 | 25.9 | 1.0 | 38.7 |
| WAN-Near | 2.4 | 73.6 | 2.9 | 110.0 |
| WAN-Far | 4.0 | 121.4 | 4.9 | 181.3 |
| Cross-Region | 8.0 | 240.8 | 9.7 | 359.6 |

### Failure scenarios (WAN-Far profile; outcomes are identical in the other profiles)

| Scenario | Protocol | Outcome (affected tx) | Recovery (ms) |
|---|---|---|---|
| S1 Coordinator crash, first phase | 2PC | Abort (100%) | 57.0 ± 0.1 |
| S1 Coordinator crash, first phase | 3PC | Abort (100%) | 314.0 ± 0.3 |
| S2 Coordinator crash after all YES votes | 2PC | Blocked (100%) | never resolves |
| S2 Coordinator crash after all YES votes | 3PC | Abort (100%) | 314.1 ± 0.2 |
| S3 Coordinator crash after PRE-COMMIT | 3PC | Commit (100%) | 313.9 ± 0.1 |
| S4 Participant crash before voting | 2PC | Abort (100%) | 57.0 ± 0.0 |
| S4 Participant crash before voting | 3PC | Abort (100%) | 57.0 ± 0.1 |
| S5 Network partition | 2PC | Blocked (100%) | never resolves |
| S5 Network partition | 3PC | Divergent decisions (100%) | 252.6 ± 1.0 |

2PC never resolves S2 and the cut-off minority in S5. Outcome shares are 0% or 100% because each scenario fixes the participant states.

### Mean recovery time by profile (ms, measured from failure detection)

| Case | LAN | WAN-Near | WAN-Far | Cross-Region |
|---|---|---|---|---|
| S1, 2PC | 12.2 | 34.6 | 57.0 | 112.8 |
| S1, 3PC | 224.4 | 269.2 | 314.0 | 426.1 |
| S2, 3PC | 224.4 | 269.2 | 314.1 | 426.1 |
| S3, 3PC | 224.4 | 269.2 | 313.9 | 425.8 |
| S4, 2PC | 12.2 | 34.6 | 57.0 | 112.9 |
| S4, 3PC | 12.2 | 34.6 | 57.0 | 113.2 |
| S5, 3PC | 212.1 | 232.0 | 252.6 | 301.8 |

2PC has no recovery time in S2 and S5. The standard deviation across repetitions is below 1.6 ms in every cell.

**Summary.** Failure-free, 3PC needs 50% more latency and messages than 2PC (+12 ms in LAN to +114 ms in Cross-Region).
After a coordinator crash with all votes YES (S2), 2PC blocks and 3PC aborts after 224 to 426 ms. Under a partition (S5),
2PC keeps decisions consistent by blocking the minority, while classical 3PC produces divergent decisions in every affected transaction.

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
