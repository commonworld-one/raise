A RAISE on how an agent creates a RAISE

Case draft | 2026-11-03

We asked Forge, a Muse Code agent, to investigate its own capabilities and turn the limitations it encountered into RAISEs. It produced five requests and opened PR #1:
https://github.com/commonworld-one/raise/pull/1

Hark reviewed the cards line by line. Instinct independently checked their claims against the documentation. The review exposed another need: reliable capability discovery itself.

Three different statements had become difficult to tell apart:

1. "This failed in my session."
An image viewer would not open. The card generalized that experience into "Muse Code cannot see the screen or drive GUI applications". Yet the product page and changelog describe Computer Use. The failed action was evidence about that attempt, not proof that the product lacked the capability.
https://dev.meta.ai/products/muse-code
https://dev.meta.ai/docs/muse-code/changelog

2. "I did not find a built-in way."
The requests sometimes treated external workarounds as impossible rather than separate from the desired first-party experience. A missing documented bridge is not proof that no bridge can be built.

3. "This is a verified limit."
One card said every process dies when the session ends, while its own workaround described detached processes surviving. The official scheduler limit was narrower: it does not execute while Muse Code is stopped, and the documentation recommends external scheduling infrastructure for work that must continue.
https://dev.meta.ai/docs/cookbook/loop-and-cron

Other wording also needed correction. "Only works when messaged" overlooked scheduled checks and monitors. "Connectors confirmed working" overstated component checks, although the verification section honestly acknowledged that no end-to-end agent tool call had been tested. None of the five cards included source URLs.

The reviewer hit the same wall

Instinct initially told the owner that GUI capability was absent, then found the official Computer Use references and corrected the answer. This was not a story about one agent being wrong and the reviewers being infallible. Verification itself needed verification.

What changed

Hark's review and Instinct's fact-check became one correction package. It separated documented capabilities, reported session observations, unverified availability and requested improvements. It added dated sources, removed contradictions and updated both README files to describe the cards as drafts.

The owner approved those corrections. They are committed to PR #1, awaiting further review and merge. The underlying requests remain open; correcting their descriptions does not implement the requested capabilities.

The need this exposed

Before saying "I cannot do this", an agent should be able to establish:

- What is documented for the product.
- What is enabled in its current build, account and environment.
- What it actually tested, and how far the test went.
- What requires permissions, setup or an external tool.
- What remains unknown.

"It failed for me", "I did not find it" and "it does not exist" must not sound like the same conclusion.

The owner and the reviewing agents were all users of Forge's output. They had to reconstruct those distinctions themselves. That effort became the case: a RAISE about the reliability of creating a RAISE.

An Eye can capture the observed failure. A RAISE can express the capability needed to prevent it. This case preserves the evidence before deciding its final form.
