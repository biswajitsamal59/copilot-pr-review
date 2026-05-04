import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

/**
 * Runs the GitHub Copilot CLI.
 *
 * The prompt is read in Node and passed as a direct OS-level argument via
 * child_process.spawn with shell: false.  This avoids all shell quoting /
 * metacharacter issues (cmd.exe and PowerShell both corrupt arguments
 * containing double quotes).  Works because winget installs copilot as a
 * native executable, not a .cmd shim.
 */
export async function runCopilotCli(
    promptFilePath: string,
    model: string | undefined,
    workingDirectory: string,
    timeoutMs: number,
): Promise<void> {
    // Read prompt in Node — no shell involved
    const promptContent = fs.readFileSync(promptFilePath, 'utf8');

    // Each element becomes one OS-level argument — no shell interpretation
    const args = [
        '-p', promptContent,
        '--allow-all-paths',
        '--allow-all-tools',
        '--deny-tool', 'shell(git push)',
        '--no-color',
    ];
    if (model) {
        args.push('--model', model);
    }

    return new Promise((resolve, reject) => {
        const proc = spawn('copilot', args, {
            shell: false,
            stdio: 'inherit',
            cwd: workingDirectory,
        });

        const timeoutId = setTimeout(() => {
            console.log(`\n  Timeout reached (${timeoutMs / 60000} min). Terminating...`);
            proc.kill('SIGTERM');
            reject(new Error(`Copilot review timed out after ${timeoutMs / 60000} minutes`));
        }, timeoutMs);

        proc.on('close', (code) => {
            clearTimeout(timeoutId);
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Copilot CLI exited with code: ${code}`));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(new Error(`Failed to run Copilot CLI: ${err.message}`));
        });
    });
}
