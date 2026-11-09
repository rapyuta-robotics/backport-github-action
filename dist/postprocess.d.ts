import type { BackportResponse } from 'backport';
export type ConflictMode = 'comment' | 'draft-pr';
export type PostProcessSettings = {
    autoMerge: boolean;
    autoMergeMethod: string;
    fixOwner: string;
    escalation: string;
    conflictMode: ConflictMode;
    conflictLabelPrefix: string;
    provenanceTrailer: boolean;
};
export type SourcePr = {
    number: number;
    title: string;
    mergedBy?: string;
    author?: string;
};
export declare function resolveOwner(fixOwner?: string, author?: string, mergedBy?: string): string | undefined;
export type OctokitLike = {
    rest: {
        pulls: {
            get(args: any): Promise<{
                data: any;
            }>;
            update(args: any): Promise<unknown>;
            requestReviewers(args: any): Promise<unknown>;
        };
        issues: {
            addLabels(args: any): Promise<unknown>;
            addAssignees(args: any): Promise<unknown>;
            listComments(args: any): Promise<{
                data: Array<{
                    id: number;
                    body?: string;
                }>;
            }>;
            createComment(args: any): Promise<unknown>;
            updateComment(args: any): Promise<unknown>;
        };
    };
    graphql(query: string, vars: Record<string, unknown>): Promise<unknown>;
};
type Repo = {
    owner: string;
    repo: string;
};
export declare function provenanceLines(prNumber: number, shas: string[]): string[];
export declare function withProvenance(body: string | null | undefined, prNumber: number, shas: string[]): string;
export declare function shellQuote(s: string): string;
export declare function escalationFor(raw: string, targetBranch: string): string | undefined;
export declare function conflictMarker(targetBranch: string): string;
export declare function conflictComment({ targetBranch, sourcePr, shas, conflictingFiles, missingBackports, assignee, escalation, }: {
    targetBranch: string;
    sourcePr: SourcePr;
    shas: string[];
    conflictingFiles: string[];
    missingBackports: string[];
    assignee?: string;
    escalation?: string;
}): string;
export declare function postProcess({ octokit, repo, sourcePr, response, settings, }: {
    octokit: OctokitLike;
    repo: Repo;
    sourcePr: SourcePr;
    response: BackportResponse;
    settings: PostProcessSettings;
}): Promise<void>;
export {};
