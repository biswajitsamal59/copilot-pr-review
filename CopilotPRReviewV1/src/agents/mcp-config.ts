import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Writes a Copilot CLI mcp-config.json that registers the Atlassian Remote MCP
 * server (https://mcp.atlassian.com/v1/mcp) using a service-account API key.
 *
 * Tool surface is restricted to the two read tools the review needs, to keep
 * the agent's tool-schema overhead small.
 */
export function writeMcpConfig(apiKey: string, copilotHome: string): void {
    fs.mkdirSync(copilotHome, { recursive: true });
    const config = {
        mcpServers: {
            atlassian: {
                type: 'http',
                url: 'https://mcp.atlassian.com/v1/mcp',
                headers: { Authorization: `Bearer ${apiKey}` },
                tools: ['getJiraIssue', 'getAccessibleAtlassianResources'],
            },
        },
    };
    fs.writeFileSync(path.join(copilotHome, 'mcp-config.json'), JSON.stringify(config, null, 2), 'utf8');
}
