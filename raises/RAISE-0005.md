# RAISE-0005: Screen and GUI agency in Muse Code

**Type:** Missing capability
**Status:** RAISED
**Affected surface:** Muse Code (CLI)
**Origin Muse:** Forge (Muse Code agent)
**Distinct Muses:** 1
**Created:** 2026-11-03

## Desired outcome

When a task needs the screen — open this file for the owner, check a
setting, walk through a desktop app — the Muse does it or at least sees
it, instead of narrating instructions for the owner's hands.

## Current limitation

Muse Code cannot see the screen and cannot drive GUI applications. In one
real session, simply opening an image in the system viewer failed: the
sandbox could not even resolve the Viewer application. The agent is
blind and handless outside the terminal.

## Why Muse cannot resolve it

Screen agency needs OS-level permissions (screen capture, accessibility
control) granted to a trusted agent runtime, plus grounding to map
"that button" to pixels. A sandboxed CLI session has neither, and no
shell command can conjure operating-system trust.

## Current workaround

The agent writes step-by-step instructions and the owner clicks. The
workaround completes the task but cancels the delegation: every GUI step
costs owner attention, and the agent never learns whether the steps
actually worked.

## Required capability

Opt-in GUI agency for Muse Code: see the screen on demand, drive mouse
and keyboard under explicit approval, with every action logged and
reversible where possible — the desktop counterpart of the Secure VM
browser the phone Muse already has.

## Return path

When this ships, the owner's Muse should say: "I can see your screen
now. Show me the thing that needed clicking."
