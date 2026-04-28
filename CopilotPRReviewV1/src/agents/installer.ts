import { execFileSync, spawn } from 'node:child_process';
import * as path from 'node:path';

function isWindows(): boolean {
    return process.platform === 'win32';
}

function isNoiseLine(line: string): boolean {
    // Lines that should be filtered from the pipeline log.
    // winget has no flag to suppress its package license/terms text, so the
    // leftover boilerplate must be filtered here even with --silent +
    // --accept-*-agreements + --disable-interactivity.
    const NOISE_PATTERNS: Array<RegExp | string> = [
        /[█▒░]/,                                    // progress bars
        /^[\\|/\-]\s*$/,                            // spinner frames
        'Terms of Transaction:',
        'This application is licensed to you',
        'Microsoft is not responsible',
        'The source requires the current machine',
        'Path environment variable modified',       // misleading: we refresh PATH ourselves in copilot.ts
    ];

    const trimmed = line.trim();
    if (!trimmed) return true;
    return NOISE_PATTERNS.some((p) =>
        typeof p === 'string' ? trimmed.startsWith(p) : p.test(trimmed),
    );
}

export async function checkCopilotCli(): Promise<boolean> {
    // execFileSync (not spawnSync) is the documented tool for "run a binary,
    // get exit status" — no shell, more efficient. Throws on ENOENT or
    // non-zero exit, both of which mean "not installed / not working".
    try {
        execFileSync('copilot', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export async function installCopilotCli(): Promise<void> {
    return new Promise((resolve, reject) => {
        // Spawn the binary directly with shell:false on both platforms.
        // On Linux the pipe-chained installer is run by spawning bash with -c
        // explicitly — the pattern Node's docs recommend over relying on the
        // shell:true option (avoids DEP0190 entirely).
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

        const forwardOutput = (data: Buffer): void => {
            for (const line of data.toString().split(/\r?\n/)) {
                if (!isNoiseLine(line)) {
                    console.log(`  ${line.trim()}`);
                }
            }
        };

        proc.stdout?.on('data', forwardOutput);
        proc.stderr?.on('data', forwardOutput);

        proc.on('close', (code) => {
            if (code === 0) {
                if (!isWindows()) {
                    const localBin = path.join(process.env['HOME'] ?? '', '.local', 'bin');
                    process.env['PATH'] = `${localBin}${path.delimiter}${process.env['PATH']}`;
                }
                resolve();
            } else {
                reject(new Error(`Failed to install GitHub Copilot CLI (exit code: ${code})`));
            }
        });

        proc.on('error', (err) => reject(new Error(`Failed to install GitHub Copilot CLI: ${err.message}`)));
    });
}
