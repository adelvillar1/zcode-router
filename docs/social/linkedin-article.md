# LinkedIn article (zcode-router-kit)

## Title

**Four prepaid LLM plans, one model picker: how my coding agent routes itself**

## Summary (the post that shares the article)

I run my coding agent on four prepaid LLM plans. All four expire if I don't
use them. For months, my agent used exactly one of them, badly.

So I built a small local router: one roster file describes every plan I have,
and my agent now picks a single model called "auto". A judge matches each task
to the right tier, hard problems can fan out into a mixture of agents, plans
running low get steered around, and everything is metered into a usage ledger.

Three things I learned building it:

· None of my providers exposes a quota API. I probed. So the router measures
  spend itself and I calibrate it with one number from the billing console.

· A "thinking" model at a tiny max_tokens cap burns the whole budget on
  reasoning and returns empty content. The call still costs money. I only
  found that out after building a ledger.

· Failover is easy to write and easy to get wrong. Testing it against a fake
  429 upstream caught two bugs in one afternoon.

Full write-up below 👇

The whole thing is open source, here:
https://github.com/adelvillar1/zcode-router

#AIEngineering #LLM #DevTools #CodingAgents

---

## Article body

**Four prepaid LLM plans, one model picker: how my coding agent routes itself**

I run my coding agent on prepaid LLM plans. Four of them, from four different
providers, because each one is generous in a different way: this one has a
million-token context, that one is fast and cheap, and this other one reasons
beautifully. They also all expire if I don't use them.

Which is the part that used to bother me. For months, my agent used exactly
one of them. Whichever was selected in a dropdown. The plan I bought for hard
problems sat mostly idle while the "fast" one chewed through architecture work
it had no business chewing through.

One evening I stopped trying to remember which plan does what and wrote a
router instead.

**One file, one command, one model**

The router is a small local proxy on 127.0.0.1. To my coding agent it looks
like just another provider, with a single model called `auto`. All of the
"which model should do this" thinking happens behind it, driven by one JSON
file I call the roster: every plan I have, its models, its key as an env-var
name (never the key itself), and a tier table mapping workloads to models.

A command renders the roster into everything the agent needs and installs a
service that keeps the router running. On a new machine: clone, write the
roster, set the keys, run the command. Ten minutes, identical setup.

**How a request gets routed**

Capability rules run first and always win. A request with images goes to the
multimodal chain. A payload too big for normal models goes to the
million-token-context one. No judgment needed, since a text-only model can't
take an image no matter how smart it is.

Everything else gets one judgment per task (cached, so a long tool loop keeps
its model). It answers four things at once: which workload tier (quick,
standard code, hard, prose, or deep context), which execution style, and which
of my saved workflows should run, in what order. It's also fail-open on
purpose. If the judgment service is down, everything degrades to the default
tier as a single call. An outage makes the router dumber; it doesn't make it
fail.

**Mixture of agents, but only when it pays**

For one hard question that doesn't decompose, the router fans the request out
to three proposers drawn from different providers, so the answers actually
differ. A second judgment picks the best answer and decides whether merging
them would beat the best one alone. The aggregator only runs when merging
wins. I stopped paying to average three good answers into one mediocre one.

**The quota problem nobody solves for you**

Here's the thing that surprised me most: none of my providers exposes a quota
API. I probed. Rate-limit headers on responses: nothing. Balance endpoints:
404. The one documented balance API in my lineup belongs to the pay-per-token
provider I deliberately keep blocked, because a router that can quietly start
costing per-token money is not a router I trust.

So the router measures spend itself. Every call's tokens are weighted (my
plans discount off-peak hours, and the weighting keeps the math honest about
when I actually run jobs) and bucketed hourly per provider. Once a month I
read the billing console and type one number into the dashboard ("this plan
is 23% used"), and the allowance recalibrates from measured spend. Headroom
then drives steering: tiers prefer candidates with room, and a plan under 40%
headroom gets passed over for a healthier one in the same quality class.

**Failover, tested by being cruel**

When a provider answers "quota exhausted" anyway, or 402s, or just 5xxs, the
router walks that tier's fallback chain and benches the failed provider for a
cooldown. I verified it with a fake upstream that answers nothing but 429s:
the first request benched it and landed on the fallback, the second request
skipped it entirely. That test also caught two real bugs in my own code the
same afternoon, which is exactly why you test the cruel path.

**The ledger that changed how I see "unlimited"**

Every call lands in a usage ledger: tokens per model, per day, including the
losing mixture proposers, because a prepaid plan pays for those too. It
immediately earned its keep. It caught a single request it attributes at over
100 million prompt tokens (I genuinely don't know whether that's real context
or the upstream's accounting being creative, but before the ledger I would
never have seen it).

And it exposed my favorite bug: a "thinking" model at a 32-token cap burns
the entire budget on reasoning and returns empty content. The call was
billed. Nothing in the response told me why. I only found it because I
started measuring.

**What changed**

I stopped thinking about which model to use. My plans deplete more evenly
now, and for prepaid quota that's the whole point: the goal is to spread the
spend before it expires, not to hoard it. When a plan hits its limit
mid-task, the agent keeps going instead of handing me an error.

If you're juggling multiple LLM subscriptions and a dropdown, the fix is
smaller than you'd think. A JSON file that describes what you have, a command
that renders it, and a small local process that picks per task. The whole
thing is open source at https://github.com/adelvillar1/zcode-router: roster
template, router, and READMEs explaining every decision.

Happy to go deeper on any piece. The routing judge, the quota calibration
math, or the mixture-of-agents wiring. What are you juggling?

---

## Publishing checklist

- Cover image: `hero-1200x628.png` (LinkedIn-verified size)
- Optional inline image: `architecture-1080.png`, dropped in after
  "One file, one command, one model" section
- The repo went **public** on 2026-09-26, so the draft links to
  https://github.com/adelvillar1/zcode-router in the sharing post and the
  closing paragraph. Worth a last glance at the public repo before
  publishing: it contains your real roster (env-var names, plan URLs, quota
  percentages) but no keys, no logs, no usage ledgers. Verified.
- LinkedIn articles support a subtitle field; reuse the one-line summary:
  "A local router that turns four prepaid LLM plans into one model my coding
  agent can pick automatically."
