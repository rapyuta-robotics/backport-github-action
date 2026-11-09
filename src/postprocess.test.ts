import * as core from '@actions/core';
import {
  conflictComment,
  conflictMarker,
  parseLineReviewers,
  postProcess,
  PostProcessSettings,
  shellQuote,
  withProvenance,
} from './postprocess';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function settings(
  over: Partial<PostProcessSettings> = {},
): PostProcessSettings {
  return {
    autoMerge: true,
    autoMergeMethod: 'squash',
    lineReviewers: {},
    conflictMode: 'comment',
    conflictLabelPrefix: 'backport-conflict-',
    provenanceTrailer: true,
    ...over,
  };
}

type Call = [string, any];

function fakeOctokit({
  body = 'Backport body',
  comments = [] as Array<{ id: number; body: string }>,
  failAutoMerge = false,
  mergedBy = 'merger' as string | null,
} = {}) {
  const calls: Call[] = [];
  const rec =
    (name: string, ret: any = {}) =>
    async (args: any) => {
      calls.push([name, args]);
      return typeof ret === 'function' ? ret(args) : ret;
    };
  const octokit = {
    rest: {
      pulls: {
        get: rec('pulls.get', (args: any) => ({
          data: {
            number: args.pull_number,
            body,
            node_id: `PR_node_${args.pull_number}`,
            merged_by: mergedBy ? { login: mergedBy } : null,
          },
        })),
        update: rec('pulls.update'),
        requestReviewers: rec('pulls.requestReviewers'),
      },
      issues: {
        addLabels: rec('issues.addLabels'),
        addAssignees: rec('issues.addAssignees'),
        listComments: rec('issues.listComments', { data: comments }),
        createComment: rec('issues.createComment'),
        updateComment: rec('issues.updateComment'),
      },
    },
    graphql: async (query: string, vars: any) => {
      calls.push(['graphql', { query, vars }]);
      if (failAutoMerge) {
        throw new Error('Pull request is in clean status');
      }
      return {};
    },
  };
  return { octokit, calls };
}

const repo = { owner: 'rapyuta-robotics', repo: 'rr_oks' };
const sourcePr = { number: 15000, title: 'fix(x): it\'s "broken" $HOME' };

function successResponse(targetBranch = 'release/2.14') {
  return {
    status: 'success' as const,
    commits: [{ sourceCommit: { sha: SHA } }],
    results: [
      {
        status: 'success' as const,
        targetBranch,
        pullRequestNumber: 16000,
        pullRequestUrl: 'https://github.com/x/y/pull/16000',
        didUpdate: false,
      },
    ],
  };
}

function conflictResponse(targetBranch = 'release/2.3') {
  return {
    status: 'success' as const,
    commits: [{ sourceCommit: { sha: SHA } }],
    results: [
      {
        status: 'handled-error' as const,
        targetBranch,
        error: {
          message: 'conflict',
          errorContext: {
            code: 'merge-conflict-exception',
            conflictingFiles: ['a/b.py', 'c.yaml'],
            commitsWithoutBackports: [
              { formatted: ' - fix: earlier thing (#14000)', commit: {} },
            ],
          },
        },
      },
    ],
  };
}

beforeEach(() => {
  jest.spyOn(core, 'info').mockReturnValue();
  jest.spyOn(core, 'warning').mockReturnValue();
});
afterEach(() => jest.restoreAllMocks());

describe('withProvenance', () => {
  it('appends the Backport-of trailer and the cherry-pick line as the last paragraph', () => {
    expect(withProvenance('Body text', 42, [SHA])).toBe(
      `Body text\n\nBackport-of: #42\n(cherry picked from commit ${SHA})\n`,
    );
  });

  it('is idempotent', () => {
    const once = withProvenance('Body text', 42, [SHA]);
    expect(withProvenance(once, 42, [SHA])).toBe(once);
  });

  it('handles an empty body and several commits', () => {
    expect(withProvenance(null, 7, ['aaa', 'bbb'])).toBe(
      'Backport-of: #7\n(cherry picked from commit aaa)\n(cherry picked from commit bbb)\n',
    );
  });
});

describe('shellQuote', () => {
  it('single-quotes and escapes embedded single quotes', () => {
    expect(shellQuote(`it's "x" $HOME`)).toBe(`'it'\\''s "x" $HOME'`);
  });
});

describe('parseLineReviewers', () => {
  it('accepts strings, lists and null owners', () => {
    expect(
      parseLineReviewers(
        '{"release/2.3": "alice", "release/2.6": ["bob", "carol"], "release/2.14": null}',
      ),
    ).toEqual({
      'release/2.3': ['alice'],
      'release/2.6': ['bob', 'carol'],
    });
  });

  it('treats empty input as no reviewers', () => {
    expect(parseLineReviewers('')).toEqual({});
  });

  it('warns and returns no reviewers on invalid JSON', () => {
    expect(parseLineReviewers('{not json')).toEqual({});
    expect(core.warning).toHaveBeenCalled();
  });
});

describe('conflictComment', () => {
  const text = conflictComment({
    targetBranch: 'release/2.3',
    sourcePr,
    shas: [SHA],
    conflictingFiles: ['a/b.py'],
    missingBackports: [' - fix: earlier thing (#14000)'],
    assignee: 'merger',
  });

  it('starts with a per-line marker', () => {
    expect(text.startsWith(conflictMarker('release/2.3'))).toBe(true);
  });

  it('gives the exact cherry-pick -x commands on the target branch', () => {
    expect(text).toContain(
      'git switch -c backport/release/2.3/pr-15000 origin/release/2.3',
    );
    expect(text).toContain(`git cherry-pick -x ${SHA}`);
    expect(text).toContain('git push -u origin backport/release/2.3/pr-15000');
  });

  it('opens the PR with the provenance trailer and the backport title', () => {
    expect(text).toContain('gh pr create --base release/2.3');
    expect(text).toContain(
      shellQuote(`[Backport to release/2.3] ${sourcePr.title} (#15000)`),
    );
    expect(text).toContain('Backport-of: #15000');
    expect(text).toContain(`(cherry picked from commit ${SHA})`);
  });

  it('lists conflicting files, missing earlier backports and the owner', () => {
    expect(text).toContain('`a/b.py`');
    expect(text).toContain('fix: earlier thing (#14000)');
    expect(text).toContain('@merger');
  });
});

describe('postProcess: clean backport', () => {
  it('adds provenance to the PR body', async () => {
    const { octokit, calls } = fakeOctokit();
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: successResponse() as any,
      settings: settings(),
    });
    const update = calls.find((c) => c[0] === 'pulls.update');
    expect(update?.[1]).toMatchObject({ pull_number: 16000 });
    expect(update?.[1].body).toContain('Backport-of: #15000');
    expect(update?.[1].body).toContain(`(cherry picked from commit ${SHA})`);
  });

  it('requests review from the line owner', async () => {
    const { octokit, calls } = fakeOctokit();
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: successResponse('release/2.14') as any,
      settings: settings({ lineReviewers: { 'release/2.14': ['owner1'] } }),
    });
    const req = calls.find((c) => c[0] === 'pulls.requestReviewers');
    expect(req?.[1]).toMatchObject({
      pull_number: 16000,
      reviewers: ['owner1'],
    });
  });

  it('requests no review when the line has no owner', async () => {
    const { octokit, calls } = fakeOctokit();
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: successResponse('release/2.14') as any,
      settings: settings({ lineReviewers: { 'release/2.3': ['x'] } }),
    });
    expect(calls.some((c) => c[0] === 'pulls.requestReviewers')).toBe(false);
  });

  it('enables squash auto-merge via GraphQL', async () => {
    const { octokit, calls } = fakeOctokit();
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: successResponse() as any,
      settings: settings(),
    });
    const gql = calls.find((c) => c[0] === 'graphql');
    expect(gql?.[1].query).toContain('enablePullRequestAutoMerge');
    expect(gql?.[1].vars).toEqual({
      pullRequestId: 'PR_node_16000',
      mergeMethod: 'SQUASH',
    });
  });

  it('does not enable auto-merge when turned off', async () => {
    const { octokit, calls } = fakeOctokit();
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: successResponse() as any,
      settings: settings({ autoMerge: false }),
    });
    expect(calls.some((c) => c[0] === 'graphql')).toBe(false);
  });

  it('never enables auto-merge in draft-pr conflict mode (the PR may hold conflict markers)', async () => {
    const { octokit, calls } = fakeOctokit();
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: successResponse() as any,
      settings: settings({ conflictMode: 'draft-pr' }),
    });
    expect(calls.some((c) => c[0] === 'graphql')).toBe(false);
  });

  it('only warns when auto-merge cannot be enabled, and never merges directly', async () => {
    const { octokit, calls } = fakeOctokit({ failAutoMerge: true });
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: successResponse() as any,
      settings: settings(),
    });
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('auto-merge'),
    );
    expect(calls.map((c) => c[0])).not.toContain('pulls.merge');
  });

  it('leaves the body alone when provenance is turned off', async () => {
    const { octokit, calls } = fakeOctokit();
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: successResponse() as any,
      settings: settings({ provenanceTrailer: false }),
    });
    expect(calls.some((c) => c[0] === 'pulls.update')).toBe(false);
  });
});

describe('postProcess: conflict', () => {
  it('comments on the original PR, assigns the merger and labels the line', async () => {
    const { octokit, calls } = fakeOctokit();
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: conflictResponse('release/2.3') as any,
      settings: settings(),
    });
    const comment = calls.find((c) => c[0] === 'issues.createComment');
    expect(comment?.[1]).toMatchObject({ issue_number: 15000 });
    expect(comment?.[1].body).toContain(`git cherry-pick -x ${SHA}`);
    expect(
      calls.find((c) => c[0] === 'issues.addAssignees')?.[1],
    ).toMatchObject({ issue_number: 15000, assignees: ['merger'] });
    expect(calls.find((c) => c[0] === 'issues.addLabels')?.[1]).toMatchObject({
      issue_number: 15000,
      labels: ['backport-conflict-release/2.3'],
    });
  });

  it('uses merged_by from the event payload without fetching the PR', async () => {
    const { octokit, calls } = fakeOctokit({ mergedBy: 'someone-else' });
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr: { ...sourcePr, mergedBy: 'payload-merger' },
      response: conflictResponse() as any,
      settings: settings(),
    });
    expect(
      calls.find((c) => c[0] === 'issues.addAssignees')?.[1].assignees,
    ).toEqual(['payload-merger']);
  });

  it('updates its earlier comment for the same line instead of posting again', async () => {
    const { octokit, calls } = fakeOctokit({
      comments: [
        { id: 1, body: 'unrelated' },
        { id: 99, body: `${conflictMarker('release/2.3')}\nold` },
      ],
    });
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: conflictResponse('release/2.3') as any,
      settings: settings(),
    });
    expect(calls.some((c) => c[0] === 'issues.createComment')).toBe(false);
    expect(
      calls.find((c) => c[0] === 'issues.updateComment')?.[1],
    ).toMatchObject({ comment_id: 99 });
  });

  it('does nothing for conflicts in draft-pr mode (legacy behaviour)', async () => {
    const { octokit, calls } = fakeOctokit();
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: conflictResponse() as any,
      settings: settings({ conflictMode: 'draft-pr' }),
    });
    expect(calls).toEqual([]);
  });

  it('ignores other handled errors', async () => {
    const { octokit, calls } = fakeOctokit();
    const res = conflictResponse() as any;
    res.results[0].error.errorContext = { code: 'invalid-branch-exception' };
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: res,
      settings: settings(),
    });
    expect(calls).toEqual([]);
  });
});

describe('postProcess: non-success responses', () => {
  it('does nothing when the backport run failed as a whole', async () => {
    const { octokit, calls } = fakeOctokit();
    await postProcess({
      octokit: octokit as any,
      repo,
      sourcePr,
      response: { status: 'failure', commits: [], errorMessage: 'x' } as any,
      settings: settings(),
    });
    expect(calls).toEqual([]);
  });
});
