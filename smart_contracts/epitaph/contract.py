# pyright: reportMissingModuleSource=false
"""EPITAPH — a dead-man's switch on Algorand TestNet.

The owner arms the switch with a timeout and checks in from time to time.
If `timeout_rounds` pass with no check-in, any Arcron keeper call to
`publish()` flips the switch: `published` goes 1, `revealed_round` records
the round, and the 32-byte commitment in state points at the off-chain
epitaph message the owner sealed beforehand. The message itself is never
stored on-chain — only its SHA-256 commitment — so the farewell stays
private until the owner (or whoever they gave it to) chooses to reveal it
off-chain, and the world can verify it against the commitment.

The keeper hook is fail-soft by design (see the traps list in README.md):

  * Zero-argument hook. `publish()` takes no args; Arcron supplies none.
    A keeper decides *when* publish runs, never *what* it says.
  * Authorization is Application(keeper).address — the sender of Arcron's
    inner call. Never compare against itob(keeper_app_id); that is 8
    bytes, not an address.
  * FAIL SOFT. A hook that rejects gets backed off by keeper bots (1, 2,
    4... intervals) until the schedule quietly stops and burns escrow on
    retries. After the two authorization asserts, every no-work path here
    RETURNS 0 — nothing asserts once the keeper is authenticated.
  * Zero create args. A uint64 create_arg is how a sloppy deploy script
    confuses the keeper app id with a cadence and locks an interval at
    ~68 years. There is nothing to pass at create; the keeper is named
    once via `set_keeper`, the timeout is set by the owner via `arm`.

CADENCE NOTE: the switch is only as responsive as its keeper. With an
upkeep interval of 7200 rounds (~5.6 h), publication happens on the first
keeper call after expiry — up to one interval late. The register interval
must be well under `timeout_rounds` (floor 10000 rounds); see README.md.

TestNet only. Unaudited. Not deployed (appId = 0 until a human deploys).
"""

from typing import Final, Literal

from algopy import (
    ARC4Contract,
    Account,
    Application,
    Bytes,
    Global,
    GlobalState,
    Txn,
    UInt64,
)
from algopy.arc4 import Byte, StaticArray, abimethod

# Smallest timeout `arm` accepts. 10000 rounds ~= 7.8 h at ~2.8 s/round.
# The floor exists so the timeout can never sit inside the keeper's own
# cadence: with the recommended 7200-round upkeep interval a shorter
# timeout could expire between two keeper calls even while the owner is
# faithfully checking in. Keep register interval << timeout_rounds.
MIN_TIMEOUT_ROUNDS: Final = 10000


class Epitaph(ARC4Contract):
    """Dead-man's switch, published by Arcron keepers after silence.

    TestNet only. Unaudited. Not a product.
    """

    def __init__(self) -> None:
        # App id of the Arcron keeper allowed to call `publish`. Zero until
        # `set_keeper`. Not an interval. Not a create arg.
        self.keeper_app = GlobalState(UInt64(0))
        # The account that may arm, commit, and check in. The creator at
        # create time; there is deliberately no transfer method.
        self.owner = GlobalState(Account())
        # Last round the owner proved liveness (set by `arm` / `check_in`).
        self.last_checkin_round = GlobalState(UInt64(0))
        # Rounds of silence that count as death. Zero = not armed.
        self.timeout_rounds = GlobalState(UInt64(0))
        # One-way flag: once 1, the epitaph has spoken and never speaks again.
        self.published = GlobalState(UInt64(0))
        # Round the switch fired (0 until it does).
        self.revealed_round = GlobalState(UInt64(0))
        # SHA-256 of the off-chain epitaph message. The message itself is
        # never stored on-chain.
        self.commitment = GlobalState(Bytes())

    @abimethod(create="require")
    def create(self) -> None:
        """No-op create. Zero arguments on purpose.

        The 68-year trap: never take a uint64 create arg that a deploy
        script might map to the keeper app id. Nothing to pass here.
        """
        self.keeper_app.value = UInt64(0)
        self.owner.value = Txn.sender
        self.last_checkin_round.value = UInt64(0)
        self.timeout_rounds.value = UInt64(0)
        self.published.value = UInt64(0)
        self.revealed_round.value = UInt64(0)
        self.commitment.value = Bytes()

    @abimethod()
    def set_keeper(self, keeper: Application) -> None:
        """Name the Arcron keeper whose app account may call `publish`.

        Creator-only, one-time. Pass the keeper *application*, not a raw
        uint64. `publish` authorizes Application(keeper).address — the
        inner-call sender when Arcron `execute()` inner-calls this app —
        never itob(keeper.id). Puya lowers the Application param to uint64
        in the ABI signature; the compiled selector is set_keeper(uint64)void.
        """
        assert Txn.sender == Global.creator_address, "Only the creator can set the keeper"
        assert self.keeper_app.value == 0, "Keeper already set"
        assert keeper.id != 0, "Keeper app required"
        self.keeper_app.value = keeper.id

    @abimethod()
    def arm(self, timeout_rounds: UInt64) -> None:
        """Arm the switch (or re-arm it) with a fresh timeout.

        Owner-only. Sets the timeout, records the check-in round as now,
        and clears `published` so a re-arm after publication resurrects the
        switch for another silence window. The message is not stored
        on-chain — set its commitment separately via `commit`.
        """
        assert Txn.sender == self.owner.value, "Only the owner can arm"
        assert timeout_rounds >= MIN_TIMEOUT_ROUNDS, "Timeout below floor"
        self.timeout_rounds.value = timeout_rounds
        self.last_checkin_round.value = Global.round
        self.published.value = UInt64(0)

    @abimethod()
    def commit(self, commitment: StaticArray[Byte, Literal[32]]) -> None:
        """Store the SHA-256 commitment of the off-chain epitaph message.

        Owner-only. Exactly 32 bytes. The message itself never touches the
        chain; only its hash does, so a future reveal is verifiable without
        making the farewell public before its time.
        """
        assert Txn.sender == self.owner.value, "Only the owner can commit"
        self.commitment.value = commitment.bytes

    @abimethod()
    def check_in(self) -> None:
        """Reset the dead-man's timer. Owner-only."""
        assert Txn.sender == self.owner.value, "Only the owner can check in"
        self.last_checkin_round.value = Global.round

    @abimethod()
    def publish(self) -> UInt64:
        """Arcron hook. Zero arguments; the selector is the only app arg.

        Returns 1 the round the switch fires, 0 on every no-work path.
        FAIL SOFT: after the two authorization asserts nothing here may
        reject — a failing hook gets exponentially backed off by keeper
        bots and burns upkeep escrow on retries.

        Not armed (timeout 0), not yet expired, or already published: all
        return 0. On expiry: set published = 1, record revealed_round,
        return 1. One execution, permanent, readable off any indexer.
        """
        keeper = self.keeper_app.value
        assert keeper != 0, "Keeper not set"
        # Inner-call sender is the keeper *app account*, not itob(keeper.id).
        assert (
            Txn.sender == Application(keeper).address
        ), "Only the keeper app may publish"

        # Already spoken. The dead stay dead; never fail after speaking.
        if self.published.value == 1:
            return UInt64(0)

        # Not armed yet — nothing to expire.
        timeout = self.timeout_rounds.value
        if timeout == 0:
            return UInt64(0)

        # Silence is not yet death. Return, do not assert.
        if Global.round < self.last_checkin_round.value + timeout:
            return UInt64(0)

        # EXPIRED — speak once.
        self.published.value = UInt64(1)
        self.revealed_round.value = Global.round
        return UInt64(1)

    @abimethod(readonly=True)
    def status(self) -> UInt64:
        """Rounds remaining until expiry. 0 if expired, published, or unarmed."""
        timeout = self.timeout_rounds.value
        if timeout == 0:
            return UInt64(0)
        if self.published.value == 1:
            return UInt64(0)
        deadline = self.last_checkin_round.value + timeout
        if Global.round >= deadline:
            return UInt64(0)
        return deadline - Global.round
