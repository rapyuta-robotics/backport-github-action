import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { Context } from '@actions/github/lib/context';
import {
  BackportResponse,
  backportRun,
  UnhandledErrorResult,
  getOptionsFromGithub,
} from 'backport';
import { ConflictMode, OctokitLike, postProcess } from './postprocess';

export type Inputs = {
  accessToken: string;
  autoBackportLabelPrefix: string;
  repoForkOwner: string;
  addOriginalReviewers: boolean;
  autoMerge: boolean;
  autoMergeMethod: string;
  fixOwner: string;
  escalation: string;
  conflictMode: ConflictMode;
  conflictLabelPrefix: string;
  provenanceTrailer: boolean;
};

export async function run({
  context,
  inputs,
  octokit,
}: {
  context: Context;
  inputs: Inputs;
  octokit?: OctokitLike;
}) {
  core.info('Initiate backport');

  // Checked at runtime: the value comes straight from the workflow input.
  const conflictMode: string = inputs.conflictMode;
  if (conflictMode !== 'comment' && conflictMode !== 'draft-pr') {
    throw new Error(
      `conflict_mode must be "comment" or "draft-pr", got "${conflictMode}"`,
    );
  }

  const options = getActionOptions(inputs, context);
  const optionsFromGithub = await getOptionsFromGithub({
    accessToken: options.accessToken,
    repoName: options.repoName,
    repoOwner: options.repoOwner,
    githubApiBaseUrlV4: options.githubApiBaseUrlV4,
  });

  core.info(JSON.stringify({ optionsFromGithub, actionOptions: options }));

  if (
    !optionsFromGithub.targetBranches &&
    !optionsFromGithub.branchLabelMapping &&
    !options.branchLabelMapping
  ) {
    throw new Error(
      'No target branches configured. Please configure `targetBranches: ["my-target-branch"]` in .backportrc.json or use the `auto_backport_label_prefix` input option.',
    );
  }

  // CLI args outrank the repo's .backportrc.json (module options do not), so
  // the conflict mode is forced here: in comment mode a conflicting pick must
  // fail instead of being committed with markers into a PR.
  const processArgs: string[] =
    inputs.conflictMode === 'comment' ? ['--commitConflicts', 'false'] : [];

  const result = await backportRun({
    options,
    processArgs,
    exitCodeOnFailure: false,
  });

  core.info(`Result ${JSON.stringify(result, null, 2)}`);

  const pullRequest = context.payload.pull_request;
  await postProcess({
    octokit:
      octokit ??
      (getOctokit(inputs.accessToken, {
        baseUrl: context.apiUrl,
      }) as unknown as OctokitLike),
    repo: { owner: context.repo.owner, repo: context.repo.repo },
    sourcePr: {
      number: pullRequest?.number as number,
      title: pullRequest?.title as string,
      mergedBy: pullRequest?.merged_by?.login as string | undefined,
      author: pullRequest?.user?.login as string | undefined,
    },
    response: result,
    settings: {
      autoMerge: inputs.autoMerge,
      autoMergeMethod: inputs.autoMergeMethod || 'squash',
      fixOwner: inputs.fixOwner,
      escalation: inputs.escalation,
      conflictMode: inputs.conflictMode,
      conflictLabelPrefix: inputs.conflictLabelPrefix,
      provenanceTrailer: inputs.provenanceTrailer,
    },
  });

  return result;
}

export function getFailureMessage(res: BackportResponse) {
  switch (res.status) {
    case 'failure':
    case 'aborted':
      return res.errorMessage;

    case 'success': {
      const unhandledErrorResults = res.results.filter(
        (res): res is UnhandledErrorResult => res.status === 'unhandled-error',
      );

      // only return message if there are unhandled errors
      // handled errors should not be output
      if (unhandledErrorResults.length > 0) {
        return `Unhandled errors: ${unhandledErrorResults
          .map((res) => res.error.message)
          .join(', ')}`;
      }
    }
  }
}

function getActionOptions(inputs: Inputs, context: Context) {
  const { payload, repo, runId } = context;
  const pullRequest = payload.pull_request;

  if (!pullRequest) {
    throw Error('Only pull_request events are supported.');
  }

  const requestedReviewers = pullRequest.requested_reviewers as
    | Array<{ login: string }>
    | undefined;

  const options = {
    accessToken: inputs.accessToken,
    assignees: [pullRequest.user.login as string],
    branchLabelMapping:
      inputs.autoBackportLabelPrefix !== ''
        ? { [`^${inputs.autoBackportLabelPrefix}(.+)$`]: '$1' }
        : undefined,
    gitHostname: context.serverUrl.replace(/^https{0,1}:\/\//, ''), // support for Github enterprise,
    githubActionRunId: runId,
    githubApiBaseUrlV3: context.apiUrl,
    githubApiBaseUrlV4: context.graphqlUrl,
    interactive: false,
    // In comment mode the conflict comment replaces the library's generic
    // "run npx backport" failure comment.
    publishStatusCommentOnFailure: inputs.conflictMode !== 'comment',
    pullNumber: pullRequest.number,
    repoForkOwner:
      inputs.repoForkOwner !== '' ? inputs.repoForkOwner : repo.owner,
    repoName: repo.repo,
    repoOwner: repo.owner,
    reviewers:
      inputs.addOriginalReviewers && Array.isArray(requestedReviewers)
        ? requestedReviewers.map((reviewer) => reviewer.login)
        : [],
  };

  return options;
}
