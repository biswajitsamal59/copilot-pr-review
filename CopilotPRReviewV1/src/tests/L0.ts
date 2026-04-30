/**
 * L0 unit tests for the CopilotPRReviewV1 task.
 *
 * Uses Node.js's built-in test runner (node:test, stable since v20). Each test
 * receives a TestContext `t` whose `t.mock.method(obj, name, impl)` replaces
 * `obj[name]` for the duration of the test and restores it automatically when
 * the test ends — no afterEach cleanup needed.
 *
 * https://nodejs.org/api/test.html
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Use `import = require` to obtain the actual CommonJS module objects (shared
// via Node's module cache with the production code). `import * as` would
// create a separate __importStar wrapper namespace whose properties are
// getters delegating to the real module — mocking the wrapper would not
// affect production code, which has its own wrapper.
import fs = require('node:fs');
import cp = require('node:child_process');
import tl = require('azure-pipelines-task-lib/task');

import { parseArgs, loadAdoEnv } from '../utils/args';
import { getValidatedTaskInputs } from '../utils/task-inputs';
import { resolvePrompt } from '../utils/prompt';
import { AdoClient } from '../ado-api/client';
import {
    fetchPrDetails, fetchPrIterations, fetchPrThreads, fetchPrCommits,
    filterCopilotThreads, formatPrDetailsText,
} from '../ado-api/pull-requests';
import {
    createComment, updateThreadStatus, updateCommentContent, deleteComment,
} from '../ado-api/comments';
import {
    fetchIterationChanges, fetchIterationDiffs, formatIterationDetailsText,
} from '../context/diff-fetcher';
import { checkCopilotCli, installCopilotCli } from '../agents/installer';
import { runCopilotCli } from '../agents/copilot';

import {
    MOCK_GITHUB_PAT, MOCK_ADO_PAT, MOCK_SYSTEM_TOKEN,
    MOCK_COLLECTION_URI, MOCK_PROJECT, MOCK_REPO, MOCK_PR_ID,
    MOCK_PROMPT_TEMPLATE, MOCK_WORKING_DIR,
    mockPrDetails, mockIterations, mockThreads, mockCommits, mockChangeEntries,
    makeMockChildProcess, makeFetchResponse,
} from './testSetup';

// =========================================================================
// Helpers
// =========================================================================

type TlInputs = Partial<Record<string, string | undefined>>;
type TlBoolInputs = Partial<Record<string, boolean>>;
type TlVariables = Partial<Record<string, string | undefined>>;

/**
 * Mocks the azure-pipelines-task-lib functions on the given test context.
 * Returns the spy on `tl.setResult` for assertion.
 */
function mockTaskLib(
    t: import('node:test').TestContext,
    overrides: { inputs?: TlInputs; boolInputs?: TlBoolInputs; variables?: TlVariables } = {}
): import('node:test').Mock<typeof tl.setResult> {
    const inputs: Record<string, string | undefined> = {
        githubPat: MOCK_GITHUB_PAT,
        azureDevOpsPat: undefined,
        organization: undefined,
        collectionUri: undefined,
        project: MOCK_PROJECT,
        repository: MOCK_REPO,
        pullRequestId: MOCK_PR_ID,
        timeout: '15',
        model: undefined,
        authors: undefined,
        prompt: undefined,
        promptFile: undefined,
        promptRaw: undefined,
        promptFileRaw: undefined,
        ...(overrides.inputs ?? {}),
    };
    const boolInputs: Record<string, boolean> = {
        useSystemAccessToken: false,
        ...(overrides.boolInputs ?? {}),
    };
    const variables: Record<string, string | undefined> = {
        'System.CollectionUri': MOCK_COLLECTION_URI,
        'System.AccessToken': MOCK_SYSTEM_TOKEN,
        'System.PullRequest.PullRequestId': MOCK_PR_ID,
        'Build.RequestedForEmail': 'test@example.com',
        ...(overrides.variables ?? {}),
    };

    t.mock.method(tl, 'getInput', ((name: string) => inputs[name]) as unknown as typeof tl.getInput);
    t.mock.method(tl, 'getBoolInput', ((name: string) => boolInputs[name] ?? false) as unknown as typeof tl.getBoolInput);
    t.mock.method(tl, 'getVariable', ((name: string) => variables[name]) as unknown as typeof tl.getVariable);
    return t.mock.method(tl, 'setResult', (() => {}) as unknown as typeof tl.setResult);
}

// =========================================================================
// utils/args
// =========================================================================
describe('utils/args', () => {
    describe('parseArgs', () => {
        it('returns empty object for empty args', () => {
            assert.deepStrictEqual(parseArgs([]), {});
        });

        it('parses --key value pairs', () => {
            assert.deepStrictEqual(
                parseArgs(['--comment', 'hello world']),
                { comment: 'hello world' }
            );
        });

        it('converts kebab-case keys to camelCase', () => {
            assert.deepStrictEqual(
                parseArgs(['--file-path', '/src/foo.ts', '--start-line', '10']),
                { filePath: '/src/foo.ts', startLine: '10' }
            );
        });

        it('parses multiple distinct arguments', () => {
            assert.deepStrictEqual(
                parseArgs(['--a', '1', '--b', '2', '--c', '3']),
                { a: '1', b: '2', c: '3' }
            );
        });

        it('ignores a trailing flag with no value', () => {
            assert.deepStrictEqual(
                parseArgs(['--foo', 'bar', '--orphan']),
                { foo: 'bar' }
            );
        });
    });

    describe('loadAdoEnv', () => {
        const VARS = ['AZUREDEVOPS_TOKEN', 'AZUREDEVOPS_AUTH_TYPE', 'AZUREDEVOPS_COLLECTION_URI', 'PROJECT', 'REPOSITORY', 'PRID'];

        function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
            const saved: Record<string, string | undefined> = {};
            for (const k of VARS) saved[k] = process.env[k];
            try {
                for (const k of VARS) {
                    if (overrides[k] === undefined && !(k in overrides)) {
                        process.env[k] = saved[k];
                    } else if (overrides[k] === undefined) {
                        delete process.env[k];
                    } else {
                        process.env[k] = overrides[k];
                    }
                }
                fn();
            } finally {
                for (const k of VARS) {
                    if (saved[k] === undefined) delete process.env[k];
                    else process.env[k] = saved[k];
                }
            }
        }

        const ALL_VARS_SET = {
            AZUREDEVOPS_TOKEN: 'tok',
            AZUREDEVOPS_AUTH_TYPE: 'Bearer',
            AZUREDEVOPS_COLLECTION_URI: MOCK_COLLECTION_URI,
            PROJECT: MOCK_PROJECT,
            REPOSITORY: MOCK_REPO,
            PRID: MOCK_PR_ID,
        };

        it('returns AdoEnv when all required vars are set', () => {
            withEnv(ALL_VARS_SET, () => {
                const env = loadAdoEnv('test');
                assert.ok(env !== null);
                assert.strictEqual(env.token, 'tok');
                assert.strictEqual(env.authType, 'Bearer');
                assert.strictEqual(env.project, MOCK_PROJECT);
            });
        });

        it('defaults authType to Basic when AZUREDEVOPS_AUTH_TYPE is absent', () => {
            withEnv({ ...ALL_VARS_SET, AZUREDEVOPS_AUTH_TYPE: undefined }, () => {
                const env = loadAdoEnv('test');
                assert.ok(env !== null);
                assert.strictEqual(env.authType, 'Basic');
            });
        });

        it('returns null when AZUREDEVOPS_TOKEN is missing', () => {
            withEnv({ ...ALL_VARS_SET, AZUREDEVOPS_TOKEN: undefined }, () => {
                assert.strictEqual(loadAdoEnv('test'), null);
            });
        });

        it('returns null when multiple required vars are missing', () => {
            withEnv({ ...ALL_VARS_SET, AZUREDEVOPS_TOKEN: undefined, PROJECT: undefined, REPOSITORY: undefined }, () => {
                assert.strictEqual(loadAdoEnv('test'), null);
            });
        });
    });
});

// =========================================================================
// utils/task-inputs
// =========================================================================
describe('utils/task-inputs', () => {
    it('returns inputs using system access token (Bearer auth)', (t) => {
        mockTaskLib(t, { boolInputs: { useSystemAccessToken: true } });
        const result = getValidatedTaskInputs();
        assert.ok(result !== null);
        assert.strictEqual(result.azureDevOpsAuthType, 'Bearer');
        assert.strictEqual(result.azureDevOpsToken, MOCK_SYSTEM_TOKEN);
        assert.strictEqual(result.githubPat, MOCK_GITHUB_PAT);
        assert.strictEqual(result.timeoutMinutes, 15);
    });

    it('returns inputs using ADO PAT (Basic auth)', (t) => {
        mockTaskLib(t, { inputs: { azureDevOpsPat: MOCK_ADO_PAT } });
        const result = getValidatedTaskInputs();
        assert.ok(result !== null);
        assert.strictEqual(result.azureDevOpsAuthType, 'Basic');
        assert.strictEqual(result.azureDevOpsToken, MOCK_ADO_PAT);
    });

    it('returns null when PR author is not in authors filter', (t) => {
        const setResultMock = mockTaskLib(t, {
            inputs: { authors: 'alice@example.com,bob@example.com' },
            variables: { 'Build.RequestedForEmail': 'charlie@example.com' },
        });
        assert.strictEqual(getValidatedTaskInputs(), null);
        assert.strictEqual(setResultMock.mock.callCount(), 1);
        assert.strictEqual(setResultMock.mock.calls[0].arguments[0], tl.TaskResult.Succeeded);
    });

    it('proceeds when PR author matches the authors filter', (t) => {
        mockTaskLib(t, {
            inputs: { authors: 'alice@example.com,test@example.com', azureDevOpsPat: MOCK_ADO_PAT },
            variables: { 'Build.RequestedForEmail': 'TEST@EXAMPLE.COM' },
        });
        assert.ok(getValidatedTaskInputs() !== null);
    });

    it('fails when githubPat is missing', (t) => {
        const setResultMock = mockTaskLib(t, {
            inputs: { githubPat: undefined, azureDevOpsPat: MOCK_ADO_PAT },
        });
        assert.strictEqual(getValidatedTaskInputs(), null);
        assert.strictEqual(setResultMock.mock.calls[0].arguments[0], tl.TaskResult.Failed);
    });

    it('fails when neither PAT nor useSystemAccessToken is configured', (t) => {
        const setResultMock = mockTaskLib(t, {
            inputs: { azureDevOpsPat: undefined },
            boolInputs: { useSystemAccessToken: false },
        });
        assert.strictEqual(getValidatedTaskInputs(), null);
        assert.strictEqual(setResultMock.mock.calls[0].arguments[0], tl.TaskResult.Failed);
    });

    it('fails when useSystemAccessToken is true but token is unavailable', (t) => {
        const setResultMock = mockTaskLib(t, {
            boolInputs: { useSystemAccessToken: true },
            variables: { 'System.AccessToken': undefined },
        });
        assert.strictEqual(getValidatedTaskInputs(), null);
        assert.strictEqual(setResultMock.mock.calls[0].arguments[0], tl.TaskResult.Failed);
    });

    it('resolves collectionUri from explicit collectionUri input', (t) => {
        mockTaskLib(t, {
            inputs: {
                collectionUri: 'https://tfs.contoso.com/tfs/DefaultCollection',
                azureDevOpsPat: MOCK_ADO_PAT,
            },
        });
        const result = getValidatedTaskInputs();
        assert.ok(result !== null);
        assert.strictEqual(result.resolvedCollectionUri, 'https://tfs.contoso.com/tfs/DefaultCollection');
    });

    it('resolves collectionUri from organization input', (t) => {
        mockTaskLib(t, {
            inputs: { organization: 'myorg', azureDevOpsPat: MOCK_ADO_PAT },
            variables: { 'System.CollectionUri': undefined },
        });
        const result = getValidatedTaskInputs();
        assert.ok(result !== null);
        assert.strictEqual(result.resolvedCollectionUri, 'https://dev.azure.com/myorg');
    });

    it('fails when collectionUri cannot be determined', (t) => {
        mockTaskLib(t, {
            inputs: { collectionUri: undefined, organization: undefined, azureDevOpsPat: MOCK_ADO_PAT },
            variables: { 'System.CollectionUri': undefined },
        });
        assert.strictEqual(getValidatedTaskInputs(), null);
    });

    it('fails when project is missing', (t) => {
        mockTaskLib(t, { inputs: { project: undefined, azureDevOpsPat: MOCK_ADO_PAT } });
        assert.strictEqual(getValidatedTaskInputs(), null);
    });

    it('fails when repository is missing', (t) => {
        mockTaskLib(t, { inputs: { repository: undefined, azureDevOpsPat: MOCK_ADO_PAT } });
        assert.strictEqual(getValidatedTaskInputs(), null);
    });

    it('falls back to System.PullRequest.PullRequestId when input is empty', (t) => {
        mockTaskLib(t, {
            inputs: { pullRequestId: '', azureDevOpsPat: MOCK_ADO_PAT },
            variables: { 'System.PullRequest.PullRequestId': '99' },
        });
        const result = getValidatedTaskInputs();
        assert.ok(result !== null);
        assert.strictEqual(result.pullRequestId, '99');
    });

    it('defaults timeout to 15 when input is invalid', (t) => {
        mockTaskLib(t, { inputs: { timeout: 'invalid', azureDevOpsPat: MOCK_ADO_PAT } });
        const result = getValidatedTaskInputs();
        assert.ok(result !== null);
        assert.strictEqual(result.timeoutMinutes, 15);
    });
});

// =========================================================================
// utils/prompt
// =========================================================================
describe('utils/prompt', () => {
    const baseConfig = {
        promptInput: undefined as string | undefined,
        promptFileInput: undefined as string | undefined,
        promptRawInput: undefined as string | undefined,
        promptFileRawInput: undefined as string | undefined,
        promptTemplatePath: MOCK_WORKING_DIR + '/prompt.txt',
        workingDir: MOCK_WORKING_DIR,
    };

    function setupPromptMocks(t: import('node:test').TestContext): {
        write: import('node:test').Mock<typeof fs.writeFileSync>;
    } {
        const write = t.mock.method(fs, 'writeFileSync', (() => {}) as unknown as typeof fs.writeFileSync);
        t.mock.method(process, 'exit', ((code?: number) => {
            throw new Error(`process.exit(${code}) called`);
        }) as unknown as typeof process.exit);
        t.mock.method(tl, 'setResult', (() => {}) as unknown as typeof tl.setResult);
        return { write };
    }

    it('writes default prompt with %CUSTOMPROMPT% removed', (t) => {
        const { write } = setupPromptMocks(t);
        t.mock.method(fs, 'readFileSync', (() => MOCK_PROMPT_TEMPLATE) as unknown as typeof fs.readFileSync);

        resolvePrompt(baseConfig);

        const written = write.mock.calls[0].arguments[1] as string;
        assert.ok(!written.includes('%CUSTOMPROMPT%'));
        assert.ok(written.includes('Review code:'));
    });

    it('injects inline prompt text in place of %CUSTOMPROMPT%', (t) => {
        const { write } = setupPromptMocks(t);
        t.mock.method(fs, 'readFileSync', (() => MOCK_PROMPT_TEMPLATE) as unknown as typeof fs.readFileSync);

        resolvePrompt({ ...baseConfig, promptInput: 'Focus on security' });

        const written = write.mock.calls[0].arguments[1] as string;
        assert.ok(written.includes('Focus on security'));
        assert.ok(!written.includes('%CUSTOMPROMPT%'));
    });

    it('writes raw prompt verbatim, bypassing template', (t) => {
        const { write } = setupPromptMocks(t);
        const raw = 'My verbatim prompt';

        resolvePrompt({ ...baseConfig, promptRawInput: raw });

        assert.strictEqual(write.mock.calls[0].arguments[1], raw);
    });

    it('reads and writes raw prompt file content verbatim', (t) => {
        const { write } = setupPromptMocks(t);
        t.mock.method(fs, 'existsSync', (() => true) as unknown as typeof fs.existsSync);
        t.mock.method(fs, 'statSync', (() => ({ isFile: () => true })) as unknown as typeof fs.statSync);
        t.mock.method(fs, 'readFileSync', (() => 'Raw content') as unknown as typeof fs.readFileSync);

        resolvePrompt({ ...baseConfig, promptFileRawInput: '/path/to/raw.txt' });

        assert.strictEqual(write.mock.calls[0].arguments[1], 'Raw content');
    });

    it('reads prompt from file and injects into template', (t) => {
        const { write } = setupPromptMocks(t);
        t.mock.method(fs, 'existsSync', (() => true) as unknown as typeof fs.existsSync);
        t.mock.method(fs, 'statSync', (() => ({ isFile: () => true })) as unknown as typeof fs.statSync);
        t.mock.method(fs, 'readFileSync', ((p: fs.PathOrFileDescriptor) =>
            String(p).endsWith('prompt.txt') ? MOCK_PROMPT_TEMPLATE : 'Custom file content'
        ) as unknown as typeof fs.readFileSync);

        resolvePrompt({ ...baseConfig, promptFileInput: '/path/to/custom.txt' });

        const written = write.mock.calls[0].arguments[1] as string;
        assert.ok(written.includes('Custom file content'));
        assert.ok(!written.includes('%CUSTOMPROMPT%'));
    });

    it('exits when multiple prompt inputs are set', (t) => {
        setupPromptMocks(t);
        t.mock.method(fs, 'readFileSync', (() => '') as unknown as typeof fs.readFileSync);

        assert.throws(
            () => resolvePrompt({ ...baseConfig, promptInput: 'a', promptRawInput: 'b' }),
            /process\.exit/
        );
    });

    it('exits when prompt text contains double quotes', (t) => {
        setupPromptMocks(t);
        t.mock.method(fs, 'readFileSync', (() => MOCK_PROMPT_TEMPLATE) as unknown as typeof fs.readFileSync);

        assert.throws(
            () => resolvePrompt({ ...baseConfig, promptInput: 'Use "quotes"' }),
            /process\.exit/
        );
    });

    it('exits when prompt file is empty', (t) => {
        setupPromptMocks(t);
        t.mock.method(fs, 'existsSync', (() => true) as unknown as typeof fs.existsSync);
        t.mock.method(fs, 'statSync', (() => ({ isFile: () => true })) as unknown as typeof fs.statSync);
        t.mock.method(fs, 'readFileSync', ((p: fs.PathOrFileDescriptor) =>
            String(p).endsWith('prompt.txt') ? MOCK_PROMPT_TEMPLATE : '   '
        ) as unknown as typeof fs.readFileSync);

        assert.throws(
            () => resolvePrompt({ ...baseConfig, promptFileInput: '/empty.txt' }),
            /process\.exit/
        );
    });

    it('returns the output file path', (t) => {
        setupPromptMocks(t);
        t.mock.method(fs, 'readFileSync', (() => MOCK_PROMPT_TEMPLATE) as unknown as typeof fs.readFileSync);

        const result = resolvePrompt(baseConfig);
        assert.ok(result.endsWith('_copilot_prompt.txt'));
        assert.ok(result.includes('agent-work'));
    });
});

// =========================================================================
// ado-api/AdoClient
// =========================================================================
describe('ado-api/AdoClient', () => {
    function makeClient(token = 'my-token', authType: 'Bearer' | 'Basic' = 'Bearer'): AdoClient {
        return new AdoClient({ collectionUri: MOCK_COLLECTION_URI, project: MOCK_PROJECT, token, authType });
    }

    it('constructs Bearer authorization header', async (t) => {
        const fetchMock = t.mock.method(globalThis, 'fetch', (async () => makeFetchResponse({ ok: true })) as unknown as typeof fetch);
        await makeClient('tok', 'Bearer').get('/test');
        const headers = (fetchMock.mock.calls[0].arguments[1] as RequestInit).headers as Record<string, string>;
        assert.strictEqual(headers['Authorization'], 'Bearer tok');
    });

    it('constructs Basic authorization header as base64(:<token>)', async (t) => {
        const fetchMock = t.mock.method(globalThis, 'fetch', (async () => makeFetchResponse({ ok: true })) as unknown as typeof fetch);
        await makeClient('tok', 'Basic').get('/test');
        const headers = (fetchMock.mock.calls[0].arguments[1] as RequestInit).headers as Record<string, string>;
        assert.strictEqual(headers['Authorization'], 'Basic ' + Buffer.from(':tok').toString('base64'));
    });

    it('appends api-version=7.1 query parameter', async (t) => {
        const fetchMock = t.mock.method(globalThis, 'fetch', (async () => makeFetchResponse({ ok: true })) as unknown as typeof fetch);
        await makeClient().get('/git/repositories');
        const url = fetchMock.mock.calls[0].arguments[0] as string;
        assert.ok(url.includes('api-version=7.1'), `expected api-version in URL: ${url}`);
    });

    it('uses absolute URL as-is when path starts with http', async (t) => {
        const fetchMock = t.mock.method(globalThis, 'fetch', (async () => makeFetchResponse('text')) as unknown as typeof fetch);
        const absUrl = 'https://dev.azure.com/org/proj/_apis/x?api-version=7.1';
        await makeClient().getRawText(absUrl);
        assert.strictEqual(fetchMock.mock.calls[0].arguments[0], absUrl);
    });

    it('throws auth error on 401', async (t) => {
        t.mock.method(globalThis, 'fetch', (async () => makeFetchResponse({ message: 'Unauthorized' }, 401)) as unknown as typeof fetch);
        await assert.rejects(() => makeClient().get('/test'), /Authentication failed/);
    });

    it('throws not-found error on 404', async (t) => {
        t.mock.method(globalThis, 'fetch', (async () => makeFetchResponse({ message: 'Not found' }, 404)) as unknown as typeof fetch);
        await assert.rejects(() => makeClient().get('/test'), /Resource not found/);
    });

    it('throws generic API error for other failures', async (t) => {
        t.mock.method(globalThis, 'fetch', (async () => makeFetchResponse({ message: 'Bad' }, 400)) as unknown as typeof fetch);
        await assert.rejects(() => makeClient().get('/test'), /Azure DevOps API error/);
    });

    it('getCollectionUri strips trailing slashes', () => {
        const client = new AdoClient({
            collectionUri: 'https://dev.azure.com/myorg/',
            project: MOCK_PROJECT, token: 'tok', authType: 'Bearer',
        });
        assert.strictEqual(client.getCollectionUri(), 'https://dev.azure.com/myorg');
    });

    it('getProject returns the configured project', () => {
        assert.strictEqual(makeClient().getProject(), MOCK_PROJECT);
    });
});

// =========================================================================
// ado-api/pull-requests
// =========================================================================
describe('ado-api/pull-requests', () => {
    function makeClient(): AdoClient {
        return new AdoClient({ collectionUri: MOCK_COLLECTION_URI, project: MOCK_PROJECT, token: 'tok', authType: 'Bearer' });
    }

    describe('fetchers', () => {
        it('fetchPrDetails calls get with repo + PR ID in URL', async (t) => {
            const client = makeClient();
            const getMock = t.mock.method(client, 'get', (async () => mockPrDetails) as typeof client.get);
            const result = await fetchPrDetails(client, MOCK_REPO, 42);
            const callPath = getMock.mock.calls[0].arguments[0] as string;
            assert.ok(callPath.includes('MyRepo'));
            assert.ok(callPath.includes('42'));
            assert.deepStrictEqual(result, mockPrDetails);
        });

        it('fetchPrIterations returns the value array', async (t) => {
            const client = makeClient();
            t.mock.method(client, 'get', (async () => ({ value: mockIterations })) as typeof client.get);
            assert.deepStrictEqual(await fetchPrIterations(client, MOCK_REPO, 42), mockIterations);
        });

        it('fetchPrIterations returns [] when value is absent', async (t) => {
            const client = makeClient();
            t.mock.method(client, 'get', (async () => ({})) as typeof client.get);
            assert.deepStrictEqual(await fetchPrIterations(client, MOCK_REPO, 42), []);
        });

        it('fetchPrThreads returns the value array', async (t) => {
            const client = makeClient();
            t.mock.method(client, 'get', (async () => ({ value: mockThreads })) as typeof client.get);
            assert.deepStrictEqual(await fetchPrThreads(client, MOCK_REPO, 42), mockThreads);
        });

        it('fetchPrCommits returns the value array', async (t) => {
            const client = makeClient();
            t.mock.method(client, 'get', (async () => ({ value: mockCommits })) as typeof client.get);
            assert.deepStrictEqual(await fetchPrCommits(client, MOCK_REPO, 42), mockCommits);
        });
    });

    describe('filterCopilotThreads', () => {
        it('includes threads authored by Build Service', () => {
            const result = filterCopilotThreads(mockThreads);
            assert.ok(result.some(t => t.threadId === 101));
        });

        it('includes threads with [Generated by GitHub Copilot] tag', () => {
            const result = filterCopilotThreads(mockThreads);
            assert.ok(result.some(t => t.content.includes('[Generated by GitHub Copilot]')));
        });

        it('includes threads with [Generated by Claude Code] tag', () => {
            const result = filterCopilotThreads(mockThreads);
            assert.ok(result.some(t => t.content.includes('[Generated by Claude Code]')));
        });

        it('excludes regular user comment threads', () => {
            const result = filterCopilotThreads(mockThreads);
            assert.ok(!result.some(t => t.threadId === 103));
        });

        it('excludes threads where first comment is a system comment', () => {
            const result = filterCopilotThreads(mockThreads);
            assert.ok(!result.some(t => t.threadId === 104));
        });

        it('maps filePath and startLine from threadContext', () => {
            const result = filterCopilotThreads(mockThreads);
            const found = result.find(x => x.threadId === 101);
            assert.ok(found !== undefined);
            assert.strictEqual(found.filePath, '/src/index.ts');
            assert.strictEqual(found.startLine, 10);
        });

        it('includes non-system replies', () => {
            const result = filterCopilotThreads(mockThreads);
            const found = result.find(x => x.threadId === 102);
            assert.ok(found !== undefined);
            assert.strictEqual(found.replies.length, 1);
            assert.strictEqual(found.replies[0].author, 'John Doe');
        });
    });

    describe('formatPrDetailsText', () => {
        it('includes PR title and ID', () => {
            const text = formatPrDetailsText(mockPrDetails, mockThreads, mockIterations, [], MOCK_COLLECTION_URI);
            assert.ok(text.includes('Add new feature'));
            assert.ok(text.includes('#42'));
        });

        it('strips refs/heads/ prefix from branch names', () => {
            const text = formatPrDetailsText(mockPrDetails, mockThreads, mockIterations, [], MOCK_COLLECTION_URI);
            assert.ok(text.includes('feature/test'));
            assert.ok(text.includes('main'));
            assert.ok(!text.includes('refs/heads/'));
        });

        it('includes reviewer name and vote label', () => {
            const text = formatPrDetailsText(mockPrDetails, mockThreads, mockIterations, [], MOCK_COLLECTION_URI);
            assert.ok(text.includes('Jane Smith'));
            assert.ok(text.includes('Approved'));
        });

        it('shows placeholder when description is empty', () => {
            const pr = { ...mockPrDetails, description: '' };
            const text = formatPrDetailsText(pr, [], mockIterations, [], MOCK_COLLECTION_URI);
            assert.ok(text.includes('No description provided'));
        });

        it('appends Copilot threads JSON when copilotThreads is non-empty', () => {
            const ct = filterCopilotThreads(mockThreads);
            const text = formatPrDetailsText(mockPrDetails, mockThreads, mockIterations, ct, MOCK_COLLECTION_URI);
            assert.ok(text.includes('COPILOT COMMENT THREADS (JSON)'));
        });

        it('omits Copilot threads section when empty', () => {
            const text = formatPrDetailsText(mockPrDetails, mockThreads, mockIterations, [], MOCK_COLLECTION_URI);
            assert.ok(!text.includes('COPILOT COMMENT THREADS'));
        });
    });
});

// =========================================================================
// ado-api/comments
// =========================================================================
describe('ado-api/comments', () => {
    const mockThreadResult = {
        id: 10,
        comments: [{ id: 1, author: { displayName: 'Build Service' }, publishedDate: '2024-01-15T12:00:00Z' }],
    };

    function makeClient(): AdoClient {
        return new AdoClient({ collectionUri: MOCK_COLLECTION_URI, project: MOCK_PROJECT, token: 'tok', authType: 'Bearer' });
    }

    it('createComment creates a new general thread', async (t) => {
        const client = makeClient();
        const postMock = t.mock.method(client, 'post', (async () => mockThreadResult) as typeof client.post);
        const result = await createComment(client, MOCK_REPO, 42, { comment: 'Test comment' });
        assert.strictEqual(postMock.mock.callCount(), 1);
        assert.strictEqual(result.threadId, 10);
        assert.strictEqual(result.commentId, 1);
        assert.strictEqual(result.author, 'Build Service');
    });

    it('createComment adds threadContext for inline comments', async (t) => {
        const client = makeClient();
        const postMock = t.mock.method(client, 'post', (async () => mockThreadResult) as typeof client.post);
        await createComment(client, MOCK_REPO, 42, { comment: 'Inline', filePath: 'src/foo.ts', startLine: 5 });
        const body = postMock.mock.calls[0].arguments[1] as Record<string, unknown>;
        const ctx = body['threadContext'] as Record<string, unknown>;
        assert.ok(ctx);
        assert.ok((ctx['filePath'] as string).startsWith('/'));
    });

    it('createComment replies to existing thread when threadId is provided', async (t) => {
        const client = makeClient();
        const replyResult = { id: 2, author: { displayName: 'Bot' }, publishedDate: '2024-01-15T12:00:00Z' };
        const postMock = t.mock.method(client, 'post', (async () => replyResult) as typeof client.post);
        const result = await createComment(client, MOCK_REPO, 42, { comment: 'Reply', threadId: 5 });
        assert.strictEqual(result.threadId, 5);
        assert.strictEqual(result.commentId, 2);
        const url = postMock.mock.calls[0].arguments[0] as string;
        assert.ok(url.includes('threads/5/comments'));
    });

    it('createComment falls back to generic comment when inline post fails', async (t) => {
        const client = makeClient();
        let call = 0;
        const postMock = t.mock.method(client, 'post', (async () => {
            call++;
            if (call === 1) throw new Error('inline failed');
            return mockThreadResult;
        }) as typeof client.post);
        const result = await createComment(client, MOCK_REPO, 42, { comment: 'Inline', filePath: 'src/bar.ts', startLine: 10 });
        assert.strictEqual(postMock.mock.callCount(), 2);
        assert.strictEqual(result.threadId, 10);
    });

    it('updateThreadStatus patches with the correct status string', async (t) => {
        const client = makeClient();
        const patchMock = t.mock.method(client, 'patch', (async () => ({})) as typeof client.patch);
        await updateThreadStatus(client, MOCK_REPO, 42, 7, 'Fixed');
        const body = patchMock.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(body['status'], 'fixed');
    });

    it('updateThreadStatus does not throw when API fails', async (t) => {
        const client = makeClient();
        t.mock.method(client, 'patch', (async () => { throw new Error('network'); }) as typeof client.patch);
        await assert.doesNotReject(() => updateThreadStatus(client, MOCK_REPO, 42, 7, 'Fixed'));
    });

    it('updateCommentContent patches the comment content', async (t) => {
        const client = makeClient();
        const patchMock = t.mock.method(client, 'patch', (async () => ({})) as typeof client.patch);
        await updateCommentContent(client, MOCK_REPO, 42, 7, 1, 'Updated text');
        const body = patchMock.mock.calls[0].arguments[1] as Record<string, unknown>;
        assert.strictEqual(body['content'], 'Updated text');
    });

    it('deleteComment calls delete with correct URL', async (t) => {
        const client = makeClient();
        const delMock = t.mock.method(client, 'delete', (async () => {}) as typeof client.delete);
        await deleteComment(client, MOCK_REPO, 42, 7, 1);
        const url = delMock.mock.calls[0].arguments[0] as string;
        assert.ok(url.includes('threads/7/comments/1'));
    });

    it('deleteComment does not throw when API fails', async (t) => {
        const client = makeClient();
        t.mock.method(client, 'delete', (async () => { throw new Error('network'); }) as typeof client.delete);
        await assert.doesNotReject(() => deleteComment(client, MOCK_REPO, 42, 7, 1));
    });
});

// =========================================================================
// context/diff-fetcher
// =========================================================================
describe('context/diff-fetcher', () => {
    function makeClient(): AdoClient {
        return new AdoClient({ collectionUri: MOCK_COLLECTION_URI, project: MOCK_PROJECT, token: 'tok', authType: 'Bearer' });
    }

    it('fetchIterationChanges hits iterations/changes endpoint', async (t) => {
        const client = makeClient();
        const getMock = t.mock.method(client, 'get', (async () => ({ changeEntries: mockChangeEntries })) as typeof client.get);
        await fetchIterationChanges(client, MOCK_REPO, 42, 1);
        const url = getMock.mock.calls[0].arguments[0] as string;
        assert.ok(url.includes('iterations/1/changes'));
    });

    it('fetchIterationChanges filters out folder entries', async (t) => {
        const client = makeClient();
        t.mock.method(client, 'get', (async () => ({ changeEntries: mockChangeEntries })) as typeof client.get);
        const result = await fetchIterationChanges(client, MOCK_REPO, 42, 1);
        assert.strictEqual(result.length, 3);
        assert.ok(result.every(c => !c.item.isFolder));
    });

    it('fetchIterationChanges returns [] when changeEntries is absent', async (t) => {
        const client = makeClient();
        t.mock.method(client, 'get', (async () => ({})) as typeof client.get);
        assert.deepStrictEqual(await fetchIterationChanges(client, MOCK_REPO, 42, 1), []);
    });

    it('fetchIterationDiffs maps git diff output to change entries', (t) => {
        const mockDiff = [
            'diff --git a/src/index.ts b/src/index.ts',
            '--- a/src/index.ts',
            '+++ b/src/index.ts',
            '@@ -1 +1 @@',
            '-old',
            '+new',
        ].join('\n');

        t.mock.method(cp, 'execFileSync', ((_cmd: string, args: string[]) => {
            if (args[0] === 'cat-file') return 'commit';
            if (args[0] === 'diff') return mockDiff;
            return '';
        }) as unknown as typeof cp.execFileSync);

        const entries = [{ changeType: 'edit', item: { path: '/src/index.ts' } }];
        const diffs = fetchIterationDiffs(entries, 'abc', 'def', process.cwd());
        assert.strictEqual(diffs.length, 1);
        assert.strictEqual(diffs[0].path, '/src/index.ts');
        assert.ok(diffs[0].diffContent.includes('diff --git'));
    });

    it('fetchIterationDiffs returns placeholder when no diff matches', (t) => {
        t.mock.method(cp, 'execFileSync', ((_cmd: string, args: string[]) => {
            if (args[0] === 'cat-file') return 'commit';
            return '';
        }) as unknown as typeof cp.execFileSync);

        const entries = [{ changeType: 'add', item: { path: '/src/brand-new.ts' } }];
        const diffs = fetchIterationDiffs(entries, 'abc', 'def', process.cwd());
        assert.strictEqual(diffs[0].diffContent, '(No diff content available)');
    });

    describe('formatIterationDetailsText', () => {
        const iter = mockIterations[0];
        const noDiffs: import('../context/diff-fetcher').FileDiff[] = [];

        it('includes the iteration ID heading', () => {
            const text = formatIterationDetailsText(1, iter, mockCommits, [], noDiffs, MOCK_COLLECTION_URI, MOCK_PROJECT, MOCK_REPO, 42);
            assert.ok(text.includes('ITERATION #1'));
        });

        it('includes commit short SHA and message', () => {
            const text = formatIterationDetailsText(1, iter, mockCommits, [], noDiffs, MOCK_COLLECTION_URI, MOCK_PROJECT, MOCK_REPO, 42);
            assert.ok(text.includes('abc123de'));
            assert.ok(text.includes('feat: implement new feature'));
        });

        it('shows "No commits found" when commits is empty', () => {
            const text = formatIterationDetailsText(1, iter, [], [], noDiffs, MOCK_COLLECTION_URI, MOCK_PROJECT, MOCK_REPO, 42);
            assert.ok(text.includes('No commits found'));
        });

        it('reports total file change count', () => {
            const entries = [
                { changeType: 'add', item: { path: '/src/a.ts' } },
                { changeType: 'edit', item: { path: '/src/b.ts' } },
            ];
            const diffs = entries.map(e => ({
                path: e.item.path, changeType: e.changeType,
                originalPath: undefined, diffContent: '',
            }));
            const text = formatIterationDetailsText(1, iter, mockCommits, entries, diffs, MOCK_COLLECTION_URI, MOCK_PROJECT, MOCK_REPO, 42);
            assert.ok(text.includes('Total files changed: 2'));
        });

        it('shows "No file changes found" when entries empty', () => {
            const text = formatIterationDetailsText(1, iter, mockCommits, [], noDiffs, MOCK_COLLECTION_URI, MOCK_PROJECT, MOCK_REPO, 42);
            assert.ok(text.includes('No file changes found'));
        });
    });
});

// =========================================================================
// agents/installer
// =========================================================================
describe('agents/installer', () => {
    it('checkCopilotCli returns true when binary runs', async (t) => {
        t.mock.method(cp, 'execFileSync', (() => Buffer.from('copilot 1.2.3')) as unknown as typeof cp.execFileSync);
        assert.strictEqual(await checkCopilotCli(), true);
    });

    it('checkCopilotCli returns false when binary throws', async (t) => {
        t.mock.method(cp, 'execFileSync', (() => { throw new Error('ENOENT'); }) as unknown as typeof cp.execFileSync);
        assert.strictEqual(await checkCopilotCli(), false);
    });

    it('installCopilotCli resolves on exit code 0', async (t) => {
        t.mock.method(cp, 'spawn', (() => makeMockChildProcess({ exitCode: 0 })) as unknown as typeof cp.spawn);
        await assert.doesNotReject(() => installCopilotCli());
    });

    it('installCopilotCli rejects on non-zero exit code', async (t) => {
        t.mock.method(cp, 'spawn', (() => makeMockChildProcess({ exitCode: 1 })) as unknown as typeof cp.spawn);
        await assert.rejects(() => installCopilotCli(), /Failed to install GitHub Copilot CLI/);
    });

    it('installCopilotCli rejects on spawn error event', async (t) => {
        t.mock.method(cp, 'spawn', (() => makeMockChildProcess({ error: new Error('spawn ENOENT') })) as unknown as typeof cp.spawn);
        await assert.rejects(() => installCopilotCli(), /Failed to install GitHub Copilot CLI/);
    });

    it('installCopilotCli suppresses known noise lines', async (t) => {
        const noise = 'Terms of Transaction:\nDownloading...\n';
        t.mock.method(cp, 'spawn', (() => makeMockChildProcess({ exitCode: 0, stdout: noise })) as unknown as typeof cp.spawn);
        const logged: string[] = [];
        t.mock.method(console, 'log', ((...args: unknown[]) => { logged.push(args.join(' ')); }) as unknown as typeof console.log);

        await installCopilotCli();

        assert.ok(!logged.some(l => l.includes('Terms of Transaction')));
    });
});

// =========================================================================
// agents/copilot
// =========================================================================
describe('agents/copilot', () => {
    const PROMPT_PATH = '/tmp/prompt.txt';
    const PROMPT_CONTENT = 'Review the PR.';

    it('spawns copilot with required flags and prompt content', async (t) => {
        t.mock.method(cp, 'execFileSync', (() => Buffer.from('')) as unknown as typeof cp.execFileSync);
        t.mock.method(fs, 'readFileSync', (() => PROMPT_CONTENT) as unknown as typeof fs.readFileSync);
        const spawnMock = t.mock.method(cp, 'spawn', (() => makeMockChildProcess({ exitCode: 0 })) as unknown as typeof cp.spawn);

        await runCopilotCli(PROMPT_PATH, undefined, MOCK_WORKING_DIR, 60000);

        const args = spawnMock.mock.calls[0].arguments[1] as string[];
        assert.ok(args.includes('-p'));
        assert.ok(args.includes(PROMPT_CONTENT));
        assert.ok(args.includes('--allow-all-paths'));
        assert.ok(args.includes('--allow-all-tools'));
        assert.ok(args.includes('--deny-tool'));
        assert.ok(args.includes('--no-color'));
    });

    it('adds --model flag when a model is specified', async (t) => {
        t.mock.method(cp, 'execFileSync', (() => Buffer.from('')) as unknown as typeof cp.execFileSync);
        t.mock.method(fs, 'readFileSync', (() => PROMPT_CONTENT) as unknown as typeof fs.readFileSync);
        const spawnMock = t.mock.method(cp, 'spawn', (() => makeMockChildProcess({ exitCode: 0 })) as unknown as typeof cp.spawn);

        await runCopilotCli(PROMPT_PATH, 'claude-sonnet', MOCK_WORKING_DIR, 60000);

        const args = spawnMock.mock.calls[0].arguments[1] as string[];
        const idx = args.indexOf('--model');
        assert.ok(idx !== -1);
        assert.strictEqual(args[idx + 1], 'claude-sonnet');
    });

    it('resolves on exit code 0', async (t) => {
        t.mock.method(cp, 'execFileSync', (() => Buffer.from('')) as unknown as typeof cp.execFileSync);
        t.mock.method(fs, 'readFileSync', (() => PROMPT_CONTENT) as unknown as typeof fs.readFileSync);
        t.mock.method(cp, 'spawn', (() => makeMockChildProcess({ exitCode: 0 })) as unknown as typeof cp.spawn);
        await assert.doesNotReject(() => runCopilotCli(PROMPT_PATH, undefined, MOCK_WORKING_DIR, 60000));
    });

    it('rejects on non-zero exit code', async (t) => {
        t.mock.method(cp, 'execFileSync', (() => Buffer.from('')) as unknown as typeof cp.execFileSync);
        t.mock.method(fs, 'readFileSync', (() => PROMPT_CONTENT) as unknown as typeof fs.readFileSync);
        t.mock.method(cp, 'spawn', (() => makeMockChildProcess({ exitCode: 2 })) as unknown as typeof cp.spawn);
        await assert.rejects(
            () => runCopilotCli(PROMPT_PATH, undefined, MOCK_WORKING_DIR, 60000),
            /Copilot CLI exited with code: 2/
        );
    });

    it('rejects on spawn error event', async (t) => {
        t.mock.method(cp, 'execFileSync', (() => Buffer.from('')) as unknown as typeof cp.execFileSync);
        t.mock.method(fs, 'readFileSync', (() => PROMPT_CONTENT) as unknown as typeof fs.readFileSync);
        t.mock.method(cp, 'spawn', (() => makeMockChildProcess({ error: new Error('spawn ENOENT') })) as unknown as typeof cp.spawn);
        await assert.rejects(
            () => runCopilotCli(PROMPT_PATH, undefined, MOCK_WORKING_DIR, 60000),
            /Failed to run Copilot CLI/
        );
    });

    it('rejects with timeout when process hangs', async (t) => {
        t.mock.method(cp, 'execFileSync', (() => Buffer.from('')) as unknown as typeof cp.execFileSync);
        t.mock.method(fs, 'readFileSync', (() => PROMPT_CONTENT) as unknown as typeof fs.readFileSync);
        t.mock.method(console, 'log', (() => {}) as unknown as typeof console.log);

        // Hanging process: never emits close/error
        const proc = new EventEmitter();
        (proc as any).stdout = new EventEmitter();
        (proc as any).stderr = new EventEmitter();
        (proc as any).kill = () => true;
        t.mock.method(cp, 'spawn', (() => proc as unknown as cp.ChildProcess) as unknown as typeof cp.spawn);

        await assert.rejects(
            () => runCopilotCli(PROMPT_PATH, undefined, MOCK_WORKING_DIR, 150),
            /timed out/
        );
    });
});
