import { execFileSync, spawn } from 'node:child_process';
import * as path from 'node:path';

function isWindows(): boolean {
    return process.platform === 'win32';
}

export async function checkCopilotCli(): Promise<boolean> {
    try {
        execFileSync('copilot', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export async function installCopilotCli(): Promise<void> {
    return new Promise((resolve, reject) => {
        // Spawn the binary directly with shell:false on both platforms
        const [command, args] = isWindows()
            ? ['winget', [
                'install', 'GitHub.Copilot',
                '--silent',
                '--accept-package-agreements',
                '--accept-source-agreements',
                '--disable-interactivity',
            ]]
            : ['bash', ['-c', 'curl -fsSL https://gh.io/copilot-install | bash']] as const;

        const proc = spawn(command, args as string[], { shell: false, stdio: 'pipe' });

        // Buffer all output silently; only surfaces on failure for diagnostics.
        // Avoids piping winget's CR-delimited progress bars into Azure Pipelines logs.
        const outputChunks: Buffer[] = [];
        proc.stdout?.on('data', (data: Buffer) => outputChunks.push(data));
        proc.stderr?.on('data', (data: Buffer) => outputChunks.push(data));

        proc.on('close', (code) => {
            if (code === 0) {
                if (!isWindows()) {
                    const localBin = path.join(process.env['HOME'] ?? '', '.local', 'bin');
                    process.env['PATH'] = `${localBin}${path.delimiter}${process.env['PATH']}`;
                }
                resolve();
            } else {
                const diagnostics = Buffer.concat(outputChunks).toString('utf8').trim();
                const detail = diagnostics ? `\n${diagnostics}` : '';
                reject(new Error(`Failed to install GitHub Copilot CLI (exit code: ${code})${detail}`));
            }
        });

        proc.on('error', (err) => reject(new Error(`Failed to install GitHub Copilot CLI: ${err.message}`)));
    });
}
