const MAX = 10;
const GENERIC = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/**
 * Extracts JIRA issue numbers (e.g. "PROJ-123") referenced in a PR description.
 * If `projectKey` is set, only matches keys for that project; otherwise matches
 * any uppercase project-key-shaped prefix. Dedupes (preserving order) and caps.
 */
export function extractJiraNumbers(description: string, projectKey?: string): string[] {
    if (!description) return [];
    const pattern = projectKey
        ? new RegExp(`\\b${projectKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+\\b`, 'g')
        : GENERIC;
    return [...new Set(description.match(pattern) ?? [])].slice(0, MAX);
}
