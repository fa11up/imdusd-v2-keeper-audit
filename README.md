# imdUSD v2 keeper

## Audit scope

This is the off-chain keeper for imdUSD v2, published for a public swarm audit. The contracts it runs against are the
public audit repository [github.com/imdusd/imdusd-v2-audit](https://github.com/imdusd/imdusd-v2-audit), fifth commit
(the wave-5 snapshot; its README gives the scope, trust model and known issues). The keeper is the beta's liveness: it
samples depth and proves the pool price on drift, buys and relays falling prices and the network-health index, ticks seat
auctions, marks and liquidates, and calls the Allocator's rule-driven actions. Since the fourth audit it also runs on
Robinhood Chain (4663), which launches with the beta on 12-07: one process per chain (`--chain 4663`), with the Pulse,
the 4663 IMD feeds, stock auctions, rate pokes and write-offs, and the bridge WATCHER (in both processes), which matches
`Sent` on one chain against `Received`, `Queued` and `PacketVerified` on the other, alerts the Safe's signers, and claims
honest queued transfers on its own chain once their delay has run (anyone may claim; the bridge has no guardian). This
second commit carries the wave-4 keeper fixes (the judge's proofs are kept as `test/w4-judge.test.mjs`) and the changes
made before audit wave 5 (one clock per comparison, proven-complete log ranges, verified-packet alerts, auto-claim
following the path's live delay and bulk-cancel cutoff, write-offs outside the Pulse grace). It holds NO on-chain rights: every call it makes is one
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
`DEPLOYMENT_4663`), Telegram messages headed `imdUSD v2 keeper [4663]`, and its own gas ceilings (urgent 1 gwei, routine 0.1 gwei; the tier
logic in `lib/tx.mjs` is unchanged). URLs may carry `${NAME}` placeholders filled from the environment (`BLOCKSCOUT_KEY`). It reads mainnet
through `PEERS[1]` (the IMD legs' pool, the plane payment, the bridge's other end) and never sends there.

| Loop | Every | What it does |
|---|---|---|
| `pulse` | 60 s | `Pulse.poke()` when nobody has for 8 min (gap 15); critical while in grace |
| `imdfeeds` | 120 s | The IMD type's swarm legs for consumer 4663: price + spot as one `oracle.group` on a fall only (Ethereum pool vs the 4663 Pricer), NHI daily while IMD debt exists. OFF until `IMD_FEEDS.buy` is true |
| `positions` | 60 s | Shared with mainnet. In a Pulse grace: marks only, never `bite`/`liquidate` (they would seize nothing). Stock positions under a running auction are left to it; `Liquidator.tick` at every open/close |
| `stocks` | 60 s | `StockJoin.tick(id)` while an auction runs, once its last read is 4 min old (`STOCKS.tickAfterSeconds` 240; the loop runs every 60 s, so a tick lands 4-5 min after the last read, inside StockJoin's 5 min `TICK_SPAN`), `cancel` when healed, `MarketHoursFeed.sync()` after a multiplier step, `Ledger.writeOff` (arm, 1 h, write off; clear when worth again) |
| `rates` | 15 min | `RateFeed.poke()` on a rise past 5 bps or 24 h |
| `peg`, `backstop`, `allocator`, `guardian`, `watch` | as mainnet | shared code; `watch` skips depth (none on 4663) |
| `bridge` | 120 s | Watcher, and AUTO-CLAIM of honest queued transfers on this chain (the ImdBridge inbound delay). Indexes `Queued`, `Claimed`, `ClaimCancelled`, `ClaimRestored`, `DelaySet` with the bridge's other logs; the queue is proven by the `received`/`queued` counters, the path's delay settings by `breakers()` at the block read through. A `Queued` that matches no `Sent` is critical `bridge-queued-forged-*` (naming `pause`, `cancelClaim` and the bulk `tighten` cutoff), raised long before it is claimable; it is never claimed. A matching one is claimed (`claim(srcEid, guid)`, routine tier, urgent past 1 h late) in the first pass after queuedAt + the path's delay read that pass (`breakers(srcEid).delay`: a lengthened or shortened delay applies to pending claims), unless the path is paused, the queue breaker tripped (critical `bridge-breaker-tripped-*`) or the bulk-cancel cutoff covers it (info `bridge-bulk-cancel-*`, no send until a SET_DELAY lifts it). No double send: the send journal is settled and read first, and `claims()` is read before each send. Report-only mode simulates and sends nothing. Also: a `Received` with no matching `Sent` (forgery) once the source chain is indexed through its head read after the Received (normally the next pass; no timestamps of the two chains are compared), else `unverified` after 30 min; a log range is marked read only when two reads agree and the bridge's own sent/received counters match it (`bridge-index-gap-*` otherwise), a packet VERIFIED at the destination endpoint (`PacketVerified`) with no matching `Sent` (critical `bridge-verified-forged-*`, saying whether it still waits at the endpoint: the Safe can then hold or void it before it runs; no window when it runs in the block it is verified), stuck transfers, held/voided payloads, paused paths, cumulative counters, the supply equation on each chain |

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
* **Two machines on one key.** Neither lock sees another machine; `foreignPending` sees only public pending sends.
* **Robinhood Chain (4663).** The 4663 process has run only in unit tests (fake chains and contract stand-ins); it has not
  run against a real 4663 deployment or fork. Not proven: a real plane attestation for a 4663 swarm leaf, 4663 L1 data
  gas on real sends, and stock auctions on real stock-token feeds.
* **The bridge watcher** has run only on fake logs (`test/rh-bridge.test.mjs`), not against a real DVN-verified transfer.
  It only alerts: paging the Safe's signers is NOT built, and the Safe's response (pause, hold, void) is by hand.
