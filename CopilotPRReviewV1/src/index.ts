import * as tl from 'azure-pipelines-task-lib/task';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getValidatedTaskInputs } from './utils/task-inputs';
import { checkCopilotCli, installCopilotCli } from './agents/installer';
import { AdoClient } from './ado-api/client';
import { buildPrContext } from './context/pr-context';
import { extractJiraNumbers } from './context/jira-numbers';
import { resolvePrompt } from './utils/prompt';
import { runCopilotCli } from './agents/copilot';
import { writeMcpConfig } from './agents/mcp-config';

async function run(): Promise<void> {
    try {
        const taskInputs = getValidatedTaskInputs();
        if (!taskInputs) { return; }

        const {
            githubPat, azureDevOpsToken, azureDevOpsAuthType, resolvedCollectionUri,
            project, repository, pullRequestId, timeoutMinutes, model,
            jiraApiKey, jiraProjectKey, jiraAcceptanceCriteriaField,
        } = taskInputs;

        console.log(`\nCopilot PR Review — ${project}/${repository} PR #${pullRequestId}`);

        // Set environment variables for agent scripts
        process.env['GH_TOKEN'] = githubPat;
        process.env['AZUREDEVOPS_TOKEN'] = azureDevOpsToken;
        process.env['AZUREDEVOPS_AUTH_TYPE'] = azureDevOpsAuthType;
        process.env['AZUREDEVOPS_COLLECTION_URI'] = resolvedCollectionUri;
        process.env['PROJECT'] = project;
        process.env['REPOSITORY'] = repository;
        process.env['PRID'] = pullRequestId;

        const workingDirectory = tl.getVariable('System.DefaultWorkingDirectory') ?? process.cwd();
        const scriptsDir = path.join(__dirname, 'scripts');

        // Step 1: Setup Copilot CLI
        console.log('\n[1/3] Setting up Copilot CLI...');
        if (!await checkCopilotCli()) {
            console.log('  Not found. Installing...');
            await installCopilotCli();
            console.log('  Installed successfully.');
        } else {
            console.log('  Already installed.');
        }

        // Step 2: Build PR context
        console.log('\n[2/3] Fetching PR context...');
        const client = new AdoClient({
            collectionUri: resolvedCollectionUri,
            project,
            token: azureDevOpsToken,
            authType: azureDevOpsAuthType,
        });

        const context = await buildPrContext(client, repository, parseInt(pullRequestId, 10), workingDirectory);

        // Expose iteration ID to agent scripts via environment
        process.env['ITERATION_ID'] = String(context.iterationId);

        // Optional: configure JIRA via Atlassian Remote MCP. Failures are non-fatal.
        const { jiraNumbers, copilotHome } = setupJiraMcp(
            jiraApiKey, jiraProjectKey, context.description, workingDirectory,
        );

        // Step 3: Run code review

        const promptTemplatePath = path.join(__dirname, '..', 'src', 'scripts', 'prompt.txt');
        const promptFilePath = resolvePrompt({
            promptInput: tl.getInput('prompt') || undefined,
            promptFileInput: tl.getInput('promptFile') || undefined,
            promptRawInput: tl.getInput('promptRaw') || undefined,
            promptFileRawInput: tl.getInput('promptFileRaw') || undefined,
            promptTemplatePath,
            workingDir: workingDirectory,
            jiraNumbers,
            jiraAcField: jiraAcceptanceCriteriaField,
        });

        // Write thin wrapper scripts so the AI agent can call node ./add-comment.js
        writeAgentScriptWrappers(workingDirectory, scriptsDir);

        const timeoutMs = timeoutMinutes * 60 * 1000;

        console.log('\n[3/3] Running code review...');
        await runCopilotCli(promptFilePath, model || undefined, workingDirectory, timeoutMs, copilotHome);

        console.log('\nCopilot PR Review completed.');

        tl.setResult(tl.TaskResult.Succeeded, 'Copilot code review completed.');
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        tl.setResult(tl.TaskResult.Failed, `Task failed: ${errorMessage}`);
    }
}

/**
 * If a JIRA service-account key is set and the PR description references
 * issue numbers (e.g. PROJ-123), writes a Copilot CLI MCP config for the
 * Atlassian Remote MCP server. All failure modes are non-fatal.
 */
function setupJiraMcp(
    jiraApiKey: string | undefined,
    jiraProjectKey: string | undefined,
    prDescription: string,
    workingDirectory: string,
): { jiraNumbers: string[]; copilotHome: string | undefined } {
    if (!jiraApiKey) return { jiraNumbers: [], copilotHome: undefined };

    const jiraNumbers = extractJiraNumbers(prDescription, jiraProjectKey);
    if (jiraNumbers.length === 0) {
        console.log('  No JIRA numbers found in PR description. Skipping JIRA MCP setup.');
        return { jiraNumbers, copilotHome: undefined };
    }

    try {
        const copilotHome = path.join(workingDirectory, '.copilot-mcp');
        writeMcpConfig(jiraApiKey, copilotHome);
        console.log(`  JIRA MCP configured for: ${jiraNumbers.join(', ')}`);
        return { jiraNumbers, copilotHome };
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Warning: failed to configure JIRA MCP — ${msg}. Continuing without JIRA context.`);
        return { jiraNumbers, copilotHome: undefined };
    }
}

/**
 * Writes thin 1-line Node.js wrapper scripts to the working directory.
 * The AI agent calls `node ./add-comment.js` without needing to know the
 * absolute path of the compiled task modules in the extension directory.
 */
function writeAgentScriptWrappers(workingDirectory: string, scriptsDir: string): void {
    const scripts: Array<{ wrapper: string; compiled: string }> = [
        { wrapper: 'add-comment.js', compiled: path.join(scriptsDir, 'add-comment.js') },
        { wrapper: 'update-comment.js', compiled: path.join(scriptsDir, 'update-comment.js') },
        { wrapper: 'delete-comment.js', compiled: path.join(scriptsDir, 'delete-comment.js') },
    ];

    for (const { wrapper, compiled } of scripts) {
        const content = `require(${JSON.stringify(compiled)});\n`;
        fs.writeFileSync(path.join(workingDirectory, wrapper), content, 'utf8');
    }
}

run();