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
