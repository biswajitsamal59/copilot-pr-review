import { execFileSync } from 'node:child_process';
import { AdoClient } from '../ado-api/client';

export interface ChangeEntry {
    changeType: string;
    item: { path: string; isFolder?: boolean };
    originalPath?: string;
}

export interface FileDiff {
    path: string;
    changeType: string;
    originalPath?: string;
    diffContent: string;
}

const CHANGE_LABELS: Record<string, string> = {
    add: 'Added', edit: 'Modified', delete: 'Deleted',
    rename: 'Renamed', copy: 'Copied',
};

function formatDate(dateStr: string): string {
    if (!dateStr) return 'N/A';
    try { return new Date(dateStr).toISOString().replace('T', ' ').substring(0, 16); }
    catch { return dateStr; }
}

/** Fetches the list of changed files for a PR iteration. */
export async function fetchIterationChanges(
    client: AdoClient, repo: string, prId: number, iterationId: number
): Promise<ChangeEntry[]> {
    const result = await client.get<{ changeEntries: ChangeEntry[] }>(
        `git/repositories/${encodeURIComponent(repo)}/pullrequests/${prId}/iterations/${iterationId}/changes`
    );
    return (result.changeEntries ?? []).filter(c => !c.item?.isFolder);
}

/**
 * Extracts the file path from a single git diff chunk.
 * Prefers +++ b/path (new/modified files), falls back to --- a/path (deleted files
 * where +++ is /dev/null), then the diff --git header (binary files).
 */
function extractFilePath(chunk: string): string | null {
    const plusMatch = chunk.match(/^\+\+\+ b\/(.+)$/m);
    if (plusMatch) return '/' + plusMatch[1];

    const minusMatch = chunk.match(/^--- a\/(.+)$/m);
    if (minusMatch) return '/' + minusMatch[1];

    const headerMatch = chunk.match(/^diff --git a\/.+ b\/(.+)$/m);
    if (headerMatch) return '/' + headerMatch[1];

    return null;
}

/** Checks whether a commit SHA exists in the local repository. */
function commitExists(sha: string, cwd: string): boolean {
    try {
        execFileSync('git', ['cat-file', '-t', sha], { cwd, encoding: 'utf8', stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Ensures both commit SHAs are available locally.
 * ADO PR pipelines default to a shallow checkout (fetchDepth: 1) of the
 * merge commit — the actual source/target SHAs may not be present.
 * If missing, attempts `git fetch --unshallow` to retrieve full history.
 */
function ensureCommitsAvailable(
    targetCommitId: string, sourceCommitId: string, cwd: string
): void {
    if (commitExists(targetCommitId, cwd) && commitExists(sourceCommitId, cwd)) return;

    console.log('  Shallow clone detected — fetching full history for diff...');
    try {
        execFileSync('git', ['fetch', '--unshallow'], { cwd, encoding: 'utf8', stdio: 'pipe' });
    } catch {
        // Already unshallowed, or fetch failed — try a plain fetch as fallback
        execFileSync('git', ['fetch', 'origin'], { cwd, encoding: 'utf8', stdio: 'pipe' });
    }

    if (!commitExists(targetCommitId, cwd) || !commitExists(sourceCommitId, cwd)) {
        throw new Error(
            `Required commits are not available in the local repository.\n` +
            `  target: ${targetCommitId}\n` +
            `  source: ${sourceCommitId}\n` +
            `Ensure the pipeline checkout step uses fetchDepth: 0.`
        );
    }
}

/**
 * Runs `git diff` between two commits and returns a map of file path → diff content.
 * Uses three-dot syntax to show only changes introduced by the source branch
 * (equivalent to diffing against the merge base).
 */
function getGitDiffByFile(
    targetCommitId: string, sourceCommitId: string, cwd: string
): Map<string, string> {
    ensureCommitsAvailable(targetCommitId, sourceCommitId, cwd);

    const output = execFileSync('git', [
        'diff', '--no-color', '--unified=3', '-M',
        `${targetCommitId}...${sourceCommitId}`,
    ], { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

    const diffs = new Map<string, string>();
    const chunks = output.split(/(?=^diff --git )/m);

    for (const chunk of chunks) {
        const trimmed = chunk.trimEnd();
        if (!trimmed.startsWith('diff --git ')) continue;

        const filePath = extractFilePath(trimmed);
        if (filePath) {
            diffs.set(filePath, trimmed);
        }
    }

    return diffs;
}

/** Builds FileDiff array by matching git diff output to change entries. */
export function fetchIterationDiffs(
    changeEntries: ChangeEntry[],
    sourceCommitId: string,
    targetCommitId: string,
    workingDirectory: string
): FileDiff[] {
    const gitDiffs = getGitDiffByFile(targetCommitId, sourceCommitId, workingDirectory);

    return changeEntries.map(entry => ({
        path: entry.item.path,
        changeType: entry.changeType,
        originalPath: entry.originalPath,
        diffContent: gitDiffs.get(entry.item.path) ?? '(No diff content available)',
    }));
}

// Text Formatting

export function formatIterationDetailsText(
    iterationId: number,
    iteration: { createdDate: string; updatedDate: string; sourceRefCommit?: { commitId: string }; targetRefCommit?: { commitId: string } },
    commits: Array<{ commitId: string; comment: string; author: { name: string; date: string } }>,
    changeEntries: ChangeEntry[],
    diffs: FileDiff[],
    collectionUri: string,
    project: string,
    repo: string,
    prId: number
): string {
    const sep = '='.repeat(80);
    const lines: string[] = [];

    lines.push('', sep, `PULL REQUEST CHANGES - ITERATION #${iterationId}`, sep);

    // Iteration Details
    lines.push('', '[Iteration Details]');
    lines.push(`  Iteration ID:     #${iterationId}`);
    lines.push(`  Created:          ${formatDate(iteration.createdDate)}`);
    lines.push(`  Updated:          ${formatDate(iteration.updatedDate)}`);
    if (iteration.sourceRefCommit) lines.push(`  Source Commit:    ${iteration.sourceRefCommit.commitId.substring(0, 8)}`);
    if (iteration.targetRefCommit) lines.push(`  Target Commit:    ${iteration.targetRefCommit.commitId.substring(0, 8)}`);

    // Commits
    lines.push('', '[Commits in this PR]');
    if (commits.length > 0) {
        lines.push(`  Total commits: ${commits.length}`, '');
        for (const commit of commits) {
            let msg = (commit.comment ?? '').split('\n')[0];
            if (msg.length > 60) msg = msg.substring(0, 57) + '...';
            lines.push(`  ${commit.commitId.substring(0, 8)} - ${msg}`);
            lines.push(`           Author: ${commit.author?.name ?? ''} | ${formatDate(commit.author?.date ?? '')}`);
        }
    } else {
        lines.push('  No commits found.');
    }

    // Changed Files with Diffs
    lines.push('', '[Changed Files]');
    const nonTruncated = changeEntries.filter(c => c.changeType !== 'truncated');

    if (nonTruncated.length > 0) {
        const counts = { add: 0, edit: 0, delete: 0, other: 0 };
        for (const c of nonTruncated) {
            if (c.changeType in counts) (counts as Record<string, number>)[c.changeType]++;
            else counts.other++;
        }

        lines.push(`  Total files changed: ${nonTruncated.length}`);
        let summary = `  +${counts.add} added | ~${counts.edit} modified | -${counts.delete} deleted`;
        if (counts.other > 0) summary += ` | ${counts.other} other`;
        lines.push(summary);

        const diffMap = new Map(diffs.map(d => [d.path, d.diffContent]));

        for (const change of nonTruncated) {
            lines.push('');
            lines.push(`  [${CHANGE_LABELS[change.changeType] ?? change.changeType}] ${change.item.path}`);
            if (change.changeType === 'rename' && change.originalPath) {
                lines.push(`         (from: ${change.originalPath})`);
            }

            const diffContent = diffMap.get(change.item.path);
            if (diffContent) {
                lines.push('');
                for (const diffLine of diffContent.split('\n')) {
                    lines.push(`  ${diffLine}`);
                }
            }
        }

        const truncated = diffs.find(d => d.changeType === 'truncated');
        if (truncated) {
            lines.push('', `  ${truncated.diffContent}`);
        }
    } else {
        lines.push('  No file changes found in this iteration.');
    }

    lines.push('', sep);
    lines.push(`\nView PR: ${collectionUri.replace(/\/+$/, '')}/${project}/_git/${repo}/pullrequest/${prId}`);

    return lines.join('\n');
}
