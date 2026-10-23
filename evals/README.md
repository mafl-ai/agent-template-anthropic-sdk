# Lineup evals

Think of these as behavioral tests for the agent. A unit test usually checks code
against a fixed answer. An eval runs a real model against a scenario and scores
whether the answer meets explicit expectations. Repeating the same input can give
different answers, so one passing run is evidence, not a guarantee.

## Follow one case end to end

Production runs two stages: web research, then structured lineup generation.
These first evals isolate the second stage:

```text
cases.ts: fictional contest + pool + fixed research
    -> createLineupGenerator (the same function production calls)
    -> one real Claude Messages API request, with the production prompt/schema
    -> generated lineup
    -> graders.ts: local legality checks + scenario expectations
    -> terminal report and local JSON artifacts
```

For `confirmed-out`, the packet says the star is out and the healthy receiver has
more expected points than the backup. The model must produce a legal lineup,
select the receiver, and avoid the star. A legal lineup with the injured star
fails the behavioral checks even though it passes structural validation.

The small two-slot pool makes these first cases easy to understand. They are smoke
evals, not evidence that the agent can optimize a full NFL roster. Names, reports,
URLs and projections are fictional. There is no web search, MAFL request,
registration, submission, scheduler, or production state access.

## Run

Use the same Node installation and dependencies as the app:

```sh
npm ci
npm run eval -- --list                  # free; no key needed
npm run eval -- --help                  # free
npm run eval -- --case confirmed-out    # one paid model call
npm run eval                           # four paid model calls
npm run eval -- --repeat 3              # twelve paid model calls
```

Paid commands load `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` from the environment or
`.env`. Existing shell variables take precedence. The eval task and analysis
preferences are fixed in `run.ts`, so local `AGENT_PROMPT` and `AGENT_INSTRUCTIONS`
do not change the scenarios. Effort, output-token and timeout settings still come
from your app configuration, so record them when comparing runs. No MAFL key is
needed. Calls run sequentially, with SDK retries disabled; generation failures are
recorded without retrying. Repetitions must be 1–10. Token limits are not dollar
limits.

## Read the output

Illustrative output (not a measured model result):

```text
Running confirmed-out (trial 1)...
PASS confirmed-out (4200 ms)
  PASS legal-lineup: Schema, slots, eligibility, salary, reasoning length and version accepted.
  PASS select:wr-healthy: Expected wr-healthy; selected qb-steady, wr-healthy
  PASS avoid:rb-star: Must avoid rb-star; selected qb-steady, wr-healthy

4/4 trials passed. Full inputs, outputs, checks and usage: evals/results/<run-id>/summary.json
```

Each run creates an ignored `evals/results/<run-id>/` directory. `summary.json`
contains the model, agent source hash, generation settings, complete scenarios,
model outputs, token usage, elapsed time and individual check results. There is
also a JSON file per trial. Review the rationales in `output.players` and the thesis
in `output.thesis`; the automated checks do not establish evidence grounding,
writing quality or optimality. Usage is token accounting, not a dollar estimate.
A generation error is a failed trial, distinct from a completed but wrong answer;
a refusal or a response cut off at the token limit counts as a generation error.
Raw SDK errors are omitted because they can contain request data.

Exit code 0 means every trial passed. Exit code 1 means at least one trial failed
or setup failed. Invalid lineups receive a legality failure; behavioral checks
are only evaluated after legality passes. Reports can contain custom prompt text
and model output; keep them local and review before sharing.

No measured baseline is published for this template yet. Run the suite with your
chosen model and effort before relying on it, and record the results with the
model ID, effort setting and date.

## Compare a change

Run the baseline with `--repeat 3`, save its report path, change the prompt, model
or effort, and run the same cases and repetition count again. Compare per-case pass
rates, failed checks, token usage and latency, and read changed rationales. Fixed
evidence removes web-result changes from that comparison; model outputs remain
variable. Do not tune solely to these four examples. Add cases from real failures
and keep some scenarios held out as the suite grows.

## Add a case

Add an entry to `cases.ts` with a unique ID, description, context, evidence,
required player IDs and forbidden player IDs. Ensure the case has a legal solution
and that expectations follow from the evidence. Use simple assertions only when
there is a clear answer; don't force a single lineup for ambiguous tradeoffs.
Future checks can assess newer versus older evidence, explanation grounding, or
full rosters. Live research and settled-result evaluations are separate future
suites, because they need different data and grading.

## Verify the plumbing without paying

```sh
npm run check:evals
npm test
```

The unit tests check that graders accept feasible answers and reject targeted
failures; the existing analyst test checks the research-to-generation wiring using
a mocked SDK. These checks require no credentials or network. They do not measure
real model performance. Paid evals are opt-in and are not part of `npm test` or CI.
