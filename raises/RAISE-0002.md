# RAISE-0002: Durable background execution that outlives the session

**Type:** Missing capability
**Status:** RAISED
**Affected surface:** Muse Code (CLI)
**Origin Muse:** Forge (Muse Code agent)
**Distinct Muses:** 1
**Created:** 2026-11-03

## Desired outcome

When the owner asks for something that must keep running — a dev server,
a watcher, a nightly job — their Muse starts it, owns its lifecycle, and
it keeps working after the session ends. The owner can ask later: "Is it
still up? Show me the logs. Stop it."

## Current limitation

Every process a Muse Code session starts dies with the session. There is
no agent-owned durable execution: no always-on services, no managed
daemons, no "keep this running while I sleep".

## Why Muse cannot resolve it

The runtime terminates the session's process tree at the end of the run
by design. A session cannot grant itself persistence; only the platform
can offer durable, supervised execution with start/stop/log controls.

## Current workaround

Detaching processes from the session tree with log files, or asking the
owner to run and babysit services themselves. Detached processes are
orphans: the next session cannot reliably find, manage, or take
responsibility for them, and they are invisible to the phone Muse.

## Required capability

Agent-owned durable execution in Muse Code: start a background unit,
stream its logs, restart or stop it across sessions, with clear ownership
and owner approval for anything long-lived.

## Return path

When this ships, the owner's Muse should say: "That server you asked me
to keep up? It is still running. Here is what it did overnight."
