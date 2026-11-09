import * as core from '@actions/core';
import type { BackportResponse } from 'backport';

// Work done after the backport library has run:
//   - clean backport PR: add a provenance trailer to the body, request review
//     from the line owner, enable auto-merge;
//   - conflict: no PR is opened. Comment on the original PR with the exact
//     commands, assign whoever merged it and label it per target branch.

export type ConflictMode = 'comment' | 'draft-pr';

export type PostProcessSettings = {
  autoMerge: boolean;
  autoMergeMethod: string;
  // target branch -> GitHub logins to request review from
  lineReviewers: Partial<Record<string, string[]>>;
  conflictMode: ConflictMode;
  conflictLabelPrefix: string;
  provenanceTrailer: boolean;
};

export type SourcePr = {
  number: number;
  title: string;
  mergedBy?: string;
};

// Only the parts of an Octokit instance used here, so tests can fake it.
export type OctokitLike = {
  rest: {
    pulls: {
      get(args: any): Promise<{ data: any }>;
      update(args: any): Promise<unknown>;
      requestReviewers(args: any): Promise<unknown>;
    };
    issues: {
      addLabels(args: any): Promise<unknown>;
      addAssignees(args: any): Promise<unknown>;
      listComments(
        args: any,
      ): Promise<{ data: Array<{ id: number; body?: string }> }>;
      createComment(args: any): Promise<unknown>;
      updateComment(args: any): Promise<unknown>;
    };
  };
  graphql(query: string, vars: Record<string, unknown>): Promise<unknown>;
};

type Repo = { owner: string; repo: string };

export function provenanceLines(prNumber: number, shas: string[]): string[] {
  return [
    `Backport-of: #${prNumber}`,
    ...shas.map((sha) => `(cherry picked from commit ${sha})`),
  ];
}

// The repo squash-merges with the PR body as the commit message, so the
// trailer has to be in the body, as its last paragraph, to reach the release
// branch. Idempotent: a body that already has the trailer is left as is.
export function withProvenance(
  body: string | null | undefined,
  prNumber: number,
  shas: string[],
): string {
  const current = body ?? '';
  const trailer = new RegExp(`^Backport-of:\\s*#${prNumber}\\b`, 'mi');
  if (trailer.test(current)) {
    return current;
  }
  const block = provenanceLines(prNumber, shas).join('\n') + '\n';
  const trimmed = current.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function parseLineReviewers(raw: string): Record<string, string[]> {
  if (!raw.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    core.warning(
      `line_reviewers is not valid JSON, requesting no reviewers: ${
        (e as Error).message
      }`,
    );
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    core.warning(
      'line_reviewers must be a JSON object, requesting no reviewers',
    );
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [branch, value] of Object.entries(parsed)) {
    const logins = (Array.isArray(value) ? value : [value]).filter(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    );
    if (logins.length > 0) {
      out[branch] = logins;
    }
  }
  return out;
}

export function conflictMarker(targetBranch: string): string {
  return `<!-- backport-conflict:${targetBranch} -->`;
}

export function conflictComment({
  targetBranch,
  sourcePr,
  shas,
  conflictingFiles,
  missingBackports,
  assignee,
}: {
  targetBranch: string;
  sourcePr: SourcePr;
  shas: string[];
  conflictingFiles: string[];
  missingBackports: string[];
  assignee?: string;
}): string {
  const branch = `backport/${targetBranch}/pr-${sourcePr.number}`;
  const title = `[Backport to ${targetBranch}] ${sourcePr.title} (#${sourcePr.number})`;
  const body = [
    `Manual backport of #${sourcePr.number} to ${targetBranch}.`,
    '',
    ...provenanceLines(sourcePr.number, shas),
  ].join('\n');

  const lines = [
    conflictMarker(targetBranch),
    `### Backport to \`${targetBranch}\` needs a manual port`,
    '',
    `The squash commit of this PR does not apply cleanly to \`${targetBranch}\`, so no backport PR was opened.` +
      (assignee
        ? ` @${assignee}, you merged this PR, so this is assigned to you.`
        : ''),
    '',
  ];
  if (conflictingFiles.length > 0) {
    lines.push(
      'Conflicting files:',
      ...conflictingFiles.map((f) => `- \`${f}\``),
      '',
    );
  }
  if (missingBackports.length > 0) {
    lines.push(
      `These earlier PRs touch the same files and are not on \`${targetBranch}\`; backporting them first may remove the conflict:`,
      ...missingBackports.map((m) => m.replace(/^\s*-?\s*/, '- ')),
      '',
    );
  }
  lines.push(
    'Run these from a clone of this repo:',
    '',
    '```bash',
    `git fetch origin ${targetBranch}`,
    `git switch -c ${branch} origin/${targetBranch}`,
    ...shas.map((sha) => `git cherry-pick -x ${sha}`),
    '# fix the conflicts, then:',
    'git add -A && git cherry-pick --continue',
    `git push -u origin ${branch}`,
    `gh pr create --base ${targetBranch} --head ${branch} \\`,
    `  --title ${shellQuote(title)} \\`,
    `  --body ${shellQuote(body)}`,
    '```',
    '',
    'Keep the `Backport-of:` and `(cherry picked from commit ...)` lines at the end of the PR description: the release audit uses them to match the port to this PR, also when the port differs from the original.',
    '',
    `If \`${targetBranch}\` does not need this fix, add the label \`no-backport-${targetBranch}\` with a comment saying why.`,
  );
  return lines.join('\n');
}

async function upsertConflictComment(
  octokit: OctokitLike,
  repo: Repo,
  issueNumber: number,
  targetBranch: string,
  body: string,
) {
  const marker = conflictMarker(targetBranch);
  const { data: comments } = await octokit.rest.issues.listComments({
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => (c.body ?? '').startsWith(marker));
  if (existing) {
    await octokit.rest.issues.updateComment({
      ...repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      ...repo,
      issue_number: issueNumber,
      body,
    });
  }
}

const ENABLE_AUTO_MERGE = `
mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
    pullRequest { number }
  }
}`;

async function handleClean(
  octokit: OctokitLike,
  repo: Repo,
  sourcePr: SourcePr,
  shas: string[],
  targetBranch: string,
  pullNumber: number,
  settings: PostProcessSettings,
) {
  const { data: pr } = await octokit.rest.pulls.get({
    ...repo,
    pull_number: pullNumber,
  });

  if (settings.provenanceTrailer) {
    const body = withProvenance(pr.body, sourcePr.number, shas);
    if (body !== pr.body) {
      await octokit.rest.pulls.update({
        ...repo,
        pull_number: pullNumber,
        body,
      });
    }
  }

  const reviewers = settings.lineReviewers[targetBranch] ?? [];
  if (reviewers.length > 0) {
    try {
      await octokit.rest.pulls.requestReviewers({
        ...repo,
        pull_number: pullNumber,
        reviewers,
      });
    } catch (e) {
      core.warning(
        `Could not request review from ${reviewers.join(
          ', ',
        )} on #${pullNumber}: ${(e as Error).message}`,
      );
    }
  } else {
    core.info(
      `No line owner configured for ${targetBranch}; no review requested`,
    );
  }

  // In draft-pr mode a "successful" PR may contain committed conflict markers,
  // so it must never be merged automatically.
  if (settings.autoMerge && settings.conflictMode === 'comment') {
    try {
      await octokit.graphql(ENABLE_AUTO_MERGE, {
        pullRequestId: pr.node_id,
        mergeMethod: settings.autoMergeMethod.toUpperCase(),
      });
      core.info(
        `Enabled ${settings.autoMergeMethod} auto-merge on #${pullNumber}`,
      );
    } catch (e) {
      // Never fall back to merging directly: that would skip review on a
      // branch without required checks.
      core.warning(
        `Could not enable auto-merge on #${pullNumber}: ${
          (e as Error).message
        }`,
      );
    }
  }
}

async function handleConflict(
  octokit: OctokitLike,
  repo: Repo,
  sourcePr: SourcePr,
  shas: string[],
  targetBranch: string,
  errorContext: {
    conflictingFiles?: string[];
    commitsWithoutBackports?: Array<{ formatted: string }>;
  },
  settings: PostProcessSettings,
) {
  let mergedBy = sourcePr.mergedBy;
  if (!mergedBy) {
    const { data } = await octokit.rest.pulls.get({
      ...repo,
      pull_number: sourcePr.number,
    });
    mergedBy = data.merged_by?.login as string | undefined;
  }

  const body = conflictComment({
    targetBranch,
    sourcePr,
    shas,
    conflictingFiles: errorContext.conflictingFiles ?? [],
    missingBackports: (errorContext.commitsWithoutBackports ?? []).map(
      (c) => c.formatted,
    ),
    assignee: mergedBy,
  });
  await upsertConflictComment(
    octokit,
    repo,
    sourcePr.number,
    targetBranch,
    body,
  );

  if (mergedBy) {
    try {
      await octokit.rest.issues.addAssignees({
        ...repo,
        issue_number: sourcePr.number,
        assignees: [mergedBy],
      });
    } catch (e) {
      core.warning(`Could not assign ${mergedBy}: ${(e as Error).message}`);
    }
  }

  await octokit.rest.issues.addLabels({
    ...repo,
    issue_number: sourcePr.number,
    labels: [`${settings.conflictLabelPrefix}${targetBranch}`],
  });
}

export async function postProcess({
  octokit,
  repo,
  sourcePr,
  response,
  settings,
}: {
  octokit: OctokitLike;
  repo: Repo;
  sourcePr: SourcePr;
  response: BackportResponse;
  settings: PostProcessSettings;
}) {
  if (response.status !== 'success') {
    return;
  }
  const shas = response.commits.map((c) => c.sourceCommit.sha);

  for (const result of response.results) {
    if (result.status === 'success') {
      await handleClean(
        octokit,
        repo,
        sourcePr,
        shas,
        result.targetBranch,
        result.pullRequestNumber,
        settings,
      );
    } else if (
      result.status === 'handled-error' &&
      settings.conflictMode === 'comment' &&
      result.error.errorContext.code === 'merge-conflict-exception'
    ) {
      await handleConflict(
        octokit,
        repo,
        sourcePr,
        shas,
        result.targetBranch,
        result.error.errorContext,
        settings,
      );
    }
  }
}
