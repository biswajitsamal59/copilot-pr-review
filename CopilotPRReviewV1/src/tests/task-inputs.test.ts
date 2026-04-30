import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockTl = vi.hoisted(() => ({
    getInput: vi.fn<[string, boolean?], string | null>(),
    getVariable: vi.fn<[string], string | undefined>(),
    getBoolInput: vi.fn<[string, boolean?], boolean>(),
    setResult: vi.fn<[number, string], void>(),
    TaskResult: { Succeeded: 0, Failed: 1, PartiallySucceeded: 2 } as const,
}))

vi.mock('azure-pipelines-task-lib/task', () => mockTl)

// Import after mock is declared so the module gets the mocked version
const { getValidatedTaskInputs } = await import('../utils/task-inputs')

describe('getValidatedTaskInputs', () => {
    function setupValidInputs() {
        mockTl.getBoolInput.mockReturnValue(false)
        mockTl.getInput.mockImplementation((key: string) => {
            const values: Record<string, string> = {
                azureDevOpsPat: 'pat123',
                collectionUri: 'https://dev.azure.com/org',
                githubPat: 'ghp_token',
                project: 'MyProject',
                repository: 'MyRepo',
                pullRequestId: '42',
                timeout: '15',
            }
            return values[key] ?? null
        })
        mockTl.getVariable.mockReturnValue(undefined)
    }

    beforeEach(() => {
        vi.resetAllMocks()
    })

    it('returns validated inputs for a complete valid configuration', () => {
        setupValidInputs()

        const result = getValidatedTaskInputs()

        expect(result).not.toBeNull()
        expect(result?.githubPat).toBe('ghp_token')
        expect(result?.project).toBe('MyProject')
        expect(result?.repository).toBe('MyRepo')
        expect(result?.pullRequestId).toBe('42')
        expect(result?.azureDevOpsToken).toBe('pat123')
        expect(result?.azureDevOpsAuthType).toBe('Basic')
        expect(result?.timeoutMinutes).toBe(15)
    })

    it('returns null and skips when author filter excludes current PR author', () => {
        mockTl.getInput.mockImplementation((key: string) => key === 'authors' ? 'alice@example.com' : null)
        mockTl.getVariable.mockImplementation((key: string) =>
            key === 'Build.RequestedForEmail' ? 'bob@example.com' : undefined
        )

        const result = getValidatedTaskInputs()

        expect(result).toBeNull()
        expect(mockTl.setResult).toHaveBeenCalledWith(mockTl.TaskResult.Succeeded, expect.any(String))
    })

    it('proceeds when PR author is in the authors list', () => {
        mockTl.getInput.mockImplementation((key: string) => {
            if (key === 'authors') return 'alice@example.com,bob@example.com'
            const values: Record<string, string> = {
                azureDevOpsPat: 'pat',
                collectionUri: 'https://dev.azure.com/org',
                githubPat: 'ghp',
                project: 'P',
                repository: 'R',
                pullRequestId: '1',
                timeout: '10',
            }
            return values[key] ?? null
        })
        mockTl.getBoolInput.mockReturnValue(false)
        mockTl.getVariable.mockImplementation((key: string) =>
            key === 'Build.RequestedForEmail' ? 'bob@example.com' : undefined
        )

        expect(getValidatedTaskInputs()).not.toBeNull()
    })

    it('uses System.AccessToken with Bearer auth when useSystemAccessToken is true', () => {
        mockTl.getBoolInput.mockReturnValue(true)
        mockTl.getInput.mockImplementation((key: string) => {
            const values: Record<string, string> = {
                collectionUri: 'https://dev.azure.com/org',
                githubPat: 'ghp',
                project: 'P',
                repository: 'R',
                pullRequestId: '1',
            }
            return values[key] ?? null
        })
        mockTl.getVariable.mockImplementation((key: string) =>
            key === 'System.AccessToken' ? 'sys_token' : undefined
        )

        const result = getValidatedTaskInputs()

        expect(result?.azureDevOpsToken).toBe('sys_token')
        expect(result?.azureDevOpsAuthType).toBe('Bearer')
    })

    it('returns null when useSystemAccessToken is true but System.AccessToken is missing', () => {
        mockTl.getBoolInput.mockReturnValue(true)
        mockTl.getInput.mockReturnValue(null)
        mockTl.getVariable.mockReturnValue(undefined)

        expect(getValidatedTaskInputs()).toBeNull()
        expect(mockTl.setResult).toHaveBeenCalledWith(mockTl.TaskResult.Failed, expect.any(String))
    })

    it('returns null when neither PAT nor system token is provided', () => {
        mockTl.getBoolInput.mockReturnValue(false)
        mockTl.getInput.mockReturnValue(null)
        mockTl.getVariable.mockReturnValue(undefined)

        expect(getValidatedTaskInputs()).toBeNull()
        expect(mockTl.setResult).toHaveBeenCalledWith(mockTl.TaskResult.Failed, expect.any(String))
    })

    it('resolves collectionUri from organization input', () => {
        mockTl.getBoolInput.mockReturnValue(false)
        mockTl.getInput.mockImplementation((key: string) => {
            const values: Record<string, string> = {
                azureDevOpsPat: 'pat',
                organization: 'myorg',
                githubPat: 'ghp',
                project: 'P',
                repository: 'R',
                pullRequestId: '1',
            }
            return values[key] ?? null
        })
        mockTl.getVariable.mockReturnValue(undefined)

        const result = getValidatedTaskInputs()
        expect(result?.resolvedCollectionUri).toBe('https://dev.azure.com/myorg')
    })

    it('resolves collectionUri from System.CollectionUri variable', () => {
        mockTl.getBoolInput.mockReturnValue(false)
        mockTl.getInput.mockImplementation((key: string) => {
            const values: Record<string, string> = {
                azureDevOpsPat: 'pat',
                githubPat: 'ghp',
                project: 'P',
                repository: 'R',
                pullRequestId: '1',
            }
            return values[key] ?? null
        })
        mockTl.getVariable.mockImplementation((key: string) =>
            key === 'System.CollectionUri' ? 'https://dev.azure.com/fromenv/' : undefined
        )

        const result = getValidatedTaskInputs()
        expect(result?.resolvedCollectionUri).toBe('https://dev.azure.com/fromenv')
    })

    it('returns null when githubPat is missing', () => {
        mockTl.getBoolInput.mockReturnValue(false)
        mockTl.getInput.mockImplementation((key: string) => {
            const values: Record<string, string> = {
                azureDevOpsPat: 'pat',
                collectionUri: 'https://dev.azure.com/org',
                project: 'P',
                repository: 'R',
                pullRequestId: '1',
            }
            return values[key] ?? null
        })
        mockTl.getVariable.mockReturnValue(undefined)

        expect(getValidatedTaskInputs()).toBeNull()
        expect(mockTl.setResult).toHaveBeenCalledWith(mockTl.TaskResult.Failed, expect.any(String))
    })

    it('returns null when project is missing', () => {
        mockTl.getBoolInput.mockReturnValue(false)
        mockTl.getInput.mockImplementation((key: string) => {
            const values: Record<string, string> = {
                azureDevOpsPat: 'pat',
                collectionUri: 'https://dev.azure.com/org',
                githubPat: 'ghp',
            }
            return values[key] ?? null
        })
        mockTl.getVariable.mockReturnValue(undefined)

        expect(getValidatedTaskInputs()).toBeNull()
    })

    it('falls back to System.PullRequest.PullRequestId when pullRequestId input is missing', () => {
        mockTl.getBoolInput.mockReturnValue(false)
        mockTl.getInput.mockImplementation((key: string) => {
            const values: Record<string, string> = {
                azureDevOpsPat: 'pat',
                collectionUri: 'https://dev.azure.com/org',
                githubPat: 'ghp',
                project: 'P',
                repository: 'R',
            }
            return values[key] ?? null
        })
        mockTl.getVariable.mockImplementation((key: string) =>
            key === 'System.PullRequest.PullRequestId' ? '99' : undefined
        )

        const result = getValidatedTaskInputs()
        expect(result?.pullRequestId).toBe('99')
    })

    it('defaults timeout to 15 when invalid value is provided', () => {
        mockTl.getBoolInput.mockReturnValue(false)
        mockTl.getInput.mockImplementation((key: string) => {
            const values: Record<string, string> = {
                azureDevOpsPat: 'pat',
                collectionUri: 'https://dev.azure.com/org',
                githubPat: 'ghp',
                project: 'P',
                repository: 'R',
                pullRequestId: '1',
                timeout: 'not-a-number',
            }
            return values[key] ?? null
        })
        mockTl.getVariable.mockReturnValue(undefined)

        expect(getValidatedTaskInputs()?.timeoutMinutes).toBe(15)
    })
})
