# imdUSD v2 keeper

## Audit scope

This is the off-chain keeper for imdUSD v2, published for a public swarm audit. The contracts it runs against are the
public audit repository [github.com/imdusd/imdusd-v2-audit](https://github.com/imdusd/imdusd-v2-audit), the wave-5b
contracts snapshot (the commit after the wave-5 snapshot; its README gives the scope, trust model and known issues). The keeper is the beta's liveness: it
samples depth and proves the pool price on drift, buys and relays falling prices and the network-health index, ticks seat
auctions, marks and liquidates, and calls the Allocator's rule-driven actions. Since the fourth audit it also runs on
Robinhood Chain (4663), which launches with the beta on 12-07: one process per chain (`--chain 4663`), with the Pulse,
the 4663 IMD feeds, stock auctions, rate pokes and write-offs, and the bridge WATCHER (in both processes), which matches
`Sent` on one chain against `Received`, `Queued` and `PacketVerified` on the other, alerts the Safe's signers, and claims
honest queued transfers on its own chain once their delay has run (anyone may claim; the bridge has no guardian). The
second commit carries the wave-4 keeper fixes (the judge's proofs are kept as `test/w4-judge.test.mjs`) and the changes
made before audit wave 5 (one clock per comparison, proven-complete log ranges, verified-packet alerts, auto-claim
following the path's live delay and bulk-cancel cutoff, write-offs outside the Pulse grace). The third commit (wave 5b)
carries the fixes after the wave-5 keeper audit (the judge's proofs are kept as `test/w5k-judge-h{1,2,3,4}.test.mjs`), an
internal review of those fixes, the keeper's side of the wave-5b contracts and the 4663 urgent gas ceiling (see "What
changed since f30a9d0"). The fourth commit (wave 5b-2) carries the fixes from a review before wave 5b: the kill switch at every
send point, an alert lifecycle in which every key is cleared only by a read of its condition, one position-index refresh shared by
the lanes, the bridge incident wording (void is the response, a hold only delays) and a stock-feed silence alert (see "What changed
since c6603c7"). The fifth commit (wave 5b-3) carries the fixes from a second review before wave 5b: the stock-feed silence
alert redesigned on market-week time with per-ticker thresholds, STOP re-read right before a payment is signed and handed over, a
replay check before any void, and the bridge's final launch rule (see "What changed since 2b112f6"). It holds NO on-chain rights: every call it makes is one
anyone may make (the beta gives it no Allocator keeper role and no guardian key; the Safe is the Allocator's freezer).
It is REPORT-ONLY by default: without `--execute` it reads the chain and writes alerts and state, and sends nothing.
What a panel should attack first is the "Not proven" list at the end.

## Overview

The mainnet keeper for imdUSD v2. It is separate from the v1 keeper: the two must not share a key, a nonce queue or
state. Its duties are the operator duties the contracts leave to anyone (the audit repository's README, trust model).

Report-only by default. `--execute` needs `KEEPER_MNEMONIC` in the environment and private `SEND_RPC_URLS`; paying also needs `PLANE_BEARER`. Keys only from the environment. There is no guardian key: `GUARDIAN_PRIVATE_KEY` set is refused at start.

```bash
npm install
cp config.example.js config.js                # fill in RPCs; no keys here
cp <launch record>/beta.json deployment.json      # the deployment's addresses (lib/deployment.mjs reads it)
node keeper.mjs --once                        # one report-only round, on its own state in state/report/
node keeper.mjs --once --only depth,watch
node keeper.mjs --execute                     # sends
touch state/STOP                              # kill switch: every send and every payment refuses, no restart needed
node keeper.mjs --clear-lost                  # after a human has looked at a paid order the plane never admitted; stop the keeper first
```

`--execute` and `--clear-lost` hold `state/keeper.lock`: a second writer on the same state refuses to start. `--execute` also holds a lock named by the keeper's address in `KEEPER_LOCK_DIR` (default `~/.imdusd-v2-keeper/locks`): a second process on the same KEY refuses whatever its `STATE_DIR`, and `--execute` refuses to start while the mempool holds a nonce of the key that this state dir never signed (audit wave 4, P3). Another machine on the same key sending privately is not seen by either: run one keeper per key.

**Unreadable state fails closed** (audit wave 4, C9). `orders.json`, `imd-spend.json`, `feeds.json` and `tx/<nonce>.json` are never read as empty when they exist and cannot be read (garbled, torn, wrong shape, permissions): buying and sending stop, `state-unreadable` goes critical at once, and the file is never written over. A human inspects it, then fixes or removes it (removing `orders.json` forgets every order in it: check the chain first). Alerts, cursors, timers and the position index are moved aside (`<name>.unreadable-<time>`) and rebuilt. Every state write is temp + fsync + rename. A report-only run reads the chain and writes only under `state/report/`, so it can run beside a live keeper. Going from report-only to `--execute` starts on fresh state.

## Duties

| Loop | Every | What it does | Status |
|---|---|---|---|
| `depth` | 60 s, acts once per hour at a random second | `sample()` each DepthSampler and `ImdDepth.poke()` in one Multicall3 transaction; the poke is left out when it would write nothing. A reverting sampler is reported and left out, and the poke still goes. Late in a UTC day with no poke it goes urgent: a day without one reads as zero depth for a week | built |
| `positions` | 60 s | Position index from `Opened`, proven against each type's collateral total. `tick` on priced/unpriced changes. `liquidate`/`bite(id, minSeized)` when it can, `bark` when it cannot | built |
| `watch` | 5 min | Alerts: `unbacked`, unpriced type with debt, retire pending on a priced token, sampler age and buckets, depth falling, depth zero, edge debt in auction, keeper ETH | built |
| `feeds` | 60 s | Refresh rules 1-5, `lib/feeds.mjs` + `lib/orders.mjs`: the price (median) on a fall only, as one `oracle.request` (price design C: sIMD's spot is the pool's proven price, kept fresh by the depth round's prove-on-drift/age, never bought), only while a loan of >= 15 imdUSD would be under mat + 10% at the pool price; never a rise; NHI daily while sIMD debt exists; a fall wider than the leaf's allowance is still bought (the leaf clamps it; `feeds-walking`), and a leg short of its last answer raises `feeds-not-converged-*` (sIMD lends nothing until it converges); pays from the keeper's own IMD, relays with `submitAttestation`. Empty leaves are never bought | built; plane side only against a mock |
| `seats` | 5 min | `SeatFeed.poke`, `SeatJoin.tick(id)` after a median, `reopen`/`cancel` on void or healed auctions, both legs daily once the type is open with seats or debt | built; plane side only against a mock |
| `peg` | 5 min | `PegHook.sweep`, `withdraw`, `provide` at the hook's own gates, routine gas tier | built |
| `backstop` | 5 min | Room alerts per sleeve and type (`bidRoomNow`); `realize` at once when a retired token is priced again | built |
| `allocator` | 5 min | Keeper role: `sellForBackstop` for each configured sale, `fundBuffer` if configured. Rules (no role, on unless `ALLOCATOR.rules` is false): `startAuction` for collateral a sleeve holds (restart at once when new collateral arrives, which stops the run's price, or after an hour at the floor; warns when a holding has not fallen for 12 h), then `topUpBuffer`, `rebalanceVault` per asset with an auto vault, `rebalanceLp`, each only when its simulation finds work. The keeper never buys at the auction. Swap and return-to-Treasury are NOT built | built; rules act only once the Safe sets their targets |
| `guardian` | 60 s | Conditions -> a critical `guardian-freeze-now` alert: the Safe freezes the Allocator. Holds no key, sends nothing (below) | built |
| `bridge` | 120 s | Only with `BRIDGE_WATCH.enabled` (on in `config.example.js`). The same watcher and auto-claim as on 4663 (below), claiming the transfers queued ON MAINNET (4663 -> mainnet above the path's instant cap): only this keeper can claim there. Idle until the deployment record names a `bridge`. A record with a bridge and the watcher off raises critical `bridge-watch-off` at startup | built; no fork test |

There is no bridge guardian (the Safe pauses, holds, voids and cancels); the bridge watcher runs in both keepers, and 4663 `writeOff` is in the Robinhood keeper below. The LoopVault keeper is after the beta and not here.

## Robinhood Chain (4663), 12-07

`node keeper.mjs --chain 4663` runs the 4663 keeper: one process per chain, one shared config file (`CHAINS[4663]` overrides the top
level over `lib/chains.mjs` CHAIN_DEFAULTS; why one process per chain is in that file's header). With no `--chain` the process is the
mainnet keeper exactly as before. The 4663 process has its own state dir (`state-4663/`), its own key (`KEEPER_MNEMONIC_4663`; the per-key
lock and a check refuse the mainnet key), env names with a `_4663` suffix (`READ_RPC_URLS_4663`, `LOG_RPC_URLS_4663`, `SEND_RPC_URLS_4663`,
`DEPLOYMENT_4663`), Telegram messages headed `imdUSD v2 keeper [4663]`, and its own gas ceilings (urgent 10 gwei, routine 0.1 gwei; the tier
logic in `lib/tx.mjs` is unchanged). URLs may carry `${NAME}` placeholders filled from the environment (`BLOCKSCOUT_KEY`). It reads mainnet
through `PEERS[1]` (the IMD legs' pool, the plane payment, the bridge's other end) and never sends there.

| Loop | Every | What it does |
|---|---|---|
| `pulse` | 60 s | `Pulse.poke()` when nobody has for 8 min (gap 15); critical while in grace |
| `imdfeeds` | 120 s | The IMD type's swarm legs for consumer 4663: price + spot as one `oracle.group` on a fall only (Ethereum pool vs the 4663 Pricer), NHI daily while IMD debt exists. OFF until `IMD_FEEDS.buy` is true |
| `positions` | 60 s | Shared with mainnet. In a Pulse grace: marks only, never `bite`/`liquidate` (they would seize nothing). Stock positions under a running auction are left to it; `Liquidator.tick` at every open/close |
| `stocks` | 60 s | `StockJoin.tick(id)` while an auction runs, once its last read is 150 s old (`STOCKS.tickAfterSeconds` 150, was 240: wave-5 audit #18; the loop is scheduled from its pass's start, so with up to 90 s of other work in a round a tick still lands inside StockJoin's 5 min `TICK_SPAN`; a read found older than that at its tick raises warn `stocks-tick-late-*`), `cancel` when healed, `MarketHoursFeed.sync()` after a multiplier step, `Ledger.writeOff` (`StockVault.worthless()`: arm, a reading every 10 min, write off after 1 h; clear when no longer worthless) |
| `rates` | 15 min | `RateFeed.poke()` on a rise past 5 bps or 24 h |
| `peg`, `backstop`, `allocator`, `guardian`, `watch` | as mainnet | shared code; `watch` skips depth (none on 4663) |
| `bridge` | 120 s | Watcher, and AUTO-CLAIM of honest queued transfers on this chain (the ImdBridge inbound delay). Indexes `Queued`, `Claimed`, `ClaimCancelled`, `ClaimRestored`, `DelaySet` with the bridge's other logs; the queue is proven by the `received`/`queued` counters, the path's delay settings by `breakers()` at the block read through. A `Queued` that matches no `Sent` is critical `bridge-queued-forged-*` (naming `pause`, `cancelClaim` and the bulk `tighten` cutoff), raised long before it is claimable; it is never claimed. A matching one is claimed (`claim(srcEid, guid)`, URGENT tier from maturity: wave-5 audit #17; `claimUrgentSeconds` > 0 restores a routine first period; a claim the send guard skips raises warn `bridge-claim-late-*` with the reason in that pass) in the first pass after queuedAt + the path's delay read that pass (`breakers(srcEid).delay`: a lengthened or shortened delay applies to pending claims), unless the path is paused, the queue breaker tripped (critical `bridge-breaker-tripped-*`) or the bulk-cancel cutoff covers it (info `bridge-bulk-cancel-*`, no send until a SET_DELAY lifts it). No double send: the send journal is settled and read first, and `claims()` is read before each send. Report-only mode simulates and sends nothing. Also: a `Received` with no matching `Sent` (forgery) once the source chain is indexed through its highest head read `BRIDGE_WATCH.peerLagSeconds` (600 s) after the Received was first indexed (wave-5 audit #1: a source RPC lagging up to that long plus the delivery time never makes an honest transfer forged; the price is up to 10 min more before a forgery-by-absence is named; no timestamps of the two chains are compared), else `unverified` after 30 min; a log range is marked read only when two reads agree and the bridge's own sent/received counters match it (`bridge-index-gap-*` otherwise), a packet VERIFIED at the destination endpoint (`PacketVerified`) with no matching `Sent` (critical `bridge-verified-forged-*`, saying whether it still waits at the endpoint: the Safe can then hold or void it before it runs; no window when it runs in the block it is verified), stuck transfers, held/voided payloads, paused paths, cumulative counters, the supply equation on each chain |

The 4663 keeper pays for answers from ITS key's IMD on Ethereum; make its one Permit2 approval by hand (`IMD.approve(Permit2, 30 IMD)`
from that address on mainnet): the 4663 process alerts `feeds-permit2-unapproved` instead of sending it. The operator provides the 4663 key,
its IMD and ETH, the RPC URLs and the deployment record.

## Paying for answers (`lib/orders.mjs`)

Needs `PLANE_BEARER` (a random secret we make; the plane scopes orders to it) and IMD on the keeper's address; the keeper makes one capped Permit2 approval (`IMD.permit2Allowance`). No answer is bought unless every leaf's `expectedQuestionHash` equals the payload's question hash, the day's cap has room (`IMD.dailyCap`, 5 IMD, counted at payment; every order but a fall leaves `reserveForFalls`, re-checked at the moment of payment), the plane is healthy, and the keeper could afford to relay. A challenge asking more than 0.5 IMD a question, another asset or chain, an amount that does not divide over the questions, two different amounts, or a payee other than `PLANE.payTo` (the plane's own address, pinned in config: whoever answers as the plane must not choose who is paid) is refused unpaid.

**A crash never pays twice.** Each order's stage is in `state/orders.json`, written before the step. The stage `paying` and the day's spend are written BEFORE the signed payment leaves, and from then on the order is only ever polled. A paid order not admitted within `IMD.admissionTimeoutSeconds` becomes `lost`, raises a critical and holds ALL buying until the plane admits it, the chain proves the payment can never be taken, or a human runs `node keeper.mjs --clear-lost`. **Only the chain ends a signed payment unpaid** (audit wave 4, C8): the permit's Permit2 nonce and deadline are recorded with the latch, the deadline is at most `PLANE.maxPermitSeconds` (900 s) whatever the plane asks, and an order ends `unpaid` only when, at a block past that deadline, the nonce is unused. The plane's `expired` or `payment_failed` alone ends nothing; with the nonce used it holds as a paid refusal. A paid order the plane refuses (it keeps the payment) holds all buying the same way, so a refusal that repeats cannot spend the day's cap. So a crash in that gap costs a held keeper, never a second payment. An order still unpaid after `IMD.unpaidOrderMaxSeconds` is dropped, because its reason to buy and its guards have gone stale; the next round decides afresh, once the purpose's own wait since that order has run (`FEEDS.minSecondsBetweenFalls`, `FEEDS.minSecondsBetweenNhi`).

`bodies/` holds the frozen questions. Consumer, panel and quorum are set per purchase from the leaf; guards from the live band. A gap past the leaf's allowance is not bought: it raises `feeds-gap` and each round asks the leaf again.

## Guardian (`lib/guardian.mjs`)

No key. The Allocator's freezer is the Safe from genesis, and its four discretionary jobs are rule-driven, so nothing needs a fast key-held stop: when a condition holds, the guardian raises the critical `guardian-freeze-now` alert and a person has the Safe call `Allocator.freeze()`. Until then each action's daily bucket bounds a loss. Freezing stops every keeper and rule-driven action, moves nothing, and only the Safe undoes it. A proof read from the logs keeps alerting until the Allocator is frozen (or a person removes `state/guardian.json`). Conditions:

| Condition | Reads | Holds for |
|---|---|---|
| `unknown-actor` | an Allocator `Acted` from anyone but a known keeper or the governor (rule-driven calls emit `Ruled`, never `Acted`, so strangers using them are not this) | at once |
| `keeper-replayed` | an `Acted` from this keeper's address in a transaction its journal never signed (needs a shared state dir) | at once |
| `unknown-keeper` | `KeeperSet(k, true)` for an address not in `GUARDIAN.knownKeepers` | at once |
| `unbacked-braked` | `Ledger.unbacked()` > `unbackedBrake` x circulating | 2 min |
| `quote-depeg` | `PegHook.quoteSound()` false | 15 min |
| `simd-off-pool` | a fresh sIMD leg over 30% from the live pool | 15 min |

Not conditions, on purpose: the peg, a depth fall, stale feeds alone, gas. Those are market weather. Freezing the Allocator does not stop borrowing, liquidation or a wrong price reaching the Ledger: it only stops the Allocator moving funds.

## Guard rails (`lib/tx.mjs`)

Kill switch, gas ceiling and ETH floor per tier, simulate first, gas margin. One send holds the single queue for at most `SEND_WAIT_SECONDS`, then its intent stays open (below). Urgent work that finds a send open past `URGENT_WAIT_SECONDS` re-sends that same transaction with both fees 12.5% higher, on its own nonce, and goes out on the next nonce: a new action never takes an open send's nonce, so nothing is replaced and dropped. **What a nonce can cost is bounded** (audit wave 4, P3): nothing is ever signed above `MAX_GAS_GWEI` per gas, a new send goes out only while gas is under the tier's ceiling / 1.125 (89 gwei at 100) and offers no more than that, so a replacement always fits, a nonce gets at most `MAX_BUMPS` (4) replacements, and the last one (or the first, if the action would now revert) is a 0-value send to self that any relay includes. A nonce nothing more can be done for stops new work and raises critical `send-stuck`. Read RPCs more than `READ_MAX_SPREAD_BLOCKS` apart refuse every read; a common latest block older than `READ_MAX_LAG_SECONDS` raises `rpc-stale`; a loop failing `LOOP_FAIL_ALERT` passes in a row raises `loop-failing-<loop>`. Every read goes to all `READ_RPC_URLS` at one block and must
agree. Liquidations go only through `SEND_RPC_URLS`; `--execute` refuses to start without one.

**If the keeper holds imdUSD it spends it.** The caller path of a liquidation burns the keeper's imdUSD and hands it the collateral. With
none it only marks (and earns the chip), unless a sleeve's standing bid has room, which costs the caller nothing.

## Crash safety (`lib/journal.mjs`)

Every signed transaction is written to `state/tx/<nonce>.json` before it is broadcast and cleared once the chain settles that nonce. The next
send settles the journal first: mined clears it, an open one goes out again as the same signed bytes and new sends wait. Each step is appended to
`state/journal.jsonl`.

## What changed since 2b112f6

A second review before wave 5b found three places where the keeper could not meet the property the request states. Each was
reproduced first: every new test fails on the code of 2b112f6 and passes here. The keeper also follows the bridge's final launch
rule in the wave-5b contracts snapshot and the stock feeds' maxAge of 6 days there. `npm test`: 238 tests (229 at 2b112f6). Code
changed only in `lib/` (bridge, orders, stocks, and the `imdUSD.bridge()` read added to the usd ABI in deployment and robinhood).

* **`stocks-feed-silent-<type>`, redesigned** (`test/w5k-stock-feed.test.mjs`). The 2b112f6 design measured NYSE session time
  (25 h warn / 49 h critical); a SPY feed dead after Thursday 20:00 New York accrued only 19.5 session hours before its maxAge
  unpriced it, so no alert of any kind fired while it still priced, and no session-time threshold can be both quiet on the honest
  cadence (worst ~24 h) and early. Now the age is CALENDAR time inside the 24/5 MARKET WEEK the feeds print in (Sunday 20:00 to
  Friday 20:00 New York, DST from `Intl`; a weekday with no regular session per the MarketCalendar is closed from 20:00 the evening
  before). Thresholds are per ticker from the measured cadence (honest worst market-week age over 108 sessions): warn at
  max(1.5 x honest, honest + 1 h), critical at max(2 x honest, honest + 2 h), critical capped at 34 h and warn at least 4 h under it.
  SPY and AAPL 30/34 h, SGOV 29.9/34, TSLA 27.9/34, NVDA 13.1/17.4, USO 8.3/11, SPCX 7.2/9.6, CRCL 5.0/6.6, MSTR 4.1/5.4 (warn /
  critical); an unknown ticker uses SPY's. In any 144 calendar hours (the 6-day maxAge) at most 72 are closed (a weekend plus a
  holiday), so a dead feed is critical well before it unprices: 37.5 h earlier at the worst death time measured (Wednesday
  2026-11-25 10:00 New York, before Thanksgiving), scanning every hour of every week to the end of 2027. Cleared only by a pass that
  read a newer round. Config: `STOCKS.feedCadenceHours` (per-ticker honest worst, overrides), `STOCKS.feedCriticalCapHours` (34),
  `STOCKS.feedMaxAgeHours` (144, the contract's maxAge); `STOCKS.feedWarnHours` / `feedCriticalHours` from 2b112f6 are gone. The
  tests use the NYSE calendar of the contracts' `DeployConfig` (closed and early-close days, Thanksgiving with its Friday half day,
  Christmas 2026 on a Friday, New Year, MLK, Good Friday, July 4) and a heartbeat model (one print at 20:00 New York on the eve of
  each trading day, none before a holiday) as the honest cadence for the quiet tickers: SPY, AAPL and SGOV never alert over the
  model's span, each ticker's measured worst never alerts, and every ticker is critical at least 36 h before its maxAge dying at
  every hour of the closure weeks.
* **STOP inside a payment** (`test/w5k-stop.test.mjs`, +2). On 2b112f6 a `state/STOP` created during the allowance read still let the
  payment be signed and handed over. `stopped()` is now re-read right before `signPayment` and right before `plane.submit` (after the
  latch: the permit then expires unused and the chain ends the order unpaid); the send-site test requires a `stopped()` within the
  three lines before each of them.
* **Replay check before voiding** (`test/w5k-bridge-replay.test.mjs`). A void is by hash on every nonce and path, so voiding a forged
  REPLAY (a verified payload whose hash an honest `Sent` has at another nonce) would refuse the honest transfer too; on 2b112f6 the
  watcher advised "voidPayload(hash) NOW" for it. The watcher now looks for such a twin first: critical
  `bridge-verified-replay-<chain>-<nonce>`: do NOT void; `hold(eid, nonce)` now, then `RELEASE(eid, nonce, 0)`, a DROP, proposed
  within 24 h of the hold (the held payload never runs at that nonce; any other payload there runs as a claim). The held-forgery
  alert does the same for a held replay.
* **The bridge's final launch rule** (same test). The void sweep text, everywhere it appears (forged Received / Queued / verified,
  breaker), is PER NONCE: each stored payload against the peer's `Sent` at its own nonce; matching no honest `Sent`:
  `voidPayload(hash)`; a replay of an honest `Sent` from another nonce: hold + RELEASE(eid, nonce, 0), never void. The reopening list
  names SET_BRIDGE first (SET_BRIDGE, UNPAUSE, a SET_PATH, a SET_DELAY raising C). Before SET_BRIDGE inbound messages queue and
  a claim reverts in mint: the auto-claim reads `imdUSD.bridge()` and, while it does not name this bridge, sends no claim and raises
  info `bridge-not-wired-<chain>` (unreadable: warn, no claim); honest Queued messages are matched as usual and claimed in the first
  pass after the wiring and their maturity. Every other bridge view, event and the claim the keeper calls are unchanged.

## What changed since c6603c7

A review before wave 5b checked the request for this commit against the code and found four places where the keeper did less than
its README and the request said. Each was reproduced first: every new test below fails on the code of c6603c7 and passes here (bar
bridge case (d), which already held and is now pinned). The keeper also follows two changes in the wave-5b contracts snapshot (the
bridge incident rule and the stock feeds' 5-day maxAge). `npm test`: 229 tests (211 at c6603c7). Code changed only in the keeper
(`keeper.mjs`, `lib/`); config keys added: `STOCKS.feedWarnHours` (25), `STOCKS.feedCriticalHours` (49), both optional.

* **Kill switch at every send point** (P7, `test/w5k-stop.test.mjs`). On c6603c7 the bridge auto-claim settled the send journal
  under the send lock only (outside `act()`/`send()`), so an open intent was rebroadcast with `state/STOP` present, and
  `sendProvider`/`guardedSigner` signed and broadcast with STOP present when called directly. Now `lib/state.mjs stopped()` is checked
  at every choke point: the one broadcast path `sendProvider.sendTransaction` (new sends, replacements, cancels, rebroadcasts), the
  signer `guardedSigner.sendTransaction` (refused as a fee refusal, so `send()` returns it skipped and the skip alert speaks), the fee
  `bump`, `journal.settleIntents` (receipts are still read and settled; the rebroadcast is held and journalled `rebroadcast-held`) and
  `orders.pay` before anything is read or signed. A send-site fixture counts every `sendTransaction(`, `signTransaction(`,
  `_signTypedData(`, `rebroadcast(`, `.submit(`, `settleIntents(` and `act(ctx` in `keeper.mjs` + `lib/`, each annotated with its
  choke point: a new site fails the test until it is reviewed and added.
* **Alert lifecycle** (`test/w5k-alert-keys.test.mjs`). Every alert key is cleared only by a read of its own condition, by the module
  that owns it. On c6603c7: `feeds-permit2-unapproved` (raised by the feeds, seats and 4663 feed loops) was cleared only by the feeds
  loop's settle, on passes that never read the allowance, and on 4663 never; one `state-unreadable` key for every file was never
  cleared; `cannot-close-*` and the depth failure keys were never cleared; `send-skipped` was cleared by a routine landed send; order
  and answer keys were kept forever. Now: `feeds-permit2-unapproved` is cleared by an allowance read that covers the cost, from
  whichever loop asks; `feeds-order-*` / `feeds-answer-*` at the end of `advanceOrders` by its read of `orders.json` (lost: while a lost
  order stands; refused: while a held order of that purpose stands; unpaid: an event, cleared by the next read; answer-failed: while an
  open order has a failed child of that role); `state-unreadable-<file>` per file, cleared by the next good read of THAT file (any loop;
  a later failed read in the same pass keeps it); `cannot-close-<id>` settled by the positions pass, held for positions it did not read
  (an unpriced type's); the depth keys (`depth-sampler-reverted`, `-round-read-failed`, `-poke-failed`, `-proof-late`,
  `-proof-failed-<feed>`, `-prove-now-failed`) each by the success that answers it; `send-skipped` by a landed URGENT send only
  (`send-stuck` still by any landed send: the nonce moved, which is its condition); `bridge-watch-off` at a start whose config runs the
  watcher. The key fixture extracts every key raised in `keeper.mjs` + `lib/` (literal and template prefixes) and compares it with a
  list of ~120 keys, each naming the file that clears it, a literal that must exist there and the read that clears it: a new key with no
  clear path, a listed key no longer raised, or a vanished clear site fails the test.
* **One index refresh shared by the lanes** (`test/w5k-index.test.mjs`). On 4663 the positions (home), stocks and 4663 feed lanes each
  call `loadIndex`; on c6603c7 three concurrent calls each paged the Ledger's logs (every range read three times) and each wrote
  `index-<ledger>.json` across its awaits. Now `loadIndex` is single-flight on the context and `refreshIndex` single-flight per index
  file: callers share the refresh in flight; `resetIndex` refuses while a refresh of that file runs; each chunk is written atomically.
* **Bridge incident wording** (`test/w5k-bridge-r3.test.mjs`), following the wave-5b contracts snapshot. (a) The waiting-forged-packet
  alert no longer offers a hold as the equal of `voidPayload`: void is the response; a hold only DELAYS (when it ends the payload QUEUES
  for the path's delay D, and its claim must be cancelled within D); the held-forgery and held-honest texts say the same. (b) The forged
  Received, forged Queued, verified-forged and breaker alerts name the VOID SWEEP (void every stored payload no peer `Sent` matches)
  before ANY reopening (UNPAUSE, a SET_PATH, a SET_DELAY); the breaker procedure is pause -> cancelClaim the unmatched -> the sweep ->
  BATCH[RESET_BREAKER, UNPAUSE]. (c) The bulk cutoff named in every forged-Queued alert is the FIRST forged pending Queued's time on that
  path (it was the alerted Queued's own time, which let earlier forged claims through). (d) An honest held message that queues when its
  hold ends is matched to its `Sent` (no forged or stuck critical; `bridge-held` only while held) and auto-claimed after D: no code
  change was needed, the test pins it.
* **`stocks-feed-silent-<type>`** (`test/w5k-stock-feed.test.mjs`). The stock feeds' maxAge is now 5 days, so staleness no longer
  catches a dead feed. A type's Chainlink feed (the round time behind `MarketHoursFeed.latestValue`) silent more than
  `STOCKS.feedWarnHours` (25) hours of MARKET-SESSION time (MarketCalendar; weekends, holidays and closed hours do not count) is warn,
  more than `STOCKS.feedCriticalHours` (49) critical. Session time since the round is sampled from the calendar once per new round
  (every 30 min), then accumulated per pass while open (`state/stocks-feed.json`). Cleared only by a pass that read a NEWER round; a
  feed that answers 0 is warned as unreadable. The test drives a measured cadence (one print per session at a random time, a quarter of
  them just after the close, as SPY's quietest days: within 24 h of session time) for 4 weeks without an alert; a feed that stops warns
  past 25 h and goes critical past 49 h of session time, and clears on the next round.

## What changed since f30a9d0

The wave-5 keeper audit ran on f30a9d0 (judge and four specialists, job 76be5a3d: 4 high, 10 medium, 10 low, 1 info). In
this README and in the code comments, `wave-5 audit #N` is the Nth finding of that job's JUDGE submission, in its order
(#1-#4 high, #5-#14 medium, #15-#24 low, #25 info). Every finding was reproduced first: each finding's property test fails on
the code of f30a9d0 for the reason the judge gives and passes here; the judge's own proofs for #1-#4 are kept as
`test/w5k-judge-h{1,2,3,4}.test.mjs`. An internal review of the fixes followed (its cases are `test/w5k-audit-suite.test.mjs`
and `test/w5k-round3.test.mjs`), and the keeper was adapted to the wave-5b contracts snapshot. `npm test`: 211 tests (151 at
f30a9d0). The 4663 urgent gas ceiling is now 10 gwei (was 1: urgent pokes, ticks and claims were blocked above ~0.89 gwei).

* **Lanes, not one queue** (#3). `keeper.mjs runLanes`: the loops run in independent lanes, `pulse` (4663: the Pulse poke alone), `peer`
  (the loops that read the other chain: `bridge`, `imdfeeds`) and `home` (the rest). A slow or hanging peer RPC never holds the Pulse,
  stock ticks or bites. Sends stay one at a time across lanes (a send lock in `lib/act.mjs`). Each loop pass has a deadline
  (`LOOP_DEADLINE_SECONDS`, 240 s): past it, critical `loop-slow-<loop>` is raised WHILE the loop still runs. Every read RPC request
  has a 20 s timeout (`READ_TIMEOUT_SECONDS`) and no long 429 retry chain. A loop's next run is scheduled from its pass's start.
* **Bridge watcher** (#1, #2, #4, #5, #8, #10, #11, #14, #15, #22). Every alert is raised the moment it is judged (a later read that
  throws drops nothing). The PEER chain's reads are isolated: while its RPC does not answer, the home side is still indexed and judged
  on the saved peer index (a new transfer goes unverified at 30 min), honest matched claims are still sent, and critical
  `bridge-peer-unread-<peer>` names the outage. Standing alerts are settled only after a pass that read everything it judges; a failed
  `claims()`/`paused()` read keeps its alerts; a gap stands through a pass that read nothing. Logs are proven and kept per range, at most
  40 ranges / 60 s per pass (the next pass resumes); an unset `BRIDGE_WATCH.peer.fromBlock` is found from the peer bridge's code (needs
  an archive node; else critical `bridge-peer-fromblock-*`). Reorgs: the block hash of each proven range is kept (64 checkpoints); a
  replaced block rewinds the side to the newest matching checkpoint and reads again (warn `bridge-reorg-*`; critical when deeper than
  every checkpoint: the side is read again from its start). Verified packets are proven against EndpointV2's `inboundNonce` and
  `inboundPayloadHash`, not two reads of one node. Source bounds wait `peerLagSeconds` (600 s) of the keeper's own clock and take the
  highest head of the peer's RPCs; the counter check compares the peer's `sent()` with the destination's counters read at least that
  long before. The supply equation is read at one block. A mined claim in the journal is never sent again.
* **Bridge watcher, after the internal review.** A state file from before these fixes is migrated (its start from config, old
  bounds dropped and stamped again under the lag rule); a reorg past every checkpoint rewinds to the base snapshot, and one deeper than
  that KEEPS the index and raises critical `bridge-reindex-*` (re-index by moving `bridge-watch.json` aside). Home logs or counters that
  cannot be read are a gap (critical after 30 min). A head that does not move for `BRIDGE_WATCH.headStallSeconds` (600 s) is critical
  `bridge-head-stalled-*`. A head is capped at the first RPC's + `READ_MAX_SPREAD_BLOCKS`, and a bound above the current head is stamped
  again. A peer side whose start could not be found is not saved. The journal's "mined" holds a claim back for
  `BRIDGE_WATCH.minedTrustSeconds` (30 min) only. Alerts: an undelivered key is retried from `settle`; a never-delivered key clears
  without a Telegram "cleared"; a failed "cleared" is retried.
* **Keeper vs the wave-5b contracts snapshot** (internal review). Write-off: worthlessness is
  `StockVault.worthless()` (never `convertToAssets == 0`); while worthless and armed the keeper calls `writeOff` every
  `STOCKS.writeOffRecordSeconds` (600 s, measured from the chain's `Ledger.worthlessLast` when the Ledger has the getter, else from
  the keeper's own last call) so the wave-5b LedgerSettlement's chained readings (15 min `WRITEOFF_STEP`) reach the hour, then
  writes each position off; `clear` only when the custody is no longer worthless. The loop-slow watchdog repeats every deadline while
  a pass hangs. A new run of skipped sends after a quiet gap starts at warn. The bridge's journal settlement holds the send lock.
  `backstop-unpriced-legs-*` (warn) when `PricerOracle.priceOf` refuses a type whose legs disagree (prove the latest block or buy a
  median). UNCAPPED RateFeeds are not poked. A late stock tick stands an hour. `--only` naming no loop and a non-numeric
  `LOOP_DEADLINE_SECONDS` refuse to start. Stocks run in their own lane on 4663.
* **Price fixes after wave 5** (wave-5b contracts snapshot): price leaves no longer widen after a silence, so a median held above its last falling
  answer is walked on by ONE honest median per epoch while the type has debt (sIMD `feeds`, 4663 IMD `imdfeeds`; kind `walk`, a fall:
  the Treasury still never pays for rises). Warn `feeds-median-held` when the epoch's range high sits above its anchor while the median
  is held above a falling answer (an up value relayed first; if it persists, the operator response is the Safe's `lowerLine(SIMD, 0)`). When
  `PricerOracle.priceOf(sIMD)` is refused while the quote is priced: the pool within skew of the median = a pushed-up proof, proved
  at once (warn `feeds-simd-refused`); past skew = a rally, warn `feeds-simd-rally` only. `Backstop.retire` reverting `StillPriced`
  then is expected.
* **Config keys added in wave 5** (all optional): `LOOP_DEADLINE_SECONDS` (240, or `{ <loop>: s }`), `READ_TIMEOUT_SECONDS` (20),
  `SKIP_CRITICAL_SECONDS` (300), `LANE_MIN_SLEEP_MS` (1000: a lane's shortest sleep), `STOCKS.tickAfterSeconds` (150),
  `STOCKS.tickSpanSeconds` (300, StockJoin's TICK_SPAN), `STOCKS.writeOffRecordSeconds` (600), `BRIDGE_WATCH.peerLagSeconds` (600),
  `BRIDGE_WATCH.headStallSeconds` (600), `BRIDGE_WATCH.minedTrustSeconds` (1800), `BRIDGE_WATCH.claimUrgentSeconds` (0: urgent from
  maturity), `BRIDGE_WATCH.claimLateSeconds` (3600), `BRIDGE_WATCH.verifyNonces` (true), and the environment variable
  `KEEPER_LOCK_DIR` (where the per-key lock and the key's chain binding live; default `~/.imdusd-v2-keeper/locks`).
* **Sending** (#9, #13, #16, #17). Nothing is signed unless it is an EIP-1559 transaction under the tier's ceiling (no base fee: the send
  is skipped, never signed at `eth_gasPrice`). A due URGENT send the guard skips (gas, ETH floor, open send, STOP, a refused fee) raises
  warn `send-skipped` with the reason, critical after `SKIP_CRITICAL_SECONDS` (300 s), cleared by the next send that lands. The 4663 key
  is compared with the mainnet key by ADDRESS, and a key is bound to its chain on this machine (`<address>.chain` in the key-lock dir).
* **Orders** (#12, #23, #24). An admission that does not fit the questions paid for is a paid refusal (critical, all buying held); a
  plane answer that cannot be read never keeps a paid order out of the admission timeout. Permits are never signed for more than 900 s,
  whatever `PLANE.maxPermitSeconds` says. A 402 challenge must name this order's action and `/requests/<order>/submit` resource.
* **Duties** (#18, #19, #20). A close that simulates seizing 0 is never sent (marked instead). `bridge-watch-off` is decided from what
  will run (loops after `<NAME>_ENABLED` and `--only`, `autoClaim`), on both chains.
* **Alerts** (#7, #21). A key whose level rises (warn -> critical) fires at once; a Telegram delivery that fails (or is not accepted) is
  retried on the next raise of the key.

## Alerts

Log and `state/alerts.jsonl` always; Telegram when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set. Each key repeats while it holds
(critical hourly, warn every 6 h, info daily) and says when it clears. A loop clears only alerts it raises itself, and only after reading the condition: a read that fails keeps the standing alert (and raises an `-unread` one). The plane-health hold rests only on settled requests from the last `PLANE.blockedMaxAgeSeconds` (6 h) and goes critical after `PLANE.holdCriticalSeconds` (2 h). A fall is measured against `Pricer.quote().low` as read on chain (unpriced: the stored median), never a re-derivation of it.

## Tests

```bash
npm test               # the decision logic, no chain
npm run fork:up        # deploys the real beta on a local anvil fork through the contracts' launch.sh (V2=<checkout>, FORK_URL=<archive RPC>)
npm run fork:e2e       # the keeper against those contracts; restores the fork after (VERBOSE=1 for its log)
```

`npm run fork:up` needs `V2` set to a contracts checkout that has the launch tooling (`deploy/mainnet/launch.sh`); the launch tooling is not part of the public audit repository this round, so the fork tests cannot be run from it alone. `npm test` needs nothing.

`npm run fork:e2e` runs `test/fork/e2e.mjs` then `test/fork/duties.mjs`. **`duties.mjs` runs a LOCAL mock plane (`test/lib/mock-plane.mjs`) and nothing else: no test reaches the real plane.**

### Proven on the real beta on a local fork

Every v2 contract is the deployed bytecode, except where listed under "Only against a mock". All five bodies hash to what the deployed leaves pin. The real `submitAttestation` takes the keeper's bodies (question binding, panel floors, window rules, epoch bound). Real 48 h timelocks for the Safe's setup. The standing bid on a real sleeve; a real seat through `liquidate`, `tick`, `poke`, `reopen`; `sweep`, `withdraw`, `provide` on the real hook and pool; `realize`; `Allocator.sellForBackstop` through `Backstop.sell` and `onBackstopSell`; the guardian's freeze alert, answered by the Safe's `freeze`.

### Only against a mock

* **The plane.** Quote, 402 challenge, admission, oracle reads and attestation shapes are written from plane master's source (0a4c1b6e), not observed from a paid order by this keeper. **No payment has been made by this code.** The x402 signatures match another production x402 sender's byte for byte for one test vector; that sender is the only evidence the signatures settle. IMD does not move in any test, so the Permit2 approval and settlement are unexercised.
* **A real panel.** Answers are chosen by the test. Nobody has checked that a real panel agrees at quorum on these bodies through `oracle.group` in v2's windows, or that its answers land inside the guards the keeper pins.
* **The attester.** Each leaf's `attester` immutable is patched to a local key on the fork, so the real attester's signature over a real v2 consumer has never been checked. v1's feeds take the same format.
* **Fork stand-ins.** ImdDepth is stubbed deep and sIMD's stored line written straight to storage (no week of samples, no 96 h raise). ETH/USD and USDC/USD are a mock aggregator. The IMD pool's price is written to its slot, so nothing was traded there. The sale route and imdUSD's $1 feed are test contracts: **none exists for production.**

### Not proven at all

* **The bridge watcher and auto-claim on a real chain.** Unit and property tests only, against fake chains serving real ImdBridge/EndpointV2 event encodings. No fork test runs the watcher or a claim against a deployed ImdBridge. The claim tests copy lib/tx.mjs's send rules (open-intent wait, urgent wait, settle, simulate) onto the real send journal module; they do not run tx.mjs itself.

* **Private send.** Fork tests send to anvil. A multi-RPC `READ_RPC_URLS` (the agreement path) was not run on these loops either.
* **Seat answers before buying.** A seat recipe is a full scan of sales, so unlike price, spot and NHI the leaf's `accepts` is not asked first: a refused seat answer can be bought (bounded by the day's cap and alerted).
* **The median projection.** It reads past blocks. On a non-archive read RPC it falls back to the pool, and a lagging median could then be bought and refused. Use archive RPCs in `READ_RPC_URLS`.
* **`SeatJoin.cancel`**, the `lost` -> admitted recovery and a paid-then-refused order run only in unit tests. Telegram delivery is not tested.
* **A long run.** Nothing here has run as a daemon for days, or on mainnet.
* **Audit wave 4 fixes on a fork**: unit and property tests only (`npm test`); the fork suites were not rerun on them. Not proven against a real chain: the Permit2 `nonceBitmap` read at one block (C8), the cancel replacing a real stuck transaction through a real private relay (P3), `foreignPending` on a real mempool.
* **sIMD liquidation after a real fall** waits on the median's epoch walk (20% an epoch, a paid answer each): a 40% fall takes ~3 epochs whatever the keeper does (wave 4 info, C5). The keeper can only start the walk.
* **Audit wave 5 fixes on a fork**: unit and property tests only, against fake chains. The fork suites (`e2e.mjs`, `duties.mjs`)
  pass on these fixes against the wave-5 fixed contracts but run with the bridge watcher OFF (no 4663 peer on a mainnet fork): no fork
  test covers the bridge watcher, auto-claim, the lanes or any 4663 duty (the stock write-off runs on a model of the wave-5b
  `LedgerSettlement.writeOff`). Not proven against a real chain: reorg rewind on a real 4663/mainnet reorg, `EndpointV2.inboundNonce` historical reads on the 4663 public RPC (no
  archive: the verified-nonce proof then falls back to the logs with warn `bridge-index-unchecked-*`), the deploy-block search on a
  non-archive peer, lanes under real RPC latency.
* **Changes since c6603c7 on a fork.** The kill switch, alert lifecycle and shared index changes passed the fork suites (`e2e.mjs`
  10/10, `duties.mjs` 28/28) against the wave-5b contracts snapshot. The bridge incident wording and `stocks-feed-silent-*` are unit
  and property tests only: the fork harness covers neither the bridge watcher nor the 4663 stocks loop (bridge off, mainnet beta).
* **Changes since 2b112f6 on a fork: none run.** They touch the 4663 stocks loop, the bridge watcher's alerts and claims, and the
  payment's STOP checks. The fork harness covers neither the bridge watcher nor the 4663 stocks loop (bridge off, mainnet beta) and
  pays no real plane: unit and property tests only.
* **The stock feed cadence.** The per-ticker thresholds come from about 5 months of measured prints (no Thanksgiving or Christmas week
  in the data); holidays and early closes come from the NYSE calendar model (the contracts' `DeployConfig`), and the quiet tickers'
  honest cadence in the tests is a heartbeat model, not observed prints. A ticker added later starts on SPY's thresholds until
  measured; a busy ticker's thresholds are a few hours, so a genuine quiet spell longer than twice its measured worst warns.
* **Lanes are not fully independent.** They share one provider and its pin, and on 4663 one public rate-limited RPC: concurrency adds
  load there. The stocks and peer lanes read home logs through the shared index refresh, so a slow home log read holds them while
  they wait for it (bounded by `READ_TIMEOUT_SECONDS` per read; the loop deadline alert speaks).
* **The alert key fixture** proves that each key has a clear site (a literal that must exist in the owning file) and states the read
  that clears it; that the clear site's pass really read the condition is behaviour-tested only for the keys changed since c6603c7
  (permit2, orders/answers, state-unreadable, cannot-close, depth, send-skipped). The send-site fixture is a text search of the
  listed call forms: a send reached by another form would not be counted.
* **A source RPC lagging more than `peerLagSeconds` + the delivery time** can still make an honest transfer look forged (#1 residual):
  give the peer two RPCs (the highest head wins) or raise `peerLagSeconds` (it delays a forgery-by-absence verdict by as much).
* **Holds and voids on a lone log RPC**: `HoldPlaced`/`Voided` move no counter and the endpoint has no count of them; with one log RPC
  they are still "proven" by two reads of the same node (#11 residual; a hold/void counter on ImdBridge would close it).
* **The verified-nonce proof needs an archive-capable node.** `EndpointV2.inboundNonce` is read at past blocks; without archive state
  it falls back to the logs (warn `bridge-index-unchecked-*`).
* **`BRIDGE_WATCH.peer.fromBlock` must be set** in each production config to the peer bridge's deploy block. Unset, the watcher searches
  for it from the bridge's code, which needs an archive node; if the search fails it raises critical `bridge-peer-fromblock-*` and saves
  no peer side.
* **A re-index is a human step.** A reorg deeper than every kept checkpoint and the base snapshot keeps the index and raises critical
  `bridge-reindex-*`; re-indexing means moving `bridge-watch.json` aside. With ONE home RPC, `bridge-head-stalled-*` cannot tell a frozen
  RPC from a halted chain (both are raised as critical).
* **Rise medians are never bought.** During a long rally `PricerOracle` refuses sIMD (one-leg value) and sleeve conversions and sIMD
  sales wait for a median within skew; the keeper only alerts (`feeds-simd-rally`). The once-per-epoch walk of a held median is proven
  as a pure-function property and by the feeds suites, not by driving a whole silence on a fake leaf with the epoch range.
* **A write-off across a long Pulse grace.** The seizing `writeOff` reverts in the grace with its reading, so a grace longer than the
  contracts' 15 min `WRITEOFF_STEP` re-arms the hour; the keeper keeps recording and seizes an hour after the grace (said in the alert).
* **A liquidation pending past 60 s** can be sent a second time (it reverts on `minSeized`; gas only). Not changed.
* **Two machines on one key.** Neither lock sees another machine; `foreignPending` sees only public pending sends.
* **Robinhood Chain (4663).** The 4663 process has run only in unit tests (fake chains and contract stand-ins); it has not
  run against a real 4663 deployment or fork. Not proven: a real plane attestation for a 4663 swarm leaf, 4663 L1 data
  gas on real sends, and stock auctions on real stock-token feeds.
* **The bridge watcher** has run only on fake logs (`test/rh-bridge.test.mjs`), not against a real DVN-verified transfer.
  It only alerts: paging the Safe's signers is NOT built, and the Safe's response (pause, hold, void) is by hand.
