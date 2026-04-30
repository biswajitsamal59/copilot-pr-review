import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseArgs, loadAdoEnv } from '../utils/args'

describe('parseArgs', () => {
    it('parses --key value pairs', () => {
        expect(parseArgs(['--foo', 'bar', '--baz', 'qux'])).toEqual({ foo: 'bar', baz: 'qux' })
    })

    it('converts kebab-case keys to camelCase', () => {
        expect(parseArgs(['--file-path', '/some/path', '--thread-id', '5'])).toEqual({
            filePath: '/some/path',
            threadId: '5',
        })
    })

    it('ignores a trailing flag with no following value', () => {
        expect(parseArgs(['--foo', 'bar', '--alone'])).toEqual({ foo: 'bar' })
    })

    it('returns empty object for empty array', () => {
        expect(parseArgs([])).toEqual({})
    })

    it('handles non-flag arguments by skipping them', () => {
        expect(parseArgs(['positional', '--key', 'val'])).toEqual({ key: 'val' })
    })
})

describe('loadAdoEnv', () => {
    const ENV_VARS = ['AZUREDEVOPS_TOKEN', 'AZUREDEVOPS_COLLECTION_URI', 'PROJECT', 'REPOSITORY', 'PRID', 'AZUREDEVOPS_AUTH_TYPE']
    const savedEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
        ENV_VARS.forEach(k => { savedEnv[k] = process.env[k] })
        ENV_VARS.forEach(k => { delete process.env[k] })
    })

    afterEach(() => {
        ENV_VARS.forEach(k => {
            if (savedEnv[k] === undefined) delete process.env[k]
            else process.env[k] = savedEnv[k]
        })
    })

    it('returns null when all env vars are missing', () => {
        expect(loadAdoEnv('test-script')).toBeNull()
    })

    it('returns null when only some env vars are set', () => {
        process.env['AZUREDEVOPS_TOKEN'] = 'tok'
        expect(loadAdoEnv('test-script')).toBeNull()
    })

    it('returns env object when all required vars are present', () => {
        process.env['AZUREDEVOPS_TOKEN'] = 'token123'
        process.env['AZUREDEVOPS_COLLECTION_URI'] = 'https://dev.azure.com/org'
        process.env['PROJECT'] = 'MyProject'
        process.env['REPOSITORY'] = 'MyRepo'
        process.env['PRID'] = '42'
        process.env['AZUREDEVOPS_AUTH_TYPE'] = 'Bearer'

        expect(loadAdoEnv('test-script')).toEqual({
            token: 'token123',
            authType: 'Bearer',
            collectionUri: 'https://dev.azure.com/org',
            project: 'MyProject',
            repository: 'MyRepo',
            prId: '42',
        })
    })

    it('defaults authType to Basic when AZUREDEVOPS_AUTH_TYPE is not set', () => {
        process.env['AZUREDEVOPS_TOKEN'] = 'tok'
        process.env['AZUREDEVOPS_COLLECTION_URI'] = 'https://dev.azure.com/org'
        process.env['PROJECT'] = 'P'
        process.env['REPOSITORY'] = 'R'
        process.env['PRID'] = '1'

        const result = loadAdoEnv('test-script')
        expect(result?.authType).toBe('Basic')
    })
})
