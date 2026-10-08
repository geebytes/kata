# Serialize the verification cycle

## 1. The defect, measured

`ledger evidence verify` proves an executable falsifier by **injecting** the defect into the working tree, running the
check, and **restoring** the file. An independent round measured what happens when two runs overlap:

```
two concurrent `ledger evidence verify` runs whose checks mutate the same file
  → the live checkout afterwards held the injected defect (`git diff` non-empty)
  → the next `verify --id E4` reported `refuted … the check was already failing before any mutation`
```

The cycle in `src/producers/verifiers.ts:123-163` is `read original → write mutated → run → write original back`. Two
runs interleave exactly as one would fear: B reads the file **after** A injected, so B's "original" is A's mutation, and
B then writes that back — the repository keeps a defect nobody asked for, and the only signal is a verdict about the
check rather than about the tree.

This is not a defect of the change that found it: it is the harness every change's evidence rests on, which is why it
has its own contract here.

## 2. What is fixed

1. **Serialization by the file that is mutated.** The `read → inject → run → restore` window is held under a lock keyed
   on the mutated path, using the same lock primitive (and the same lock-root derivation) the repository already uses for
   artefact writes. Two runs that touch different files still overlap — the lock is per file, not global — and two runs
   that touch the same file cannot interleave.
2. **A restore that proves itself.** The bytes written back are compared with the bytes captured before the injection. If
   they differ — because something else wrote in between, or the run died mid-cycle — the file is **named** and the run
   fails instead of producing a verdict. A mutation that is not restored is a repository left broken; it must be the
   loudest outcome, not a quiet one.

## 3. Decisions

1. **Per-file, not global.** A global lock would serialize unrelated checks and make the harness slower for no gain; the
   defect is per file, so the lock is per file.
2. **The restore check compares content, not mtime or size.** Only content distinguishes "restored" from "restored to
   something else"; a mutation whose restore is skipped leaves identical bytes in the common case, so the check is
   written against the captured string.
3. **A failed restore is not a verdict.** `inconclusive`/`refuted` describe the check; a broken tree is a different fact
   and gets its own named failure, because an operator reading a verdict would not know to look at the tree.

## 4. Acceptance and falsifiers

| AC | Selector | Single reversible falsifier |
|----|----------|-----------------------------|
| AC-1 serialization | `tests/unit/evidence-verification-is-serialized.test.ts` | remove the lock around the cycle: the concurrent pair must leave the injected content behind |
| AC-2 a named failure | `tests/unit/an-unrestored-mutation-is-named.test.ts` | drop the restore comparison: the case asserting the file is named must redden |

## 5. Verification notes

- The concurrency case drives two real runs (not a simulation of the window) and asserts the checkout is byte-identical
  afterwards, which is the property the round measured as broken.
- The restore case writes something else into the file between the injection and the restore, which is the smallest
  reproduction of "the restore cannot be trusted".
