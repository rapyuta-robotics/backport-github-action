import { Context } from '@actions/github/lib/context';
import { BackportResponse } from 'backport';
import { ConflictMode, OctokitLike } from './postprocess';
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
export declare function run({ context, inputs, octokit, }: {
    context: Context;
    inputs: Inputs;
    octokit?: OctokitLike;
}): Promise<BackportResponse>;
export declare function getFailureMessage(res: BackportResponse): string | undefined;
