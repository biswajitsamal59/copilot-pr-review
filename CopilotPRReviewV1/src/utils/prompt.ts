import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tl from 'azure-pipelines-task-lib/task';

export interface PromptConfig {
    promptInput: string | undefined;
    promptFileInput: string | undefined;
    promptTemplatePath: string;
    workingDir: string;
}

/**
 * Resolves the prompt inputs and writes the final prompt file for the CLI agent.
 *
 * The default template is always used; custom text (inline via `prompt` or loaded
 * from `promptFile`) is injected at the `%CUSTOMPROMPT%` placeholder. If neither
 * is set, the placeholder is stripped.
 */
export function resolvePrompt(config: PromptConfig): string {
    const { promptInput, promptFileInput, promptTemplatePath, workingDir } = config;

    // filePath inputs return the working directory when empty — treat as unset
    const isPromptFileSet = !!(
        promptFileInput &&
        fs.existsSync(promptFileInput) &&
        fs.statSync(promptFileInput).isFile()
    );

    if (promptInput && isPromptFileSet) {
        tl.setResult(
            tl.TaskResult.Failed,
            'Both `prompt` and `promptFile` are set. Only one may be provided.'
        );
        process.exit(1);
    }

    const outPath = path.join(workingDir, '_copilot_prompt.txt');
    const template = fs.readFileSync(promptTemplatePath, 'utf8');

    if (promptInput) {
        console.log('  Prompt: custom (inline)');
        fs.writeFileSync(outPath, template.replace('%CUSTOMPROMPT%', promptInput), 'utf8');
    } else if (isPromptFileSet) {
        console.log('  Prompt: custom (file)');
        const fileContent = fs.readFileSync(promptFileInput!, 'utf8').trim();
        if (!fileContent) {
            tl.setResult(tl.TaskResult.Failed, `Prompt file is empty: ${promptFileInput}`);
            process.exit(1);
        }
        fs.writeFileSync(outPath, template.replace('%CUSTOMPROMPT%', fileContent), 'utf8');
    } else {
        console.log('  Prompt: default');
        fs.writeFileSync(outPath, template.replace('%CUSTOMPROMPT%', ''), 'utf8');
    }

    return outPath;
}
