# Trade Distribution Audit — Phase 6.2

Research only. No code, schema, or deployment changes were made as part
of this task.

**Snapshot taken:** 2026-07-07 16:40:02 UTC
**Data source:** production `trades` table (`vltrade` Postgres DB), queried directly via `psql`.
**Trades in snapshot:** 952, covering 2026-07-06 23:04:21 UTC → 2026-07-07 16:39:48 UTC (~17.6 hours of continuous ingestion).
**Distinct wallets in snapshot:** 458.

Caveat that applies to every section below: this is ~17.6 hours of a
single continuous ingestion run, not a mature multi-day dataset. The
proportions (noise vs. signal) are a real read of *this* window, but
should be re-checked once the feed has run for several days across
different market/volatility conditions before treating the recommended
threshold as final.

---

## 1. Trade size distribution

| Bucket | Trades | % of Trades | USD Volume | % of Volume |
|---|---:|---:|---:|---:|
| <$5 | 230 | 24.13% | $969.31 | 1.35% |
| $5–10 | 239 | 25.08% | $1,818.71 | 2.54% |
| $10–20 | 145 | 15.22% | $2,147.85 | 3.00% |
| $20–50 | 154 | 16.16% | $5,348.22 | 7.47% |
| $50–100 | 78 | 8.18% | $6,090.16 | 8.50% |
| $100–250 | 56 | 5.88% | $9,095.95 | 12.70% |
| $250–500 | 23 | 2.41% | $8,041.14 | 11.23% |
| $500–1000 | 12 | 1.26% | $9,468.13 | 13.22% |
| >$1000 | 16 | 1.68% | $28,628.55 | 39.98% |
| **Total** | **952** | **100%** | **$71,608.02** | **100%** |

**Read:** the bottom three buckets (everything under $20) are **64.4%
of all trades** but only **6.9% of all volume**. The top bucket alone
(>$1000, just 16 trades) is **40% of all volume**. Trade *count* and
trade *volume* are almost inversely distributed — most activity is
tiny, most money is concentrated in a small number of large trades.

---

## 2. Wallet quality by trade size

| Bucket | Unique Wallets | Avg Trades/Wallet | Median Trades/Wallet | Max Trades (1 wallet) |
|---|---:|---:|---:|---:|
| <$5 | 125 | 1.84 | 1 | 14 |
| $5–10 | 132 | 1.81 | 1 | 19 |
| $10–20 | 108 | 1.34 | 1 | 6 |
| $20–50 | 115 | 1.34 | 1 | 7 |
| $50–100 | 64 | 1.22 | 1 | 6 |
| $100–250 | 44 | 1.27 | 1 | 3 |
| $250–500 | 18 | 1.28 | 1 | 3 |
| $500–1000 | 9 | 1.33 | 1 | 3 |
| >$1000 | 12 | 1.33 | 1 | 3 |

**Read:** this is the opposite of the hypothesis "larger trades come
from repeat traders." Median trades-per-wallet is **1 in every single
bucket** — no bucket is dominated by repeat activity. If anything, the
two smallest buckets (<$5, $5–10) have the *highest* average trades per
wallet (1.8+) and the two highest single-wallet repeat counts in the
whole dataset (14 and 19 trades by one wallet each) — consistent with
small, frequent, possibly automated/bot-like trading rather than
organic one-off activity. Trades over $100 are made almost exclusively
by wallets appearing only 1–3 times.

**Conclusion:** trade size and wallet repeat-count are not correlated
in the way that would let you use "repeat wallet" as a stand-in for
"real/quality trade." Filtering has to operate on trade size directly,
not on wallet frequency.

---

## 3. Repeat appearance analysis

| Trade count per wallet | Wallets | Trades contributed |
|---|---:|---:|
| 1 trade | 263 | 263 |
| 2 trades | 104 | 208 |
| 3–5 trades | 69 | 247 |
| 6–10 trades | 16 | 115 |
| 11–20 trades | 3 | 38 |
| 20+ trades | 3 | 82 |
| **Total** | **458** | **952** |

- 263 of 458 wallets (57.4%) have been observed exactly once.
- **% of total volume from single-trade wallets: 37.71%** ($27,003.67 of $71,608.02).

**Read:** single-trade wallets are a majority of *wallets* (57%) but
much less than half of *volume* (38%) — and the top-volume table below
shows several of the largest trades in the whole dataset (e.g. a single
$4,491.60 trade, a single $3,843.19 trade) come from wallets seen only
once. So "only traded once" does **not** mean "noise" — some one-off
trades are the single most significant trades in the dataset. This
reinforces the section 2 conclusion: filter on trade *size*, not on
wallet repeat count. A repeat-count-based filter would incorrectly
suppress large one-shot whale trades.

---

## 4. Top wallets by observed activity

Smart Score coverage note: `wallet_score_snapshots` currently has
snapshots for 258 of 458 distinct trading wallets, but only 63 of those
258 overlap with wallets that have actually traded in this window's
`trades` table, and of those, all but one hard-code to `score = 0,
tier = unknown` (one wallet at `score = 1, tier = weak`). In practice
**Smart Score is not yet discriminating** for this dataset — almost
every wallet that has one is scored `unknown`/0, most likely because
the scoring job's `sample_size` gates require history the wallets
don't have yet after only ~17.6 hours of ingestion (see
`docs/smart-score.md` §1 on the "1 lucky trade" gate). Scores are shown
where present; blank means no snapshot exists at all for that wallet.

### Top 30 by trade count

| Wallet | Trades | Volume (USD) | First Seen | Last Seen | Score | Tier |
|---|---:|---:|---|---|---:|---|
| GzZuM3NoL7Md73xC3RaTNs3zu6VcCdN6q9uJdtcWYAQz | 32 | $215.34 | 2026-07-07 16:00:39 | 2026-07-07 16:32:55 | — | — |
| GKa5bz8UVsMz5d4HygNDnQF7HNxDhxCzQTB1FsZ2ZHF | 28 | $282.34 | 2026-07-07 14:46:32 | 2026-07-07 16:38:30 | — | — |
| 242FNLrznRw4c4JnkRwJuDj9aSZg1Nqn2YavgXipzaxN | 22 | $851.06 | 2026-07-07 14:36:35 | 2026-07-07 15:30:33 | 0 | unknown |
| 5YHpo64ZjN7LMm4U6VCkP3JbtjLKqokzJV9nY8d6ad6A | 15 | $142.64 | 2026-07-07 14:41:39 | 2026-07-07 16:29:03 | — | — |
| BKPWo5GigsbyRavc78RLFM29VDbBGFcdSGxrNuP6dZe7 | 12 | $70.90 | 2026-07-07 14:47:23 | 2026-07-07 16:33:32 | — | — |
| 7Eofe1qMg2882qgfzs848htFw7xTR4bHomR8Sv8kgHCH | 11 | $626.00 | 2026-07-07 15:38:11 | 2026-07-07 15:46:42 | — | — |
| 42WPtnBLKgYFxpoZNA6JgS3JRJjf46p9V9Ay3QSs6f9y | 10 | $46.35 | 2026-07-07 15:14:03 | 2026-07-07 15:27:49 | — | — |
| 68qiNaQhZZtseVyitLvr3m7KBqFdqyBPSaFSTv1KEa2J | 9 | $42.48 | 2026-07-07 14:43:20 | 2026-07-07 15:48:17 | — | — |
| 7EAPXWFaQw8oewTf2Amq4Dc29CFMRpeCpsBAL2tRLq78 | 8 | $124.05 | 2026-07-07 15:42:11 | 2026-07-07 16:07:13 | — | — |
| BTSoxwydg1P3jWEyKiMxXmFP8vP2a2gTjgKDwJvYysxM | 8 | $57.23 | 2026-07-07 16:21:21 | 2026-07-07 16:32:20 | — | — |
| coFX96Yn4gc7JrSeNwW1QoWimGVLYkHi1MQzJBvvmht | 8 | $38.98 | 2026-07-07 15:29:06 | 2026-07-07 16:30:38 | — | — |
| DiVC7xL2sbPZh1F9u4Ub6FK3JmFsoyq5zksNTN3ueeEj | 7 | $61.43 | 2026-07-07 15:49:20 | 2026-07-07 16:23:28 | — | — |
| HmBpsKN3bnGaE9s9L9CkcRfmDebUnd1cNHNh6o8iFBLB | 7 | $132.27 | 2026-07-07 15:24:04 | 2026-07-07 16:23:58 | — | — |
| 91tw6fXhyBDCAMqsXKz5okbnSybVs33hAb18fy8EeCUo | 7 | $28.63 | 2026-07-07 14:57:43 | 2026-07-07 15:12:16 | — | — |
| 2UZ5JRkw1zRfay616Ef6LGF5cq8vyEGFsS6u6iq3hKia | 7 | $41.50 | 2026-07-07 16:06:53 | 2026-07-07 16:38:34 | — | — |
| JAJxkm4wfbMeGTwtutJeufv9CEKyge8akkYj8EMc8tmH | 7 | $85.44 | 2026-07-07 14:42:14 | 2026-07-07 15:44:03 | — | — |
| DeqAvCMfQqi8cDBY489emWVxpM6fuetcWX7CWTuA4pGK | 7 | $29.94 | 2026-07-07 14:39:16 | 2026-07-07 15:24:51 | — | — |
| 1gFwny25aqjbUjVjuqZj8dmUZZCxvVdRHZHj9VHH8KR | 6 | $56.25 | 2026-07-06 23:09:34 | 2026-07-07 16:39:48 | 1 | weak |
| BxfyDoLBCLKBaUxBM7PQRGEvoBDsdJQi4chpKpLj36Uh | 6 | $435.00 | 2026-07-07 15:53:42 | 2026-07-07 16:36:29 | — | — |
| ACDLMtXjgaMtSmWBHbbCxzR9fFuczKEMrAqNMSnCsAki | 6 | $55.92 | 2026-07-07 14:44:38 | 2026-07-07 16:39:20 | — | — |
| Av4eTap7zG25M9eNF294Xm2hSunbuEC9vUZybE2aDhbm | 6 | $84.89 | 2026-07-07 15:23:19 | 2026-07-07 15:39:31 | — | — |
| 91kJZv9ZkqxXxFUSpf21YgbQE1njRtWWZs3JM74jqkXj | 6 | $145.56 | 2026-07-07 14:47:48 | 2026-07-07 14:52:46 | — | — |
| Aviv8GboDaosPfCCfkdp2wJakMaZUijeuPjTvfmmZcy3 | 5 | $85.71 | 2026-07-07 16:09:32 | 2026-07-07 16:39:09 | — | — |
| 98UKCMtniNGFioNY8MHHoVYSLeSrAH8UkNKDJmukCreU | 5 | $21.22 | 2026-07-07 15:38:51 | 2026-07-07 15:41:58 | — | — |
| 64on59wTvekKz12iJbGxoGJXBFQpV452xgWNXp3CSVpR | 5 | $29.02 | 2026-07-07 15:56:38 | 2026-07-07 16:36:18 | — | — |
| 83y7dPzPJjKp2euub6HB11qgUYi1oN4NP4Wb36MFzXpB | 5 | $114.89 | 2026-07-07 16:18:56 | 2026-07-07 16:25:13 | — | — |
| Cph21ksAZe5FPCmmS2n4rTQgwX26wGfqL95LS9c4aDzW | 5 | $51.95 | 2026-07-07 15:37:45 | 2026-07-07 16:10:06 | — | — |
| A2MRap6CD68uUk8CLK7SPB8xrYwtCu6zPbVtaVA8RUfP | 5 | $343.54 | 2026-07-07 15:32:25 | 2026-07-07 16:19:08 | 0 | unknown |
| 36udx2p53NB2egUu2uHufjt2yRJifNXTz6KPxhqRNqfx | 5 | $1,490.00 | 2026-07-07 15:42:43 | 2026-07-07 16:33:40 | — | — |
| DtVQmiTfr17LPnQ69rgH5cBme2QR7rp5aQ21ejvHf6QD | 5 | $83.91 | 2026-07-07 15:47:48 | 2026-07-07 16:25:29 | — | — |

**Read:** the wallet with the most trades (32) has moved only $215.34
in total. Most of the highest-frequency wallets are moving small
amounts per trade — consistent with the bot/dust-trading signature
already seen in section 2.

### Top 30 by volume

| Wallet | Trades | Volume (USD) | First Seen | Last Seen | Score | Tier |
|---|---:|---:|---|---|---:|---|
| BFgeDrYdkXnNXFVQB3Cncn9teqsPJUS14gb7DBsSsYyk | 3 | $5,225.00 | 2026-07-07 16:33:20 | 2026-07-07 16:35:13 | — | — |
| 7tYircDX96eLHtCmEPuPikqReE4G66UoAZfKQ3soYADZ | 1 | $4,491.60 | 2026-07-07 16:21:56 | 2026-07-07 16:21:56 | 0 | unknown |
| Dwbn2Rkd86rdw2zADCeHmoaQ39jgru9cB47hEQhzaeJ8 | 3 | $4,102.23 | 2026-07-07 15:18:32 | 2026-07-07 16:22:26 | 0 | unknown |
| H2DJm3o1KuCj1SuDu49ipeEwZ8LUb58dXryNFBAa6ed | 1 | $3,843.19 | 2026-07-07 16:23:44 | 2026-07-07 16:23:44 | — | — |
| 9YSNwSryZShgk7npWrZh2cMc6Utd4aTXo1tvpyL9EcGb | 4 | $3,510.00 | 2026-07-07 16:05:00 | 2026-07-07 16:23:06 | 0 | unknown |
| 4P558MtYYLogd3uWQHoE4XC8fnTdcur6Lyc1qMxV7n7H | 4 | $1,947.62 | 2026-07-07 16:13:05 | 2026-07-07 16:32:01 | 0 | unknown |
| ETWoV6sDE6R7CMqaMqTu7jQM1bRpKzJcRW8JgrVKzvJF | 2 | $1,817.30 | 2026-07-07 16:01:06 | 2026-07-07 16:08:56 | — | — |
| CQUiELSzmSVfv154TVyBFUEBqo92nCGFqT8UXY1scyf6 | 2 | $1,748.60 | 2026-07-07 16:16:35 | 2026-07-07 16:17:40 | — | — |
| GyzBWrezeKniTYmPWPAJRkuYhSPrPunrZ7xYRd1ByMzJ | 4 | $1,736.35 | 2026-07-07 14:47:27 | 2026-07-07 16:34:45 | — | — |
| 7EeuoH6fxCHbeyFVhVWPAMVeXrN9wKs7P3qvehJGY1fc | 1 | $1,700.00 | 2026-07-07 15:46:58 | 2026-07-07 15:46:58 | 0 | unknown |
| AKfjA7dEpb8783fVkgzKdAQKUEucQixnqXaAEFFwvbaM | 2 | $1,600.00 | 2026-07-07 16:18:02 | 2026-07-07 16:32:55 | — | — |
| D7FtpuZLkPqzip3fvcCyojDnxxducQt1nTyfJELAt8eo | 1 | $1,500.00 | 2026-07-07 15:13:52 | 2026-07-07 15:13:52 | 0 | unknown |
| 36udx2p53NB2egUu2uHufjt2yRJifNXTz6KPxhqRNqfx | 5 | $1,490.00 | 2026-07-07 15:42:43 | 2026-07-07 16:33:40 | — | — |
| 3NuZ9Ntii5oyJUNiKoQKoCcYe46PJH5o2dMN4tNo4kGb | 2 | $1,130.82 | 2026-07-07 16:19:00 | 2026-07-07 16:24:13 | 0 | unknown |
| 5UnGbLjruEzZRq5SUNuL6ToymnDynztXJcDfF9UrcJcN | 1 | $1,045.36 | 2026-07-07 16:26:14 | 2026-07-07 16:26:14 | 0 | unknown |
| Cd3q3iyWZ5BwCCpL4xq9JFv6CetgECf2wBcn77HHRK7J | 2 | $1,026.45 | 2026-07-07 16:31:26 | 2026-07-07 16:35:07 | 0 | unknown |
| FoVSzZ2QXe7T8L7hexPwxxvFWxNqW1kGagT5UhuBihRc | 4 | $944.92 | 2026-07-07 16:13:31 | 2026-07-07 16:33:28 | — | — |
| 8mbPgUpWLMRFFryMXTLDYoebjnFc6sQSw4mBwXNjDyNR | 2 | $927.88 | 2026-07-07 16:10:01 | 2026-07-07 16:22:33 | 0 | unknown |
| 242FNLrznRw4c4JnkRwJuDj9aSZg1Nqn2YavgXipzaxN | 22 | $851.06 | 2026-07-07 14:36:35 | 2026-07-07 15:30:33 | 0 | unknown |
| FaVM6UzWUXQjp6JwoXHxAmqzAXEbrDZYjLio2RdyYqJs | 1 | $763.89 | 2026-07-07 15:38:09 | 2026-07-07 15:38:09 | 0 | unknown |
| 3QXJxixUAVkmDZEe9yueDbF999k9bMBdmwg7BBwiAtpN | 1 | $748.44 | 2026-07-07 16:38:12 | 2026-07-07 16:38:12 | — | — |
| 2VptbNFuUnZTJDy3rq5bsHiovaa5MStdnkWRMw2L6FGS | 3 | $697.66 | 2026-07-07 16:23:09 | 2026-07-07 16:37:40 | — | — |
| CmtmL5hE9ph3wRbDzXg7DU7pLSC6fScZ2YgGJzMwPAYG | 1 | $680.10 | 2026-07-07 16:29:33 | 2026-07-07 16:29:33 | 0 | unknown |
| 2U2Zta8nNkPiDir8TARBpEt5728DDnkq6BvCG4VKbAgW | 1 | $654.10 | 2026-07-07 16:30:16 | 2026-07-07 16:30:16 | — | — |
| 89za7Y7JMUAGLWNMv9QMS2sQy7DCLLsrj11XWhyGHKUH | 3 | $654.02 | 2026-07-07 16:21:09 | 2026-07-07 16:30:34 | 0 | unknown |
| 7Eofe1qMg2882qgfzs848htFw7xTR4bHomR8Sv8kgHCH | 11 | $626.00 | 2026-07-07 15:38:11 | 2026-07-07 15:46:42 | — | — |
| 6BZShRq64AehU2tY9jGUpAmdiUKRNgAmWgbzfeSZKisX | 4 | $601.20 | 2026-07-07 15:50:46 | 2026-07-07 16:36:34 | 0 | unknown |
| 5tYTBBhDbaKw9eJokNLNjtqm4sKworubxvsBWUgrZpLv | 2 | $598.81 | 2026-07-07 14:47:52 | 2026-07-07 16:14:29 | 0 | unknown |
| GYoZNJdwvuwPiGXPjMhTVf8XAeZn4gFUemPzs8565JsE | 1 | $499.00 | 2026-07-07 16:02:03 | 2026-07-07 16:02:03 | — | — |
| C4oF8d9QMT2Z7Yj1HxV9fLVAjDjikiHELqrdWWkvb1dL | 4 | $460.33 | 2026-07-07 15:51:56 | 2026-07-07 16:09:03 | — | — |

**Read:** the top-volume list is dominated by wallets with 1–4 trades
total, confirming section 3 — the largest dollar amounts in the
dataset are not coming from the most active/frequent traders.

---

## 5. Suggested minimum trade threshold

Cumulative effect of filtering out everything below a given USD
threshold, computed directly from the 952-trade snapshot:

| Threshold | Trades Removed | % Trades Removed | Volume Removed | % Volume Removed | % Volume Retained |
|---|---:|---:|---:|---:|---:|
| $5 | 230 | 24.13% | $969.31 | 1.35% | 98.65% |
| $10 | 469 | 49.27% | $2,788.01 | 3.89% | 96.11% |
| **$20** | **614** | **64.50%** | **$4,935.86** | **6.89%** | **93.11%** |
| $50 | 768 | 80.67% | $10,284.08 | 14.36% | 85.64% |
| $100 | 846 | 88.87% | $16,374.24 | 22.87% | 77.13% |
| $250 | 902 | 94.75% | $25,470.19 | 35.57% | 64.43% |

**Recommendation: $20.**

- $20 is the clear inflection point: it removes **64.5% of trade
  count** — nearly two-thirds of all noise — while giving up only
  **6.9% of total volume**. That's the best noise-to-signal trade-off
  in the table.
- $50 looks tempting (removes 80.7% of trades) but the marginal cost
  jumps sharply — it gives up an *additional* 7.5 points of volume
  (14.36% vs. 6.89%) to remove only 16 more percentage points of
  trades. That's a much worse trade-off per point of volume sacrificed.
- $100 clearly crosses into cutting real volume: 22.9% of volume gone
  is no longer "almost all meaningful volume preserved."
- The bucket table (section 1) independently supports the same cutoff:
  the <$5, $5–10, and $10–20 buckets (i.e., everything below $20)
  together are 64.4% of trades for 6.9% of volume — the same numbers,
  cross-checked from a different query.

$20 is the threshold that satisfies the brief's own framing ("removes
as much noise as possible while preserving almost all meaningful
volume") most literally: 93.11% volume retained is a defensible
reading of "almost all"; 85.64% ($50) or lower is not.

---

## 6. Recommendation

**Should the live feed filter by trade size? YES.**
Threshold: **$20.** Supported by section 5 — cuts 64.5% of trade
volume-of-noise (dust/bot-like trades per sections 1–2) while retaining
93.1% of dollar volume. Note this is a *feed noise floor*, not a wallet
quality filter — section 3 showed single-trade wallets still carry
37.7% of volume, so filtering must be on trade size, not on
observation count.

**Should Smart Money Signals ignore very small trades? YES,** with a
caveat.
Recommend the same $20 floor as a baseline noise floor for the
`smart_wallet_trade`/`market_consensus` detectors (`docs/smart-money-signals.md`
§2), which currently have no minimum trade-size gate at all — a
high-scoring wallet's $2 dust trade can trigger a signal today.
**Caveat, stated explicitly per the task's instructions:** Smart Score
itself is not yet usable to validate this recommendation with wallet
quality data — section 4 shows 240 of 258 scored wallets are
`tier=unknown, score=0`, and only 1 scored wallet in the entire top-30
activity list has a nonzero score. This is very likely because
`computeWalletScore`'s sample-size gate hasn't been satisfied yet after
only ~17.6 hours of data (see `docs/smart-score.md` §1), not because
real quality differences don't exist. Re-run this section once Smart
Score has meaningfully differentiated wallets before tuning a
smart-money-specific (as opposed to generic feed) threshold beyond the
$20 baseline.

The existing `whale_trade` detector's `whaleUsd` default ($1,000) is an
*upper*-bound "this is a big trade" signal and is unrelated to this
noise-floor question — no change to that value is implied here.

**Should Trending calculations ignore tiny trades? YES.**
Threshold: **$20**, same reasoning as the live feed — trending/volume
aggregates that don't filter dust will have 64% of their input rows
contributing under 7% of the real dollar signal, diluting whatever
weighting scheme trending uses today.

**What cannot be concluded from this data:** whether $20 remains the
right number once the dataset spans multiple days/market conditions,
and whether Smart Score-qualified wallets specifically need a *lower*
threshold than generic traffic (the data to answer that doesn't exist
yet — see caveat above). Both should be revisited once more ingestion
history accumulates.
