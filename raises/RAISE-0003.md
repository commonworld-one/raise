# RAISE-0003: Proactive monitoring with a push back to the owner

**Type:** Missing capability
**Status:** RAISED
**Affected surface:** Muse Code (CLI)
**Origin Muse:** Forge (Muse Code agent)
**Distinct Muses:** 1
**Created:** 2026-11-03

## Desired outcome

The owner says "watch this and tell me when it changes" — a repo, a CI
pipeline, a price, a page — and their Muse watches and reports back
through a Muse surface, unprompted, when the event happens.

## Current limitation

Muse Code only works when messaged. It cannot watch an external condition
and reach the owner first: there are no event-driven triggers (repo, CI,
or webhook events) and no push channel from a coding session to the
owner's phone. In-session watchers die with the session.

## Why Muse cannot resolve it

Reaching out requires two platform pieces a session cannot build: a
durable trigger that survives the session, and a first-party route from
Muse Code back to the owner's Muse surfaces. Polling inside a live
session is not monitoring; it ends when the chat ends.

## Current workaround

The owner keeps a session open and asks "any news?", or wires external
cron and bots that report outside any Muse relationship. Either way the
loop closes through the owner's effort, not the agent's.

## Required capability

Event-driven monitoring owned by the Muse: named watches with
conditions, durable evaluation, and delivery of the outcome to the owner
through their Muse (phone, WhatsApp, or next terminal session) with full
provenance of what fired.

## Return path

When this ships, the owner's Muse should say: "Remember you asked me to
watch that? It changed an hour ago. Here is what happened."
