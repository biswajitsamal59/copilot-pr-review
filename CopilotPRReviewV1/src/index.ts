import * as tl from 'azure-pipelines-task-lib/task';
import * as path from 'path';
import * as fs from 'fs';
import { getValidatedTaskInputs } from './utils/task-inputs';
import { checkCopilotCli, installCopilotCli } from './agents/installer';
import { AdoClient } from './ado-api/client';
import { buildPrContext } from './context/pr-context';
import { resolvePrompt } from './utils/prompt';
import { runCopilotCli } from './agents/copilot';

async function run(): Promise<void> {
    try {
        const taskInputs = getValidatedTaskInputs();
        if (!taskInputs) { return; }

        const {
            githubPat, azureDevOpsToken, azureDevOpsAuthType, resolvedCollectionUri,
            project, repository, pullRequestId, timeoutMinutes, model
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

        // Step 3: Run code review

        const promptTemplatePath = path.join(__dirname, '..', 'src', 'scripts', 'prompt.txt');
        const promptFilePath = resolvePrompt({
            promptInput: tl.getInput('prompt') || undefined,
            promptFileInput: tl.getInput('promptFile') || undefined,
            promptRawInput: tl.getInput('promptRaw') || undefined,
            promptFileRawInput: tl.getInput('promptFileRaw') || undefined,
            promptTemplatePath,
            workingDir: workingDirectory,
        });

        // Write thin wrapper scripts so the AI agent can call node ./add-comment.js
        writeAgentScriptWrappers(workingDirectory, scriptsDir);

        const timeoutMs = timeoutMinutes * 60 * 1000;

        console.log('\n[3/3] Running code review...');
        await runCopilotCli(promptFilePath, model || undefined, workingDirectory, timeoutMs);

        console.log('\nCopilot PR Review completed.');

        tl.setResult(tl.TaskResult.Succeeded, 'Copilot code review completed.');
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        tl.setResult(tl.TaskResult.Failed, `Task failed: ${errorMessage}`);
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