# How this workflow produces a repair, and why the repair is where the rounds come from

## The answer to "how does it give a repair plan" is: it does not give one

A review round returns a finding, and a finding carries exactly two things:

- **a `message`** — what is wrong and where;
- **a `falsifier`** — the check that must redden under the defect, so the repair can be checked instead of believed.

**There is no plan, and that was a deliberate decision**: asking the reviewing pass to design the fix would make it a second author
of the change, which is the one thing its independence exists to prevent. A recipe is also unfalsifiable, while a falsifier is red
or not.

**So the repair is designed from scratch by whoever fixes it — and on this line that has been the same author who wrote the code
the finding is about.** That single sentence is where most of the rework comes from, and it has five measured consequences.

## The five, each with the instance that produced it

**1. The fixer re-derives what the reporter already understood.** The finding says *what* is wrong; the mechanism behind it — the
call sites read, the reason the code is shaped that way, the counterexample that was run — died with the pass. `closure-gate`'s
rounds cost 350–660K tokens each, and the brief is 3–6% of a turn: the money is in re-reading, not in reading the brief.

**2. The fixer is the author whose blind spot the round exists to find.** **Seven decorative checks** were written during this
line's repairs — tests that pass with the defect re-introduced — and every one was caught by the falsifier mechanism rather than by
reading. `closure-gate`'s own repairs produced a decorative check within minutes of being written.

**3. The finding names an instance, and the class has several.** `wcc2-f1` and `kgs3-f3` are the same sentence: *the repair was
applied to one derivation of a concept that has several.* A finding says "this gate refuses the wrong thing"; it does not say "the
change surface has four producers and this is one of them". So the next round finds the next producer.

**4. There is no impact radius.** The fixer does not know what else the fix will touch. **Repairing `cg-f1` broke eleven fixtures
across six files**, and that was discovered by running the suite rather than by the finding saying so — even though the pass that
filed it had just read the call sites and knew.

**5. Nothing asks whether the repair is the best available.** The rule is "make the falsifier redden, then green", which accepts
the first change that satisfies it. A narrower fix, or one that removes the class rather than the instance, is neither requested nor
rewarded — and the two findings in (3) are exactly what that permits.

## What the workflow does give, and what it therefore cannot prevent

| what a repair needs | given? |
|---|---|
| what is wrong | ✅ the `message` |
| how it will be judged | ✅ the `falsifier` |
| **what else it will touch** | 🔴 **no** — and eleven fixtures broke without warning |
| **whether a better fix exists** | 🔴 **no** — the first one that reddens is accepted |
| **the class rather than the instance** | 🔴 **no** — the finding names one defect |
| **who should fix it** | 🔴 **the mechanism exists and has never been used successfully** |

**Four of six are missing, and they are the four that decide whether the next round has anything to find.**

## And this is why the rounds do not fall

The three sources of a round are structural staleness, an inadmissible record, and the repair regenerating the class. **The third is
the one this document is about, and it is not a property of the review — it is a property of what the review hands over.**

The repairs on this line produced: **seven decorative checks, two instance-not-class fixes, eleven fixtures broken by one repair,
and one repair that erased the evidence it was meant to preserve** (a waive that overwrote the findings a later routing needed).
**None of those is a review defect. All of them are repairs, made from a finding that says what is wrong and nothing else.**

**And the one requirement that was added — the falsifier — is the only one that measurably changed anything**: it caught seven
decorative checks at zero token cost, because it turned "the repair is done" from a claim into a reddening. **The other four axes
are untouched, and the impact radius is the cheapest of them**: it is an observation the reviewing pass already holds, it is
falsifiable (the suite either breaks where it said or it does not), and recording it does not make the pass the fix's author.

## The repair author could not run a check, and it said so

The second use of the repair-author mechanism produced nothing, and this time the cause is precise and mine:

> **"I have no shell tool in this session (tools are read/grep/find/ls/edit/write), which constrains what I can run."**

**The agent type I wrote listed `read, grep, find, ls, edit, write` — no `bash`.** So the one thing it was asked to return — a
falsifier shown reddening — was the one thing it could not produce. It reported the block and stopped rather than fabricating a
proof, which is the correct behaviour, and it is why the gap was visible at all.

**And it is the same class as everything else on this line**: a mechanism that does not do what it says. The file's own prose
required "the falsifier you ran, and the fact that it reddened"; the file's own frontmatter made running impossible.

**Fixed, with the reason recorded where the next person to trim that list will read it**: `bash` is in the tool list, and
**read-only was never the property to protect here** — the isolation is the scratch worktree, so this session may write and only
inside a copy. A session that may edit but may not run a test is the worse trade.

### And that is two uses, two empty results, both caused by me

The first: I removed its worktree while it was still running, because a missing output file read to me as "the job ended". The
second: it could not run a check. **Neither failure was the mechanism's idea of how to work; both were the harness around it** —
which is worth stating plainly, because the conclusion "the repair author does not help" would be wrong on this evidence. What has
been established is that the harness has now failed twice, in two different ways, and both are fixed or identified.
