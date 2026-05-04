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
                refreshPathAfterInstall();
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

/**
 * Makes the freshly installed Copilot CLI discoverable from this Node process.
 * - Linux: prepend ~/.local/bin (where the install script drops the binary).
 * - Windows: winget updates Machine/User PATH in the registry, but the running
 *   process inherited PATH at startup. Read the registry and append any entries
 *   that aren't already present, preserving existing process-scope additions.
 */
function refreshPathAfterInstall(): void {
    if (!isWindows()) {
        const localBin = path.join(process.env['HOME'] ?? '', '.local', 'bin');
        process.env['PATH'] = `${localBin}${path.delimiter}${process.env['PATH']}`;
        return;
    }

    try {
        const registryPath = execFileSync(
            'powershell',
            [
                '-NoProfile',
                '-Command',
                "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')",
            ],
            { encoding: 'utf8' },
        ).trim();

        const existing = (process.env['PATH'] ?? '').split(path.delimiter);
        const normalize = (p: string) => p.toLowerCase().replace(/[\\/]+$/, '');
        const existingSet = new Set(existing.map(normalize));
        const additions = registryPath
            .split(';')
            .filter(p => p && !existingSet.has(normalize(p)));

        if (additions.length > 0) {
            process.env['PATH'] = [...existing, ...additions].join(path.delimiter);
        }
    } catch (err) {
        console.log(`  Warning: Could not refresh PATH: ${err instanceof Error ? err.message : String(err)}`);
    }
}
