import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as cp from 'node:child_process'
import {
    fetchIterationChanges,
    fetchIterationDiffs,
    formatIterationDetailsText,
    type ChangeEntry,
} from '../context/diff-fetcher'
import { AdoClient } from '../ado-api/client'

vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(),
    spawn: vi.fn(),
}))

const sampleDiffOutput = [
    'diff --git a/src/index.ts b/src/index.ts',
    'index abc..def 100644',
    '--- a/src/index.ts',
    '+++ b/src/index.ts',
    '@@ -1,3 +1,4 @@',
    ' const x = 1',
    '+const y = 2',
    '',
    'diff --git a/src/utils/helper.ts b/src/utils/helper.ts',
    '--- /dev/null',
    '+++ b/src/utils/helper.ts',
    '@@ -0,0 +1,1 @@',
    '+export function helper() {}',
].join('\n')

describe('fetchIterationChanges', () => {
    let client: AdoClient

    beforeEach(() => {
        client = new AdoClient({ collectionUri: 'https://dev.azure.com/org', project: 'P', token: 'tok', authType: 'Bearer' })
        vi.resetAllMocks()
    })

    it('returns non-folder change entries', async () => {
        const changeEntries: ChangeEntry[] = [
            { changeType: 'edit', item: { path: '/src/index.ts' } },
            { changeType: 'add', item: { path: '/src/new.ts' } },
            { changeType: 'edit', item: { path: '/src/', isFolder: true } },
        ]
        vi.spyOn(client, 'get').mockResolvedValue({ changeEntries })

        const result = await fetchIterationChanges(client, 'MyRepo', 42, 1)

        expect(result).toHaveLength(2)
        expect(result.every(e => !e.item.isFolder)).toBe(true)
    })

    it('returns empty array when changeEntries is missing from response', async () => {
        vi.spyOn(client, 'get').mockResolvedValue({})
        expect(await fetchIterationChanges(client, 'MyRepo', 42, 1)).toEqual([])
    })
})

describe('fetchIterationDiffs', () => {
    beforeEach(() => {
        vi.resetAllMocks()
    })

    it('returns diffs matched to change entries', () => {
        // Both commits found locally: commitExists(target) → ok, commitExists(source) → ok
        vi.mocked(cp.execFileSync)
            .mockReturnValueOnce('commit' as any)   // commitExists(target)
            .mockReturnValueOnce('commit' as any)   // commitExists(source)
            .mockReturnValueOnce(sampleDiffOutput as any)  // git diff

        const entries: ChangeEntry[] = [
            { changeType: 'edit', item: { path: '/src/index.ts' } },
            { changeType: 'add', item: { path: '/src/utils/helper.ts' } },
        ]

        const diffs = fetchIterationDiffs(entries, 'src123', 'tgt456', '/repo')

        expect(diffs).toHaveLength(2)
        expect(diffs[0].path).toBe('/src/index.ts')
        expect(diffs[0].diffContent).toContain('diff --git')
    })

    it('shows fallback message when no diff content matches a file', () => {
        vi.mocked(cp.execFileSync)
            .mockReturnValueOnce('commit' as any)  // commitExists(target)
            .mockReturnValueOnce('commit' as any)  // commitExists(source)
            .mockReturnValueOnce('' as any)        // empty git diff

        const entries: ChangeEntry[] = [
            { changeType: 'delete', item: { path: '/src/missing.ts' } },
        ]

        const diffs = fetchIterationDiffs(entries, 'src123', 'tgt456', '/repo')
        expect(diffs[0].diffContent).toBe('(No diff content available)')
    })

    it('runs git fetch --unshallow when commits are missing locally', () => {
        // Sequence: target missing → fetch --unshallow → target+source found → diff
        vi.mocked(cp.execFileSync)
            .mockImplementationOnce(() => { throw new Error('bad object') })  // commitExists(target) fails
            .mockReturnValueOnce('' as any)               // git fetch --unshallow
            .mockReturnValueOnce('commit' as any)         // commitExists(target) after fetch
            .mockReturnValueOnce('commit' as any)         // commitExists(source) after fetch
            .mockReturnValueOnce('' as any)               // git diff

        fetchIterationDiffs([], 'src123', 'tgt456', '/repo')

        const calls = vi.mocked(cp.execFileSync).mock.calls
        const fetchCall = calls.find(c => (c[1] as string[]).includes('--unshallow'))
        expect(fetchCall).toBeDefined()
    })

    it('falls back to git fetch origin when --unshallow fails', () => {
        vi.mocked(cp.execFileSync)
            .mockImplementationOnce(() => { throw new Error('bad object') })  // commitExists(target) fails
            .mockImplementationOnce(() => { throw new Error('already full') }) // fetch --unshallow fails
            .mockReturnValueOnce('' as any)               // git fetch origin (fallback)
            .mockReturnValueOnce('commit' as any)         // commitExists(target) after fetch
            .mockReturnValueOnce('commit' as any)         // commitExists(source) after fetch
            .mockReturnValueOnce('' as any)               // git diff

        fetchIterationDiffs([], 'src123', 'tgt456', '/repo')

        const calls = vi.mocked(cp.execFileSync).mock.calls
        const originCall = calls.find(c => (c[1] as string[]).includes('origin'))
        expect(originCall).toBeDefined()
    })

    it('throws when commits remain unavailable after fetch', () => {
        // Sequence: target missing → fetch --unshallow → target still missing → throws
        vi.mocked(cp.execFileSync)
            .mockImplementationOnce(() => { throw new Error('bad object') })  // commitExists(target) fails
            .mockReturnValueOnce('' as any)               // fetch --unshallow
            .mockImplementationOnce(() => { throw new Error('bad object') })  // commitExists(target) still fails

        expect(() => fetchIterationDiffs([], 'src123', 'tgt456', '/repo')).toThrow(
            'Required commits are not available'
        )
    })
})

describe('formatIterationDetailsText', () => {
    const iteration = {
        createdDate: '2024-01-15T10:00:00Z',
        updatedDate: '2024-01-15T11:00:00Z',
        sourceRefCommit: { commitId: 'abc123def456' },
        targetRefCommit: { commitId: 'def456abc123' },
    }

    const commits = [
        { commitId: 'abc123def456', comment: 'feat: new feature', author: { name: 'John', date: '2024-01-15T09:00:00Z' } },
    ]

    const entries: ChangeEntry[] = [
        { changeType: 'edit', item: { path: '/src/index.ts' } },
        { changeType: 'add', item: { path: '/src/new.ts' } },
        { changeType: 'delete', item: { path: '/src/old.ts' } },
    ]

    const diffs = [
        { path: '/src/index.ts', changeType: 'edit', diffContent: 'diff --git a/src/index.ts b/src/index.ts' },
        { path: '/src/new.ts', changeType: 'add', diffContent: '' },
        { path: '/src/old.ts', changeType: 'delete', diffContent: '' },
    ]

    it('includes iteration ID and commit info', () => {
        const text = formatIterationDetailsText(1, iteration, commits, entries, diffs, 'https://dev.azure.com/org', 'P', 'MyRepo', 42)
        expect(text).toContain('ITERATION #1')
        expect(text).toContain('abc123de')
        expect(text).toContain('feat: new feature')
    })

    it('shows correct file change counts', () => {
        const text = formatIterationDetailsText(1, iteration, commits, entries, diffs, 'https://dev.azure.com/org', 'P', 'MyRepo', 42)
        expect(text).toContain('+1 added')
        expect(text).toContain('~1 modified')
        expect(text).toContain('-1 deleted')
    })

    it('shows no commits message when commits array is empty', () => {
        const text = formatIterationDetailsText(1, iteration, [], entries, diffs, 'https://dev.azure.com/org', 'P', 'MyRepo', 42)
        expect(text).toContain('No commits found')
    })

    it('shows no changes message when change entries are empty', () => {
        const text = formatIterationDetailsText(1, iteration, commits, [], [], 'https://dev.azure.com/org', 'P', 'MyRepo', 42)
        expect(text).toContain('No file changes found')
    })

    it('includes PR view link', () => {
        const text = formatIterationDetailsText(1, iteration, commits, entries, diffs, 'https://dev.azure.com/org', 'P', 'MyRepo', 42)
        expect(text).toContain('pullrequest/42')
    })

    it('truncates long commit messages', () => {
        const longCommit = [{
            commitId: 'abc123',
            comment: 'feat: ' + 'x'.repeat(100),
            author: { name: 'John', date: '' },
        }]
        const text = formatIterationDetailsText(1, iteration, longCommit, [], [], 'https://dev.azure.com/org', 'P', 'MyRepo', 42)
        expect(text).toContain('...')
    })

    it('includes rename source path for renamed files', () => {
        const renameEntry: ChangeEntry[] = [
            { changeType: 'rename', item: { path: '/src/new-name.ts' }, originalPath: '/src/old-name.ts' },
        ]
        const renameDiffs = [{ path: '/src/new-name.ts', changeType: 'rename', originalPath: '/src/old-name.ts', diffContent: '' }]
        const text = formatIterationDetailsText(1, iteration, commits, renameEntry, renameDiffs, 'https://dev.azure.com/org', 'P', 'MyRepo', 42)
        expect(text).toContain('old-name.ts')
    })
})
