# Review reapplied patches hunk by hunk

Use this when `/gsd-update --reapply` merges your local edits back cleanly but you are not sure every
edit should still be there. An update can make a customization redundant in ways no merge conflict
shows: upstream adopts it in different words, rewrites the section around it, or deletes the section
it was attached to. `--interactive` shows you each of your edits next to the stock text and lets you
decide what happens to it.

## Before you start

- You have already run `/gsd-update` and it backed up your modified files to `gsd-local-patches/`.
- The verdicts are most reliable when `gsd-pristine/` (or a git history of your config directory)
  holds the pre-update version of each file. Without it, every edit in that file is shown for review
  and nothing is recommended for retirement.

## Steps

1. **Pick a mode.** Run one of:

   ```bash
   /gsd-update --reapply --interactive=all          # every edit, one by one
   /gsd-update --reapply --interactive              # same as =exceptions
   /gsd-update --reapply --interactive=exceptions   # only the edits that need a look
   ```

   Use `=all` the first time you run it on an install. You have not yet seen how well the
   recommendations fit your customizations, and `=all` lets you check every one. Once you trust
   them, `=exceptions` (or bare `--interactive`) skips the edits that apply cleanly.

2. **Answer each prompt.** For every edit shown you see:
   - **Stock text:** the lines GSD shipped at that spot before the update.
   - **Your text:** the lines you added or changed.
   - **Recommendation** and the reasons behind it.

   Then choose one:

   | Choice | What happens |
   |---|---|
   | **Keep** | Your edit is grafted into the new version, as it is without `--interactive`. |
   | **Retire** | Your edit is dropped. The new version keeps upstream's text at that spot. |
   | **Rewrite** | You give replacement text, and that is applied instead of your original edit. |

   In `=exceptions` mode, edits that are not shown are kept. The run prints one summary line per
   edit it kept without asking, so you can see what happened.

3. **Read the result.** The report gives each file's status. A file whose edits you all retired is
   reported `Incorporated`. A file with some retired edits is `Merged` with a count of the
   retirements. The post-merge check passes for retired and rewritten edits because they were
   dropped on your instruction. Every one of them is listed in the check's output.

## What the recommendations mean

| Reason | Meaning | Usual choice |
|---|---|---|
| `already_upstream` | Every line you added is now in the shipped file, or every line you deleted is gone from it. | Retire |
| `partially_upstream` | Some of your lines are in the shipped file, others are not. | Read both, then Keep or Rewrite |
| `region_changed_upstream` | Upstream also changed the lines at the spot your edit touches, for example by rewording them. | Read both carefully |
| `anchor_orphaned` | The lines your edit sat between are gone from the shipped file, so the edit may no longer apply anywhere. | Usually Retire or Rewrite |
| `baseline_unconfirmed` | There is no verified pre-update copy of this file, so the tool cannot tell your edits from upstream's changes. | Read the whole file |
| `diff_too_large` | The file changed too much (more than 400 line edits) to split into separate edits, so it is shown as one block. | Read the whole file |

A recommendation is only a suggestion. Nothing is retired unless you choose Retire.

## When an answer stops applying

Each decision is tied to the exact text of the edit you were shown. If the backup or its baseline
changes between the prompt and the post-merge check, the check stops with a `stale decision` error
instead of applying an old answer to different text. Run `/gsd-update --reapply --interactive` again
to see the edits as they are now.

## Related

- [Update GSD](update-gsd.md)
- [`/gsd-update` reference](../COMMANDS.md#gsd-update)
