# Optional ticket routing with Jev (TypeSafe AI)

**Status: built.** All nine items below are in place. The board routes with Jev when a TypeSafe key is set (the
`TYPESAFE_API_KEY` variable or the Setup page) and a board switches it on in its settings, first in `dry-run` mode and
then `on`. Settings are in [running.md](running.md), the API in [API.md](API.md#routing). The text below is the plan it
was built from.

How the board could use Jev to pick the model and effort for a ticket from structured input, as an optional add-on
that is off by default and needs a TypeSafe API key. It stands on its own: it needs
nothing beyond what is in the repository. Items are numbered 1–9. References are `file:line` at the time of
writing.

## What Jev is, and why it fits

[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) is TypeSafe AI's first "System One" model, in
early access since September 15, 2026. It doesn't write text. You send it a piece of state (text or JSON) and a set of
typed questions, and it returns typed answers with probabilities:

- **Choice**: picks one of up to 255 named options. Returns `choice`, `probabilities` per option and `confidence`.
- **Score**: places the state on an ordered rubric of 2 to 10 levels. Returns `score`, `probabilities` per level,
  `confidence` and a `legend`.
- **Noul**: a yes/no statement. Returns a probability from 0 to 1, with no `confidence`.

All the questions in one request are answered in parallel against the same state, in 70–500 ms. Input costs
$0.042 per million tokens and output is free, so routing one ticket (about 1–3k tokens of state) costs around
$0.0001. That is far below the cost of a single `claude -p` turn. The API is one call,
`POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer $TYPESAFE_API_KEY`. The context window is
32k tokens. There are Python and TypeScript SDKs (`@typesafe-ai/sdk`), and Jev is also served through OpenRouter,
Cloudflare Workers AI and a LiteLLM pass-through (`TYPESAFE_API_BASE`).

This is the shape of our routing problem: a ticket comes in as state, and we want a model (a Choice over the board's
models) and an effort (a Score over `low` < `medium` < `high` < `xhigh` < `max`, `shared/domain.ts:13`). Each answer
comes with a confidence the app can act on. An _LLM_ triage pass that picks a model for every ticket isn't worth
it, because it would add a paid turn to every ticket. Jev is the exception: it costs about a hundredth of a cent and answers
before the claim returns.

Caveats, which is why this stays **optional and off by default**:

- It is in early access, proprietary and hosted only. There may be a waitlist for a key, and no self-hosting.
- The benchmarks (speed and price against LLMs) are the vendor's own. TypeSafe calls its 0% hallucination figure
  "not empirical": it means the schema always matches, not that the answer is right.
- `confidence` measures how concentrated the probabilities are, not whether the answer is correct. The docs give no
  universal thresholds and say to tune them on your own data.
- The SDKs are young, and minor versions have already changed the question types. Use plain `fetch` and pin a
  versioned model (`jev-1.14.0`), not `jev-latest`.
- Ticket titles and descriptions are sent to a third party. Cloudflare lists the model as zero data retention, but
  check TypeSafe's own terms. Turning it on must be an explicit, per-board choice.
- Jev only replaces the _guess_. Without a measure of cost per finished ticket (item 8), there is nothing to check its
  picks against, so that measuring comes before Jev's picks are used.

## Where Jev fits, and where it doesn't

- **It can't replace the model that works the tickets.** Jev returns typed answers, not text. It can't read the code,
  call tools, write a patch, open a pull request or reply to a review, and that is what every `claude -p` run does.
- **There is no AI orchestrator to replace.** Everything that decides what happens next is free code: the agent loop
  (`scripts/agent-loop.sh`), the triage jq (`scripts/agent-loop/triage.sh`) and the server's `claim-next`. The only
  paid model calls are the runs themselves. Swapping deterministic code for a model call adds cost, latency and
  a way to fail, and changes nothing that matters.
- **So its best use is a small, paid decision in front of an expensive one.** Picking the model and effort for a
  run is the main one. Two more come close, and could be added once item 8 shows its picks hold up: deciding whether
  new feedback needs a run at all (a Noul like "this comment asks for a change", after free rules such as skipping short
  acknowledgements like "thanks" or "LGTM" have run), and whether a failing CI log comes from the code or from the infrastructure, before a run is started just to
  find that out. Each saves a whole run when it is right, so both should start in dry-run mode like item 8.
- **Whether it belongs at all** depends on item 8. The free similar-tickets suggestion the board already has (`GET /api/boards/:id/agent-suggestion`,
  `server/routes/boards.ts:175`) may route well enough on its own. If Jev's dry-run picks don't lower cost per finished
  ticket against it, drop this plan. That is why it stays optional and off by default, and why item 8's dry run comes
  before Jev's picks are used.

## Items

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Size |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | **Optional API key.** Read `TYPESAFE_API_KEY` (and `TYPESAFE_API_BASE`, default `https://api.typesafe.ai`, so a LiteLLM or other proxy works) from the environment, or take one on the Setup page. It works like the GitHub token: a `typesafe_api_key` column on `setup` (a new migration at the end of `server/db.ts`), `PUT /api/setup/typesafe-key` (next to `/github-token`, `server/routes/system.ts:79`), which checks the key with `GET /v1/models` before saving it, and an API that only ever reports whether a key is set. With no key, every Jev feature is hidden and nothing else changes.                                                                                                                                                                                                                      | S    |
| 2   | **Jev client** `server/jev.ts`: one `systemOne(state, questions)` built on `fetch`, with a 2 s timeout, the pinned model and the token usage it returns. Any error (timeout, 4xx/5xx, no key) returns `null` and is logged, never thrown into a claim. Add a fake Jev to `server/test-app.ts`, like its fake GitHub, so tests don't call the network.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | S    |
| 3   | **Board setting "Route with Jev"**, off by default and only shown when a key is set. It holds the models Jev may pick (default: the board's allowed models), a confidence threshold (start at a conservative 0.7) and a "may only lower" switch (Jev can pick a cheaper setting than the board default, never a dearer one), for boards that want savings without surprises. The setting's help text says ticket text is sent to TypeSafe.                                                                                                                                                                                                                                                                                                                                                                                    | S    |
| 4   | **The structured input.** State is JSON: title, description (cut to about 8k characters to stay well inside 32k), tags, epic, checklist length, plan estimate when there is one, and the top similar past tickets from `suggestAgent` (`server/store/suggestions.ts:194`) with the setting each used and whether it finished. Jev then weighs the ticket's content _and_ the board's history. Questions: `model` as a Choice whose criteria come from the skill's model guidance (`haiku` = mechanical, fully spelled out; `sonnet` = routine, well scoped; `opus` = cross-file judgment; `fable` = hardest), `effort` as a Score over the five efforts, and Noul `fully_specified` ("the ticket says exactly what to change") as a tie-breaker towards lower effort. Keep the question text in one place so it can be tuned. | M    |
| 5   | **Use it at claim time, server side.** When the claimed ticket has no `agentModel`/`agentEffort`, `claim-next` asks Jev and returns the pick on the ticket as `routed: {model, effort, source: "jev", confidence}`, without writing over the ticket's own fields, which stay the human's choice. The loop's `use_worker` (`scripts/agent-loop/tickets.sh:278-281`) uses `routed` when it is there. The order is: the ticket's own setting, then Jev above the threshold, then the similar-tickets suggestion (`suggestAgent`) when it is built on enough similar tickets (say 3 or more), then the board default. Cache the pick per ticket version so feedback runs don't call Jev again.                                                                                                                                    | M    |
| 6   | **Confidence gating and escalation.** Below the threshold, fall back to the next source in item 5. When the Score's probability is spread over two efforts, take the higher one. Never route lower than the setting the ticket's last run used: a ticket whose run failed, or that came back from review with changes requested, keeps or raises its setting. Following the docs' advice, gate the riskier choice (dropping to `haiku`/`low`) at a higher threshold than staying at the default.                                                                                                                                                                                                                                                                                                                              | S    |
| 7   | **Show it.** A "Suggest with Jev" button next to the similar-tickets suggestion in the ticket form and properties (`TicketProperties.tsx:106-140`), showing the per-model probabilities. A small "Jev 0.82" badge next to the model on the card and in the plan-approval banner (`src/components/ticket/PlanApproval.tsx`), so a person can see and override a routed pick before it runs.                                                                                                                                                                                                                                                                                                                                                                                                                                    | S    |
| 8   | **Measure it.** Record each run's routing source and confidence with its usage, and compare cost per _finished_ ticket (cost divided by success rate, not cost per ticket) for Jev-routed, similar-tickets-routed and default runs, in the overview and next to the suggestion. When a run reports no cost, weight its tokens by type, since cache reads dominate the raw totals, and show no verdict until each source has a minimum number of finished tickets. Add a "dry run" mode to item 3 that records Jev's pick without using it, so a board can see how Jev would have done on its own tickets before trusting it. Count Jev's own tokens in usage too (tiny, but it should show).                                                                                                                                  | M    |
| 9   | **Docs.** A `TYPESAFE_API_KEY` row in `docs/running.md`'s settings table and in `.env.example`, an optional prompt for it in `scripts/setup.sh` (skipped when empty), the setting and the `routed` field in `docs/API.md`, and a note in `SKILL.md` that agents filing tickets on a board that routes with Jev can leave out `agentModel`/`agentEffort`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | S    |

Order: 1 → 2 → 3 with 8's dry run (collect data with no behaviour change) → 4 →
5 and 6 → 7 → 9.

## Combining Jev with the similar-tickets suggestion

The similar-tickets suggestion is plain code over the board's own data and uses no Claude or TypeSafe usage, so a board can
choose how it and Jev's pick combine (`jevCombine`, under Route with Jev in Board settings, "When Jev and the similar-tickets
suggestion disagree"):

- `jev-only` (Use Jev only): never use the similar-tickets suggestion; below the threshold, go straight to the board's default.
- `jev-first` (Prefer Jev, fall back to similar tickets), the default: Jev's pick above the threshold, else the similar-tickets
  suggestion (item 5).
- `higher` (Use the higher setting) and `lower` (Use the lower setting): when both have a pick, take the more or the
  less capable model and effort of the two, each compared on its own (by their order in `AGENT_MODELS` and
  `AGENT_EFFORTS`); with only one pick, use it. The lower one saves the most usage, the higher one plays it safe.

The caps still apply first (the board's models for Jev, "may only lower"), and the last run's setting is still the
floor. The route records the source whose model won (Jev on a full tie), so item 8's cost comparison counts it there.

Sources: [TypeSafe announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev),
[docs](https://docs.typesafe.ai) ([quick start](https://docs.typesafe.ai/introduction/quickstart),
[Score](https://docs.typesafe.ai/primitives/score), [confidence](https://docs.typesafe.ai/confidence)),
[Cloudflare model page](https://developers.cloudflare.com/ai/models/typesafe/jev/),
[LiteLLM pass-through](https://docs.litellm.ai/docs/pass_through/typesafe.md),
[MarkTechPost coverage](https://www.marktechpost.com/2026/09/19/typesafe-ai-releases-jev/).
