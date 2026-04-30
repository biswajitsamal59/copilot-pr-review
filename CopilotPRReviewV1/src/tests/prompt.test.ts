import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const mockTl = vi.hoisted(() => ({
    setResult: vi.fn<[number, string], void>(),
    TaskResult: { Succeeded: 0, Failed: 1 } as const,
}))

vi.mock('azure-pipelines-task-lib/task', () => mockTl)

vi.mock('node:fs', () => ({
    default: {
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        existsSync: vi.fn(),
        statSync: vi.fn(),
    },
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
}))

const { resolvePrompt } = await import('../utils/prompt')

const TEMPLATE = 'Review the following:\n%CUSTOMPROMPT%\nEnd.'
const WORK_DIR = '/tmp/work'
const TEMPLATE_PATH = '/template/prompt.txt'

describe('resolvePrompt', () => {
    beforeEach(() => {
        vi.resetAllMocks()
    })

    it('writes template with placeholder stripped when no custom prompt is given', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false)
        vi.mocked(fs.statSync).mockReturnValue({ isFile: () => false } as any)
        vi.mocked(fs.readFileSync).mockReturnValue(TEMPLATE as any)

        resolvePrompt({
            promptInput: undefined,
            promptFileInput: undefined,
            promptRawInput: undefined,
            promptFileRawInput: undefined,
            promptTemplatePath: TEMPLATE_PATH,
            workingDir: WORK_DIR,
        })

        expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
            path.join(WORK_DIR, '_copilot_prompt.txt'),
            'Review the following:\n\nEnd.',
            'utf8'
        )
    })

    it('injects custom inline prompt into template', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false)
        vi.mocked(fs.readFileSync).mockReturnValue(TEMPLATE as any)

        resolvePrompt({
            promptInput: 'Focus on security',
            promptFileInput: undefined,
            promptRawInput: undefined,
            promptFileRawInput: undefined,
            promptTemplatePath: TEMPLATE_PATH,
            workingDir: WORK_DIR,
        })

        expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
            expect.any(String),
            'Review the following:\nFocus on security\nEnd.',
            'utf8'
        )
    })

    it('uses raw inline prompt verbatim, bypassing template', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false)

        resolvePrompt({
            promptInput: undefined,
            promptFileInput: undefined,
            promptRawInput: 'My raw prompt content',
            promptFileRawInput: undefined,
            promptTemplatePath: TEMPLATE_PATH,
            workingDir: WORK_DIR,
        })

        expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
            expect.any(String),
            'My raw prompt content',
            'utf8'
        )
    })

    it('reads prompt from file and injects into template', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any)
        vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
            if (p === TEMPLATE_PATH) return TEMPLATE as any
            return 'File prompt content' as any
        })

        resolvePrompt({
            promptInput: undefined,
            promptFileInput: '/path/to/prompt.txt',
            promptRawInput: undefined,
            promptFileRawInput: undefined,
            promptTemplatePath: TEMPLATE_PATH,
            workingDir: WORK_DIR,
        })

        expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
            expect.any(String),
            'Review the following:\nFile prompt content\nEnd.',
            'utf8'
        )
    })

    it('uses raw file content verbatim', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any)
        vi.mocked(fs.readFileSync).mockReturnValue('raw file content' as any)

        resolvePrompt({
            promptInput: undefined,
            promptFileInput: undefined,
            promptRawInput: undefined,
            promptFileRawInput: '/path/to/raw.txt',
            promptTemplatePath: TEMPLATE_PATH,
            workingDir: WORK_DIR,
        })

        expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
            expect.any(String),
            'raw file content',
            'utf8'
        )
    })

    it('calls setResult and process.exit when multiple prompt inputs are set', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false)
        const exitStub = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

        resolvePrompt({
            promptInput: 'inline',
            promptFileInput: undefined,
            promptRawInput: 'raw',
            promptFileRawInput: undefined,
            promptTemplatePath: TEMPLATE_PATH,
            workingDir: WORK_DIR,
        })

        expect(mockTl.setResult).toHaveBeenCalledWith(mockTl.TaskResult.Failed, expect.any(String))
        expect(exitStub).toHaveBeenCalledWith(1)
    })

    it('fails when inline prompt contains double quotes', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false)
        vi.mocked(fs.readFileSync).mockReturnValue(TEMPLATE as any)
        const exitStub = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

        resolvePrompt({
            promptInput: 'prompt with "quotes"',
            promptFileInput: undefined,
            promptRawInput: undefined,
            promptFileRawInput: undefined,
            promptTemplatePath: TEMPLATE_PATH,
            workingDir: WORK_DIR,
        })

        expect(mockTl.setResult).toHaveBeenCalledWith(mockTl.TaskResult.Failed, expect.any(String))
        expect(exitStub).toHaveBeenCalledWith(1)
    })

    it('fails when prompt file is empty', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any)
        vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
            if (p === TEMPLATE_PATH) return TEMPLATE as any
            return '   ' as any
        })
        const exitStub = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

        resolvePrompt({
            promptInput: undefined,
            promptFileInput: '/empty.txt',
            promptRawInput: undefined,
            promptFileRawInput: undefined,
            promptTemplatePath: TEMPLATE_PATH,
            workingDir: WORK_DIR,
        })

        expect(mockTl.setResult).toHaveBeenCalledWith(mockTl.TaskResult.Failed, expect.any(String))
        expect(exitStub).toHaveBeenCalledWith(1)
    })

    it('fails when raw prompt file is empty', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true)
        vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as any)
        vi.mocked(fs.readFileSync).mockReturnValue('  \n  ' as any)
        const exitStub = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

        resolvePrompt({
            promptInput: undefined,
            promptFileInput: undefined,
            promptRawInput: undefined,
            promptFileRawInput: '/empty-raw.txt',
            promptTemplatePath: TEMPLATE_PATH,
            workingDir: WORK_DIR,
        })

        expect(mockTl.setResult).toHaveBeenCalledWith(mockTl.TaskResult.Failed, expect.any(String))
        expect(exitStub).toHaveBeenCalledWith(1)
    })

    it('returns the output file path', () => {
        vi.mocked(fs.existsSync).mockReturnValue(false)
        vi.mocked(fs.readFileSync).mockReturnValue(TEMPLATE as any)

        const result = resolvePrompt({
            promptInput: undefined,
            promptFileInput: undefined,
            promptRawInput: undefined,
            promptFileRawInput: undefined,
            promptTemplatePath: TEMPLATE_PATH,
            workingDir: WORK_DIR,
        })

        expect(result).toBe(path.join(WORK_DIR, '_copilot_prompt.txt'))
    })
})
