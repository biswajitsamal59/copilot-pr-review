import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdoClient } from '../ado-api/client';
import {
    fetchPrDetails,
    fetchPrIterations,
    fetchPrThreads,
    fetchPrCommits,
    filterCopilotThreads,
    formatPrDetailsText
} from '../ado-api/pull-requests';
import {
    fetchIterationChanges,
    fetchIterationDiffs,
    formatIterationDetailsText,
} from './diff-fetcher';

export interface PrContextResult {
    iterationId: number;
}

/**
 * Builds all PR context files in the output directory.
 * Writes PR_Details.txt and Iteration_Details.txt with the full diff.
 */
export async function buildPrContext(
    client: AdoClient,
    repo: string,
    prId: number,
    outputDir: string
): Promise<PrContextResult> {
    // Fetch PR metadata in parallel
    const [prDetails, iterations, threads] = await Promise.all([
        fetchPrDetails(client, repo, prId),
        fetchPrIterations(client, repo, prId),
        fetchPrThreads(client, repo, prId),
    ]);
    console.log('  PR details fetched.');

    const collectionUri = client.getCollectionUri();
    const copilotThreads = filterCopilotThreads(threads);

    // Write PR details
    fs.writeFileSync(
        path.join(outputDir, 'PR_Details.txt'),
        formatPrDetailsText(prDetails, threads, iterations, copilotThreads, collectionUri),
        'utf8'
    );

    // Iteration Details

    if (iterations.length === 0) {
        throw new Error(`No iterations found for pull request #${prId}`);
    }

    const latestIteration = iterations.reduce((a, b) => (a.id > b.id ? a : b));
    const iterationId = latestIteration.id;

    const [commits, changeEntries] = await Promise.all([
        fetchPrCommits(client, repo, prId),
        fetchIterationChanges(client, repo, prId, iterationId),
    ]);

    console.log(`  Fetching diffs for ${changeEntries.length} changed file(s). Source commit: ` +
        `${latestIteration.sourceRefCommit?.commitId}, Target commit: ${latestIteration.targetRefCommit?.commitId}`);
    const allDiffs = fetchIterationDiffs(
        changeEntries,
        latestIteration.sourceRefCommit?.commitId ?? '',
        latestIteration.targetRefCommit?.commitId ?? '',
        outputDir
    );

    const iterationDetailsText = formatIterationDetailsText(
        iterationId, latestIteration, commits, changeEntries, allDiffs,
        collectionUri, client.getProject(), repo, prId
    );

    fs.writeFileSync(path.join(outputDir, 'Iteration_Details.txt'), iterationDetailsText, 'utf8');
    console.log(`  ${allDiffs.length} file(s) ready for review.`);

    return { iterationId };
}
