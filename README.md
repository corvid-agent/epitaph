# epitaph

A **dead-man's switch** on Algorand TestNet, published by
[Arcron](https://github.com/CorvidLabs/arcron) keepers. Sibling of
[arcron-beacon](https://github.com/corvid-agent/arcron-beacon) and
[plod](https://github.com/corvid-agent/plod); the original idea spec is
[arcron-beacon#4](https://github.com/corvid-agent/arcron-beacon/issues/4).

**Unaudited. TestNet only. Not deployed (appId = 0).** Deploy needs a
human's explicit go — see issue #1.

## What it does

The owner **arms** the switch with a timeout and **checks in** from time to
time. If `timeout_rounds` pass with no check-in, the next Arcron keeper call
to `publish()` flips the switch, permanently:

- `published` goes 1 and `revealed_round` records the round it spoke.
- State already holds a 32-byte **SHA-256 commitment** to the off-chain
  epitaph message. The message itself is *never* stored on-chain — the
  farewell stays private until the owner (or their heir) reveals it
  off-chain, and anyone can verify the reveal against the commitment.

Re-arming after publication is allowed (`arm` clears `published`), which
resets the switch for another silence window. Only the commitment hash ever
touches the chain — the message does not.

## The cadence note (read this before registering)

A dead-man's switch is only as responsive as its keeper. Publication happens
on the **first keeper call after expiry**, up to one upkeep interval late.

**Register interval must be `<<` `timeout_rounds`.** Recommended: upkeep
interval **7200 rounds ≈ 5.6 h** (at ~2.8 s/round) against a timeout floor
of **10000 rounds ≈ 7.8 h** (`arm` rejects anything lower). If the interval
ever approached the timeout, the switch could expire between two keeper
calls even while the owner is alive and checking in — the exact failure the
floor exists to prevent. In practice, give yourself margin: timeout several
times the interval.

## The traps this contract avoids

Read [docs/integrating.md](https://github.com/CorvidLabs/arcron/blob/main/docs/integrating.md)
in the Arcron repo first. Every one of these was learned the hard way:

1. **Zero create args.** A uint64 create_arg is how a sloppy deploy script
   confuses the keeper app id with a cadence and locks an interval at ~68
   years. `create()` takes nothing; the keeper is named once via
   `set_keeper`, the timeout via `arm`.
2. **Keeper auth is `Application(keeper).address`, never `itob`.** Arcron's
   inner call comes from the keeper *application account*. Comparing the
   sender against `itob(keeper_app_id)` compares 8 bytes to a 32-byte
   address and never matches.
3. **Fail soft after keeper auth.** A hook that rejects gets exponentially
   backed off by keeper bots and burns upkeep escrow on retries. After the
   two authorization asserts in `publish()`, every no-work path
   **returns 0** — not armed, not yet expired, already published, all of
   them. Nothing asserts once the keeper is authenticated.
4. **`set_keeper` is one-time, creator-only.** Set once after deploy,
   before registration; it cannot be re-pointed.
5. **Compile clean.** Verified: puyapy 5.10.1 compiles this contract with
   zero errors (artifacts committed under `smart_contracts/epitaph/out/`).
6. **Register interval << timeout_rounds.** See the cadence note above:
   7200-round interval, 10000-round timeout floor.

## State layout (global)

Declared order; keys are stored by name. Schema from the compiled arc56:
**5 uint64 + 2 byte slices**, no local state.

| slot | key                  | type           | meaning                                   |
| ---- | -------------------- | -------------- | ----------------------------------------- |
| 0    | `keeper_app`         | uint64         | Arcron keeper app id; 0 until `set_keeper` |
| 1    | `owner`              | address (32 B) | may `arm` / `commit` / `check_in`; creator |
| 2    | `last_checkin_round` | uint64         | last round the owner proved liveness      |
| 3    | `timeout_rounds`     | uint64         | silence that counts as death; 0 = unarmed |
| 4    | `published`          | uint64 (bool)  | 1 once the switch has fired               |
| 5    | `revealed_round`     | uint64         | round `publish` fired; 0 until then       |
| 6    | `commitment`         | bytes (32)     | SHA-256 of the off-chain epitaph message  |

Expiry round = `last_checkin_round + timeout_rounds`.

## ABI

Selectors are `sha512_256(signature)[:4]`, as compiled by puyapy 5.10.1.

| method                   | selector     | auth                    | notes                                   |
| ------------------------ | ------------ | ----------------------- | --------------------------------------- |
| `create()void`           | `0x4c5c61ba` | (create)                | zero create args, on purpose            |
| `set_keeper(uint64)void` | `0xc4c1d8f7` | creator, one-time       | ABI lowers `Application` to `uint64`    |
| `arm(uint64)void`        | `0xb6bd8fe7` | owner                   | timeout ≥ 10000; resets check-in + flag |
| `commit(byte[32])void`   | `0x80492573` | owner                   | stores the 32-byte SHA-256 commitment   |
| `check_in()void`         | `0x8fe25e05` | owner                   | resets `last_checkin_round`             |
| `publish()uint64`        | `0xbe0b2922` | keeper app account      | fail-soft; returns 1 the round it fires |
| `status()uint64`         | `0x77a7af15` | readonly                | rounds until expiry; 0 if expired       |

## Keeper registration recipe

Register an upkeep on the Arcron TestNet keeper app **769891898** via

```
register(pay,pay,uint64,byte[][],uint64,uint64,uint64,uint64,uint64,uint64)uint64
```

with:

- **target app** = the deployed epitaph app id; **call args** = the bare
  `publish()` selector (`0xbe0b2922`), ABI-encoded as `byte[][]`
  (10 bytes on the wire: count + offset + length + selector).
- **interval = 7200 rounds** (~5.6 h) — always `<<` the armed timeout.
- **fee per execution = 4000 µALGO**.
- **skip policy = 1 (SKIP_AHEAD)** — a missed call is harmless; death is
  computed from round arithmetic, not call counts. Never leave the zero
  default.
- **payment 1 = MBR**, to the keeper app address:
  `2500 + 400 × (139 + len(call_args))` µALGO → for the bare selector,
  `2500 + 400 × 149 = 62100` µALGO.
- **payment 2 = escrow**, to the keeper app address: **500000 µALGO**
  (125 executions at 4000 µALGO; top up before it runs dry).
- Both payments go to the **keeper app address** (escrow address of app
  769891898), not to epitaph.
- After registering, read the upkeep box `u` + `itob(upkeep_id)` **fresh**
  from the keeper app (indexer `/v2/applications/769891898/box?name=...`) —
  never trust a cached copy when checking `next_execution_round`.

Order matters: deploy → `set_keeper` → `arm` → `commit` → register, because
`publish` hard-asserts until the keeper is set (and fail-softs until armed).

## How a human deploys this later

**TestNet only. Never commit a mnemonic. Never deploy without the human go
(issue #1).**

1. Fund a throwaway TestNet account (dispenser). The mnemonic lives in
   env/CI secrets, never in git.
2. Compile: `puyapy smart_contracts/epitaph/contract.py --out-dir out`
   (or reuse the committed artifacts).
3. Deploy the app with **zero create args**. Record the app id.
4. Call `set_keeper` with keeper app **769891898** (creator-only, one-time).
5. Call `commit` with the SHA-256 of the off-chain epitaph message
   (owner-only).
6. Call `arm` with the timeout (≥ 10000 rounds; several× the upkeep
   interval).
7. Register the upkeep on keeper 769891898 per the recipe above (issue #2).
8. Set `"appId"` in `docs/deploy.json` — the board lights up on its own
   (issue #3).

## Layout

```
smart_contracts/epitaph/contract.py   the Puya (Algorand Python) source — the whole thing
smart_contracts/epitaph/out/          committed puyapy 5.10.1 artifacts (arc56 + TEAL)
docs/                                 GitHub Pages split-flap board (NOT DEPLOYED until appId > 0)
docs/deploy.json                      {"appId": 0, ...} — the board's single source of config
```

Compiled artifacts are committed here on purpose (unlike arcron-beacon) so
the reviewed bytecode hash is pinned in git.

**Pending:** the token that wrote this repo lacks the `workflow` scope, so
no Pages publish workflow is committed. **A human must enable GitHub Pages
from `/docs` on `main` in the repository settings** (Settings → Pages →
Source: Deploy from a branch → `main` `/docs`). A `pages.yml` copied from
[corvid-agent/plod](https://github.com/corvid-agent/plod) is welcome when a
suitably-scoped credential exists.

## Build locally

```bash
pip install puyapy==5.10.1
puyapy smart_contracts/epitaph/contract.py --out-dir out
```

Verified at authoring time: compiles clean on puyapy 5.10.1; global schema
5 uint64 + 2 byte slices; selectors as tabulated above. Mock-chain tests
cannot prove keeper integration (inner calls, MBR) — that belongs to a
LocalNet/TestNet e2e at deploy time.

## The board

`docs/` is a split-flap/CRT status board in the spirit of
[corvid-agent/arcron-beacon](https://github.com/corvid-agent/arcron-beacon)
and [corvid-agent/waddle](https://github.com/corvid-agent/waddle). While
`appId` is 0 it shows **NOT DEPLOYED**. Once `appId > 0` it reads the app's
global state from the public indexer
(`https://testnet-idx.algonode.cloud`) and flaps out ARMED / EXPIRED /
PUBLISHED, the countdown to `last_checkin_round + timeout_rounds`, the
commitment hash, and `revealed_round`. If the feed is unreachable it falls
back to the last good snapshot (marked STALE) rather than guessing.
Read-only, no wallet, no keys.

Unaudited. TestNet only. Not deployed.
