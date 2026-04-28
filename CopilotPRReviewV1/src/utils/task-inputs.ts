import * as tl from 'azure-pipelines-task-lib/task';

export interface ValidatedTaskInputs {
    githubPat: string;
    azureDevOpsToken: string;
    azureDevOpsAuthType: 'Bearer' | 'Basic';
    resolvedCollectionUri: string;
    project: string;
    repository: string;
    pullRequestId: string;
    timeoutMinutes: number;
    model: string | undefined;
}

export function getValidatedTaskInputs(): ValidatedTaskInputs | null {
    // Author filter (check before anything else)
    const authors = tl.getInput('authors');
    if (authors) {
        const requestedForEmail = tl.getVariable('Build.RequestedForEmail') ?? '';
        const authorList = authors.split(',').map(e => e.trim().toLowerCase());
        const currentAuthor = requestedForEmail.toLowerCase();

        if (!authorList.includes(currentAuthor)) {
            console.log(`Skipping: PR author (${requestedForEmail || 'unknown'}) is not in the configured authors list.`);
            tl.setResult(tl.TaskResult.Succeeded, 'Skipped: PR author not in configured authors list.');
            return null;
        }
    }

    // Azure DevOps authentication
    const useSystemAccessToken = tl.getBoolInput('useSystemAccessToken', false);
    const azureDevOpsPat = tl.getInput('azureDevOpsPat');
    let azureDevOpsToken: string;
    let azureDevOpsAuthType: 'Bearer' | 'Basic';
    if (useSystemAccessToken) {
        const systemToken = tl.getVariable('System.AccessToken');
        if (!systemToken) {
            tl.setResult(tl.TaskResult.Failed,
                'System.AccessToken is not available. Ensure the pipeline has access to the OAuth token.');
            return null;
        }
        azureDevOpsToken = systemToken;
        azureDevOpsAuthType = 'Bearer';
    } else if (azureDevOpsPat) {
        azureDevOpsToken = azureDevOpsPat;
        azureDevOpsAuthType = 'Basic';
    } else {
        tl.setResult(tl.TaskResult.Failed,
            'Azure DevOps authentication is required. Either provide an Azure DevOps PAT or enable "Use System Access Token".');
        return null;
    }

    // Collection URI resolution (explicit input → org name → pipeline context)
    const resolvedCollectionUri = (
        tl.getInput('collectionUri')?.replace(/\/+$/, '') ??
        (tl.getInput('organization') ? `https://dev.azure.com/${tl.getInput('organization')}` : undefined) ??
        tl.getVariable('System.CollectionUri')?.replace(/\/+$/, '')
    );
    if (!resolvedCollectionUri) {
        tl.setResult(tl.TaskResult.Failed,
            'Collection URI could not be determined. Provide collectionUri, organization, or ensure System.CollectionUri is available.');
        return null;
    }

    const githubPat = tl.getInput('githubPat');
    if (!githubPat) {
        tl.setResult(tl.TaskResult.Failed,
            'GitHub PAT is required for GitHub Copilot CLI. Please provide the githubPat input.');
        return null;
    }

    const project = tl.getInput('project');
    if (!project) {
        tl.setResult(tl.TaskResult.Failed, 'Project is required.');
        return null;
    }

    const repository = tl.getInput('repository');
    if (!repository) {
        tl.setResult(tl.TaskResult.Failed, 'Repository is required.');
        return null;
    }

    const pullRequestId = tl.getInput('pullRequestId') || tl.getVariable('System.PullRequest.PullRequestId');
    if (!pullRequestId) {
        tl.setResult(tl.TaskResult.Failed,
            'Pull Request ID is required. Either provide it as an input or run as part of a PR validation build.');
        return null;
    }

    const timeoutMinutes = parseInt(tl.getInput('timeout') ?? '15', 10) || 15;
    const model = tl.getInput('model') || undefined;

    return {
        githubPat,
        azureDevOpsToken,
        azureDevOpsAuthType,
        resolvedCollectionUri,
        project,
        repository,
        pullRequestId,
        timeoutMinutes,
        model
    };
}