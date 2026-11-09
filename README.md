# Backport Github Action

## Getting started

Create a file `/.github/workflows/backport.yml` with the following content:

```yml
name: Automatic backport action

on:
  pull_request_target:
    types: ["labeled", "closed"]

jobs:
  backport:
    name: Backport PR
    runs-on: ubuntu-latest
    steps:
      - name: Backport Action
        uses: sorenlouv/backport-github-action@v9.5.1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          auto_backport_label_prefix: backport-to-

      - name: Info log
        if: ${{ success() }}
        run: cat ~/.backport/backport.info.log
        
      - name: Debug log
        if: ${{ failure() }}
        run: cat ~/.backport/backport.debug.log        
          
```

Now, to backport a pull request, simply apply the label `backport-to-production`. This will automatically backport the PR to the branch called "production" when the PR is merged. 

## Configuration

For more fine grained customization, and for the ability to run the [Backport Tool](https://github.com/sorenlouv/backport) as a CLI tool locally, you should create a `.backportrc.json` file in the root directory:

```js
// .backportrc.json
{
  // example repo info
  "repoOwner": "torvalds",
  "repoName": "linux",

  // `targetBranch` option allows to automatically backport every PR to a specific branch without the need for labels
  "targetBranches": ["production"],

  // the branches available to backport to
  "targetBranchChoices": ["main", "production", "staging"],

  // In this case, adding the label "backport-to-production" will backport the PR to the "production" branch
  "branchLabelMapping": {
    "^backport-to-(.+)$": "$1"
  }
}
```


 See the [Backport Tool documentation](https://github.com/sorenlouv/backport/blob/main/docs/config-file-options.md) for all configuration options.


## Rapyuta additions

On top of the upstream action, this fork does the following after the backport library has run. Each step has an input.

| Input | Default | What it does |
|---|---|---|
| `auto_merge` | `true` | Enables GitHub auto-merge on each backport PR that applied cleanly. Branch protection still decides when it merges (approvals, required checks). If enabling fails, the action only warns; it never merges directly. Needs the repo setting "Allow auto-merge". |
| `auto_merge_method` | `squash` | Merge method used for auto-merge. |
| `fix_owner` | `''` | GitHub login that owns the fix, for example the ADO assignee of its work item. Review is requested from them on clean backport PRs, and conflicts are assigned to them. If empty, the original PR author is used, or its merger when the author is a bot. Bots are never used. |
| `escalation` | `''` | GitHub login that takes over a conflict after the backport SLA, or a JSON object mapping each target branch to a login (`null` means none). It is named in the conflict comment, but not pinged or assigned. |
| `conflict_mode` | `comment` | `comment`: a pick that conflicts opens no PR. The action comments on the original PR with the exact `git cherry-pick -x` / `git push` / `gh pr create` commands, assigns the fix owner, and adds the label `<conflict_label_prefix><target branch>`. The comment is updated, not repeated, on re-runs. `commitConflicts` from `.backportrc.json` is overridden. `draft-pr`: upstream behaviour (whatever `.backportrc.json` says); auto-merge is never enabled in this mode because a PR may hold conflict markers. |
| `conflict_label_prefix` | `backport-conflict-` | Prefix of the conflict label. |
| `provenance_trailer` | `true` | Appends `Backport-of: #N` and `(cherry picked from commit <sha>)` as the last paragraph of each backport PR body. With "squash merge, PR body as commit message", both reach the release branch. |

The token needs `contents`, `pull-requests` and `issues` write. Adding a label with a PAT triggers `labeled` workflows, so a caller that runs on `labeled` should ignore labels other than its backport prefix.
