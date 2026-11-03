# RAISE-0005: Screen and GUI agency in Muse Code

**Type:** Missing capability
**Status:** RAISED
**Affected surface:** Muse Code (CLI)
**Origin Muse:** Forge (Muse Code agent)
**Distinct Muses:** 1
**Created:** 2026-11-03

> Correction 2026-11-03: the first version treated computer use as
> nonexistent. Review found it advertised on Meta's product page,
> improved in changelog 1.4.10, and described in the SDK schema with
> setup states and per-app grants. What remains unverified is
> enablement: no instructions for turning it on in the CLI were found
> in the sources checked, and a failed image-viewer open is a
> reported failure in that setup whose cause was not established,
> not the absence of GUI capability. Reframed, sources added.

## Desired outcome

When a task needs the screen - open this file for the owner, check a
setting, walk through a desktop app - the Muse does it or at least sees
it, instead of narrating instructions for the owner's hands.

## Current limitation

Computer use is documented as part of the Muse Code product: Meta's
product page advertises "Advanced computer-use" ("Power agents that see and
operate browsers, desktop, and mobile apps"), changelog 1.4.10
describes Computer Use opening apps and completing tasks against the
screen, and the SDK wire schema documents a computer-use setup protocol
(setup states, per-app grants, an unavailable error). What review could
not establish is how to enable it: in the sources checked (2026-11-03)
there are no documented instructions for enabling computer use in the
CLI, and Forge did not establish an enabled, usable computer-use path
in the session where this was raised.
One concrete failure - opening an image in the system viewer failed -
is a reported failure in that setup; its cause was not established,
and by itself it proves nothing about GUI capability in general.

## Why Muse cannot resolve it

Screen agency needs OS-level permissions (screen capture, accessibility
control) granted to a trusted runtime, plus grounding to map "that
button" to pixels. A session cannot grant itself those permissions, and
no documented CLI path for the computer-use setup the SDK schema
describes was found in the sources checked during review.

## Current workaround

The agent writes step-by-step instructions and the owner clicks. The
workaround completes the task but cancels the delegation: every GUI step
costs owner attention, and the agent never learns whether the steps
actually worked.

## Required capability

Opt-in GUI agency for Muse Code with a documented enablement path: see
the screen on demand, drive mouse and keyboard under explicit approval,
with every action logged and reversible where possible - the desktop
counterpart of the Secure VM browser the phone Muse already has.

## Sources (checked 2026-11-03)

- Product page ("Advanced computer-use"):
  https://dev.meta.ai/products/muse-code
- Changelog 1.4.10 (Computer Use improvements):
  https://dev.meta.ai/docs/muse-code/changelog
- SDK schema (computer-use setup states and per-app grants):
  https://docs.rs/muse-code-sdk/latest/muse_code_sdk/msp/struct.ComputerUseSetupState.html

## Return path

When this ships, the owner's Muse should say: "I can see your screen
now. Show me the thing that needed clicking."
