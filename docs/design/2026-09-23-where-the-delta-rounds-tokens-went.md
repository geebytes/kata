# Where the delta round's tokens went, decomposed

The claim I made — "remit −64%, tokens +27%, so the delta remit does not reduce cost" — was made from the harness's reported
total. **Decomposing both rounds' event streams overturns two of this line's findings, including that one.**

## The two rounds, per-turn, from the provider's own usage

| | cold (round 1) | delta (round 2) | change |
|---|---|---|---|
| assistant turns | 22 | 21 | −1 |
| tool uses | 72 | 62 | **−14%** |
| **input** | **157,249** | **153,401** | **−2%** |
| **cacheRead** | **1,832,704** | **1,748,352** | **−5%** |
| **output** | **194,615** | **292,308** | **+50%** |
| — of which reasoning | 179,656 | 277,549 | **+54%** |
| **billed (input + output + cacheRead)** | **2,184,568** | **2,194,061** | **+0.4%** |
| per-turn input (median) | 3,595 | 3,638 | ~same |
| per-turn cacheRead (median) | 102,272 | 103,552 | ~same |

**And the number I had been quoting is not the billed total.** The harness reports `input + output` and excludes `cacheRead`:
157,249 + 194,615 = **351,864** exactly, and 153,401 + 292,308 = **445,709** exactly. **So "tokens +27%" was a statement about the
non-cached part of the bill — 16% of it.**

## What actually happened, stage by stage

1. **The remit narrowing worked, on the input side.** Input −2%, cacheRead −5%, tool uses −14% on a quarter of the paths. The
   round read less of the change, which is what a delta scope is for.
2. **The output side grew by half, and reasoning by more.** Bytes attributed to thinking went from 41% of the round's content to
   50%, while tool results went from 29% to 24%. **The round spent more of its budget reasoning and less reading** — and the
   plausible cause is the brief, which grew from 17,587 to 35,038 characters because it carries the previous round's findings and
   dispositions. More prior material to reason about, less new material to read.
3. **The billed total is +0.4%.** So the honest statement is not "it does not reduce cost" but **"it moved the cost from reading to
   reasoning, and the total did not move."**

## And the finding this overturns: prefix caching is working here

I recorded, and repeated several times, that prefix caching is impossible at this endpoint — from a measurement where two
byte-identical requests returned `cacheRead: 0`. **In these rounds `cacheRead` is 1.83M and 1.75M, which is 84% and 80% of the
billed tokens, at a median of ~102K per turn.** The cache is doing most of the work.

**What that means for the cost equation on this line**: the "48× replay, cacheRead 0, every turn billed at full price" analysis was
wrong for these rounds — it was measured on a different path (a `pi -p` child against the gateway), while these rounds are agent
sessions. **So the dominant term is not replay-at-full-price; it is cache reads plus output, and output is the part that grew.**

## What follows, and it is a different lever

- **Input is close to irreducible by narrowing the remit further** — it is already cached at 80%+, and the remit cut moved it 2%.
- **The lever that moved the number is the output side**, and the thing that grew there is reasoning. The brief's history is a
  candidate cause and is measurable: issue two delta rounds on the same revision, one with the finding history and one without,
  and compare reasoning tokens.
- **And the metric this line has been reporting is the wrong one.** `input + output` excludes 80–84% of the bill. Every cost claim
  on this line should be restated in billed tokens, and the ones that are not are not comparable.

## What the brief is, and what "its history" is

The brief is the reviewer's **entire instruction set** — a rendered document, persisted at
`.kata/tasks/<id>/adversarial-briefs/<node>-<revision>.json` and handed over as `brief.text` in the packet. It is the answer to
"a review without a checklist is only an ignorant review": what the change is, the acceptance contract and each criterion's check,
the evidence the author recorded, the sealed evidence it may read instead of re-running, where to start reading, the budget as
hard limits, the rules, and the exact shape of the record it must return.

**"Its history" is the part of the brief that carries earlier rounds' work**, and on this delta round it is:

| section | chars | what it carries |
|---|---|---|
| **`## This is a delta pass`** | **11,703** | **the delta's exact path list, and "earlier attempts, for reference rather than re-execution" — the previous round's hypotheses with their outcomes and how each was settled** |
| `## What a previous round read` | 5,899 | the delivered-facts ledger: each path with its content hash and the conclusion drawn, so re-reading it would learn the same thing |
| `## Already known, already decided — do not re-report these` | 356 | the previous round's findings, so the next round does not rediscover them |
| `## Findings recorded so far` | 92 | nearly empty |

**18,050 characters — 52% of the 35,038-character brief.** And for scale: **the cold round's entire brief was 17,587
characters.** The history added to the second round is larger than everything the first round was given.

**That is what the +99% brief growth is, and it is the candidate cause of the +54% reasoning.** The reviewer is handed the previous
round's hypotheses, their outcomes, and the method that settled each — "for reference rather than re-execution" — and is asked to
decide which of those conclusions still hold now that four paths changed. **That is reasoning work over prior material, and it is
where the output side grew**, while the input side (what it actually read) went down.

## The user's point, and it is right: my comparison was confounded

I concluded "remit −64%, tokens +27%, so the delta remit does not reduce cost". **Two variables changed at once** — the remit
narrowed from 11 paths to 4 **and** the brief grew by 10,742 characters of the previous round's hypotheses — and I attributed the
whole difference to the first.

Separated, the input side moved the way the narrowing predicts:

| | cold (11 paths) | delta (4 paths) | change |
|---|---|---|---|
| input + cacheRead | 1,989,953 | 1,901,753 | **−4.4%** |
| tool uses | 72 | 62 | **−14%** |
| tool-result share of content bytes | 29% | 24% | **−5pp** |
| **per path** (input + cacheRead ÷ paths) | 180,905 | **475,438** | **+163%** |

**So the narrowing does reduce the input side — in absolute terms, −4.4% on 64% fewer paths.** And the last row is the honest
qualification rather than a refutation: **the history's cost is not per-path.** It is a fixed block that the round must reason over
regardless of how many paths it covers, so on a four-path remit it dominates, and the more history is carried the worse the
per-path figure looks.

**Which makes the lever's value conditional rather than nil**: narrowing the remit helps, and how much it helps depends on how
much fixed material the brief carries alongside it. That is exactly what the running experiment separates — same revision, same
four paths, the 10,742-character block removed.

**And it means the claim to make is narrower than either of my two versions**: not "it does not reduce cost" (confounded) and not
"it reduces cost" (unmeasured in isolation), but **"the remit narrowing reduces the input side measurably, and whether that
survives the brief's fixed history is the measurement in flight."**

## The experiment ran: the history costs 25% of the bill and 44% of the reasoning

Same revision (`revision-48f7fb8e31c67fc9`), same four paths, same model and agent type. The only difference: the 10,742-character
`Earlier attempts` block removed, taking the brief from 35,038 to 24,383 characters.

| | control (with history) | **treatment (without)** | change |
|---|---|---|---|
| assistant turns | 21 | 22 | +1 |
| tool uses | 62 | 63 | +1 |
| input | 153,401 | 264,753 | +73% |
| cacheRead | 1,748,352 | 1,227,648 | **−30%** |
| output | 292,308 | 152,811 | **−48%** |
| — of which reasoning | 277,549 | 155,075 | **−44%** |
| **billed total** | **2,194,061** | **1,645,212** | **−25%** |
| content bytes: thinking | 50% | **39%** | |
| content bytes: tool results | 24% | **31%** | |

**So the history's cost is real and it is measurable: 25% of the billed tokens, and 44% of the reasoning.** And the shape of the
change is the hypothesis confirmed rather than a coincidence — **thinking fell from 50% of the round's content to 39%, while tool
results rose from 24% to 31%**: handed less prior material to reason over, the reviewer read more and reasoned less. **Input rose
73% for the same reason** — it went and looked, because it was not told.

**That is the answer to the user's earlier question about what the +27% was**: the reported figure was the non-cached part of a bill
whose dominant term (cacheRead) was *lower* in the delta round, and whose increase came from reasoning over the brief's history.

### And the quality half did not come back

**The treatment round's record did not parse**, and its final message was a fragment — "Let me confirm the precise line-level
behaviour and the AC-3 wording provenance" — so **there is nothing to compare its findings against.** It ran 22 turns and 63 tool
uses, so it was not idle; it ended without a record.

**So this experiment establishes the cost half and not the quality half**: removing the history makes a delta round 25% cheaper, and
**whether it makes it worse is unmeasured** — the one round that would have said so returned nothing. **Stated as such rather than
claimed either way**: the cost lever is measured, and the quality question is open, with one failed observation.

## Two corrections from trying to compress the class section

**1. The findings do carry a path, and I said they did not.** I concluded from a 22% reduction that "a finding carries a `path`
only when the pass knew which file it was about". Counted: `repair-by-another-author` 6/6, its history 7/7, `closure-gate` 2/2 and
its history 17/17 — **every finding carries a path.** So the filter withheld four because four were about unchanged paths, which is
correct behaviour rather than a data gap. **The wrong claim is withdrawn.**

**2. And the class section's filter withheld nothing, which does not add up.** I applied the same filter to
`## Findings by class`'s "open findings in full" — with 17+ findings against a four-path delta, most should have been withheld and
a note should have rendered. It rendered nothing and the section grew by 1,970 characters, entirely my own explanatory prose.

**So it is reverted rather than kept**: a filter that adds 1,970 characters and removes nothing is the decorative mechanism this
line has spent a whole change removing, and keeping it "because it will help later" is how a brief grows while a measurement says
it should shrink.

**And the "withheld nothing" is left as an open question rather than a conclusion.** The candidate explanations are that the filter
did not run — `input.delta?.changedPaths` reaching it as undefined — or that the class section's history is filtered upstream
before it arrives. Either is checkable in one read, and I did not have the budget to check it before writing this.
