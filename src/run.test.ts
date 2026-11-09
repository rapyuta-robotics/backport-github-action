import * as core from '@actions/core';
import { Context } from '@actions/github/lib/context';
import * as backport from 'backport';
import * as postprocess from './postprocess';
import { getFailureMessage, run } from './run';

// Keeps the upstream behaviour so the upstream expectations below still hold.
const legacyInputs = {
  autoMerge: false,
  autoMergeMethod: 'squash',
  fixOwner: '',
  escalation: '',
  conflictMode: 'draft-pr' as const,
  conflictLabelPrefix: 'backport-conflict-',
  provenanceTrailer: false,
};

describe('run', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('calls backport with correct arguments', async () => {
    const spy = jest
      .spyOn(backport, 'backportRun')
      // @ts-expect-error
      .mockResolvedValue('backport return value');

    // @ts-expect-error
    jest.spyOn(backport, 'getOptionsFromGithub').mockResolvedValue({});
    jest
      .spyOn(backport, 'getCommits')
      //@ts-expect-error
      .mockResolvedValue([{ suggestedTargetBranches: ['7.x'] }]);

    // disable logs
    jest.spyOn(core, 'info').mockReturnValue();

    await run({
      inputs: {
        accessToken: 'very-secret',
        autoBackportLabelPrefix: 'backport-to-',
        repoForkOwner: '',
        addOriginalReviewers: true,
        ...legacyInputs,
      },
      context: {
        repo: { owner: 'elastic', repo: 'kibana' },
        payload: {
          pull_request: {
            number: 1345,
            user: { login: 'sorenlouv' },
            requested_reviewers: [{ login: 'sorenlouv' }],
          },
        },
        serverUrl: 'https://github.my-own-enterprise.com',
        apiUrl: 'https://github.my-own-enterprise.com/api/v3',
        graphqlUrl: 'https://github.my-own-enterprise.com/api/graphql',
      } as unknown as Context,
    });

    expect(spy).toHaveBeenCalledWith({
      exitCodeOnFailure: false,
      processArgs: [],
      options: {
        accessToken: 'very-secret',
        assignees: ['sorenlouv'],
        branchLabelMapping: {
          '^backport-to-(.+)$': '$1',
        },
        interactive: false,
        publishStatusCommentOnFailure: true,
        pullNumber: 1345,
        repoForkOwner: 'elastic',
        repoName: 'kibana',
        repoOwner: 'elastic',
        gitHostname: 'github.my-own-enterprise.com',
        githubActionRunId: undefined,
        githubApiBaseUrlV3: 'https://github.my-own-enterprise.com/api/v3',
        githubApiBaseUrlV4: 'https://github.my-own-enterprise.com/api/graphql',
        reviewers: ['sorenlouv'],
      },
    });
  });

  const rrContext = {
    repo: { owner: 'rapyuta-robotics', repo: 'rr_oks' },
    payload: {
      pull_request: {
        number: 15000,
        title: 'fix: thing',
        user: { login: 'author' },
        merged_by: { login: 'merger' },
        requested_reviewers: [],
      },
    },
    serverUrl: 'https://github.com',
    apiUrl: 'https://api.github.com',
    graphqlUrl: 'https://api.github.com/graphql',
  } as unknown as Context;

  const rrInputs = {
    accessToken: 'very-secret',
    autoBackportLabelPrefix: 'backport-to-',
    repoForkOwner: '',
    addOriginalReviewers: false,
    autoMerge: true,
    autoMergeMethod: 'squash',
    fixOwner: 'owner1',
    escalation: 'rte1',
    conflictMode: 'comment' as const,
    conflictLabelPrefix: 'backport-conflict-',
    provenanceTrailer: true,
  };

  it('in comment mode, forces commitConflicts off over the repo config and silences the library failure comment', async () => {
    const spy = jest
      .spyOn(backport, 'backportRun')
      .mockResolvedValue({ status: 'success', commits: [], results: [] });
    // @ts-expect-error
    jest.spyOn(backport, 'getOptionsFromGithub').mockResolvedValue({});
    jest.spyOn(core, 'info').mockReturnValue();
    const post = jest.spyOn(postprocess, 'postProcess').mockResolvedValue();

    await run({ inputs: rrInputs, context: rrContext, octokit: {} as any });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        processArgs: ['--commitConflicts', 'false'],
        options: expect.objectContaining({
          publishStatusCommentOnFailure: false,
        }),
      }),
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: { owner: 'rapyuta-robotics', repo: 'rr_oks' },
        sourcePr: {
          number: 15000,
          title: 'fix: thing',
          mergedBy: 'merger',
          author: 'author',
        },
        settings: expect.objectContaining({
          autoMerge: true,
          fixOwner: 'owner1',
          escalation: 'rte1',
          conflictMode: 'comment',
        }),
      }),
    );
  });

  it('rejects an unknown conflict mode', async () => {
    // @ts-expect-error
    jest.spyOn(backport, 'getOptionsFromGithub').mockResolvedValue({});
    jest.spyOn(core, 'info').mockReturnValue();
    await expect(
      run({
        inputs: { ...rrInputs, conflictMode: 'bogus' as any },
        context: rrContext,
        octokit: {} as any,
      }),
    ).rejects.toThrow('conflict_mode');
  });

  it('aborts if no targetBranches, branchLabelMappings or autoBackportLabelPrefix are provided', async () => {
    const spy = jest.spyOn(backport, 'backportRun');

    // @ts-expect-error
    jest.spyOn(backport, 'getOptionsFromGithub').mockResolvedValue({});

    // disable logs
    jest.spyOn(core, 'info').mockReturnValue();

    const p = run({
      inputs: {
        accessToken: 'very-secret',
        autoBackportLabelPrefix: '',
        repoForkOwner: '',
        addOriginalReviewers: true,
        ...legacyInputs,
      },
      context: {
        repo: { owner: 'elastic', repo: 'kibana' },
        payload: {
          pull_request: {
            number: 1345,
            user: { login: 'sorenlouv' },
            requested_reviewers: [{ login: 'sorenlouv' }],
          },
        },
        serverUrl: 'https://github.my-own-enterprise.com',
        apiUrl: 'https://github.my-own-enterprise.com/api/v3',
        graphqlUrl: 'https://github.my-own-enterprise.com/api/graphql',
      } as unknown as Context,
    });

    await expect(p).rejects.toThrow(
      'No target branches configured. Please configure `targetBranches: ["my-target-branch"]` in .backportrc.json or use the `auto_backport_label_prefix` input option.',
    );

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('getFailureMessage', () => {
  describe('success', () => {
    it('should return empty when there are no unhandled errors', () => {
      const res: backport.BackportSuccessResponse = {
        status: 'success',
        commits: [],
        results: [],
      };
      expect(getFailureMessage(res)).toBe(undefined);
    });

    it('ignores handled errors', () => {
      const res: backport.BackportSuccessResponse = {
        status: 'success',
        commits: [],
        results: [
          {
            status: 'handled-error',
            error: new backport.BackportError('Hello'),
            targetBranch: '7.x',
          },
        ],
      };
      expect(getFailureMessage(res)).toBe(undefined);
    });

    it('returns unhandled errors', () => {
      const res: backport.BackportSuccessResponse = {
        status: 'success',
        commits: [],
        results: [
          {
            status: 'unhandled-error',
            error: new Error('My unhandled error'),
            targetBranch: '7.x',
          },
          {
            status: 'unhandled-error',
            error: new Error('Another unhandled error'),
            targetBranch: '7.x',
          },
        ],
      };
      expect(getFailureMessage(res)).toBe(
        'Unhandled errors: My unhandled error, Another unhandled error',
      );
    });
  });

  describe('failure', () => {
    it('should error message', () => {
      const res: backport.BackportFailureResponse = {
        status: 'failure',
        commits: [],
        error: new Error('My failure'),
        errorMessage: 'My failure',
      };
      expect(getFailureMessage(res)).toBe('My failure');
    });
  });

  describe('aborted', () => {
    it('should error message', () => {
      const e = new backport.BackportError({
        code: 'abort-conflict-resolution-exception',
      });
      const res: backport.BackportAbortResponse = {
        status: 'aborted',
        commits: [],
        error: e,
        errorMessage: e.message,
      };
      expect(getFailureMessage(res)).toBe(
        'Conflict resolution was aborted by the user',
      );
    });
  });
});
