import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted ensures these fn references are available inside vi.mock() factories,
// which are hoisted to the top of the file before any imports resolve.
const mocks = vi.hoisted(() => ({
    parseArgs: vi.fn(),
    loadAdoEnv: vi.fn(),
    createComment: vi.fn(),
}))

vi.mock('../utils/args', () => ({
    parseArgs: mocks.parseArgs,
    loadAdoEnv: mocks.loadAdoEnv,
}))

vi.mock('../ado-api/comments', () => ({
    createComment: mocks.createComment,
}))

vi.mock('../ado-api/client', () => ({
    AdoClient: vi.fn().mockImplementation(() => ({})),
}))

// Re-evaluates the script module so main() runs fresh with current mock state.
// vi.resetModules() clears the module instance cache while preserving mock
// registrations, which is the pattern Vitest docs recommend for CLI side-effects.
async function runScript() {
    vi.resetModules()
    await import('../scripts/add-comment')
    // Flush the microtask queue so the async main() chain completes before assertions.
    await new Promise(resolve => setTimeout(resolve, 0))
}

const validEnv = {
    token: 'tok',
    authType: 'Bearer' as const,
    collectionUri: 'https://dev.azure.com/org',
    project: 'MyProject',
    repository: 'MyRepo',
    prId: '42',
}

describe('add-comment script', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
    })

    it('prints error and exits 1 when --comment is missing', async () => {
        mocks.parseArgs.mockReturnValue({})

        await runScript()

        expect(process.exit).toHaveBeenCalledWith(1)
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--comment is required'))
    })

    it('exits 1 when env vars are missing', async () => {
        mocks.parseArgs.mockReturnValue({ comment: 'test comment' })
        mocks.loadAdoEnv.mockReturnValue(null)

        await runScript()

        expect(process.exit).toHaveBeenCalledWith(1)
    })

    it('calls createComment with correct args on happy path', async () => {
        mocks.parseArgs.mockReturnValue({ comment: 'Great change', status: 'Active' })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.createComment.mockResolvedValue({ threadId: 10, commentId: 1 })

        await runScript()

        expect(mocks.createComment).toHaveBeenCalledWith(
            expect.anything(),
            'MyRepo',
            42,
            expect.objectContaining({ comment: 'Great change', status: 'Active' })
        )
        expect(process.exit).not.toHaveBeenCalled()
    })

    it('passes parsed startLine and endLine as integers', async () => {
        mocks.parseArgs.mockReturnValue({
            comment: 'Inline note',
            filePath: '/src/foo.ts',
            startLine: '5',
            endLine: '8',
        })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.createComment.mockResolvedValue({ threadId: 11, commentId: 2 })

        await runScript()

        expect(mocks.createComment).toHaveBeenCalledWith(
            expect.anything(),
            'MyRepo',
            42,
            expect.objectContaining({ filePath: '/src/foo.ts', startLine: 5, endLine: 8 })
        )
    })

    it('reads iterationId from ITERATION_ID env var', async () => {
        process.env['ITERATION_ID'] = '3'
        mocks.parseArgs.mockReturnValue({ comment: 'note' })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.createComment.mockResolvedValue({ threadId: 12, commentId: 3 })

        await runScript()

        expect(mocks.createComment).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(String),
            expect.any(Number),
            expect.objectContaining({ iterationId: 3 })
        )
        delete process.env['ITERATION_ID']
    })

    it('exits 1 and prints error when createComment throws', async () => {
        mocks.parseArgs.mockReturnValue({ comment: 'note' })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.createComment.mockRejectedValue(new Error('API unavailable'))

        await runScript()

        expect(process.exit).toHaveBeenCalledWith(1)
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('API unavailable'))
    })

    it('defaults status to Active when not provided', async () => {
        mocks.parseArgs.mockReturnValue({ comment: 'note' })
        mocks.loadAdoEnv.mockReturnValue(validEnv)
        mocks.createComment.mockResolvedValue({ threadId: 13, commentId: 4 })

        await runScript()

        expect(mocks.createComment).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(String),
            expect.any(Number),
            expect.objectContaining({ status: 'Active' })
        )
    })
})
