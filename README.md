# Copilot PR Review

Automated pull request code reviews powered by the GitHub Copilot CLI, running directly inside your Azure DevOps pipelines. The task fetches your PR's diff and metadata, hands it to a Copilot agent, and posts inline review comments back to the PR — every time the build runs.

## What it does

When the task runs in a PR validation pipeline it:

1. Installs the GitHub Copilot CLI on the agent (Windows: `winget`, Linux: official install script).
2. Pulls PR metadata, iteration diffs, and existing comment threads from the Azure DevOps REST API.
3. Runs an autonomous Copilot agent over the changes with a built-in code-review prompt (correctness, security, performance, safety, simplification).
4. Posts inline comments on the PR for any issues the agent finds.
5. Resolves any prior Copilot comments where the issue was fixed in the new iteration.

The default prompt is conservative — it skips style-only nits, ignores pre-existing issues in unchanged code, and only posts when there is actionable feedback.

## Quick start

Add the task to a pipeline that runs on a PR validation trigger. The task auto-detects the PR ID, project, repo, and collection URI from the build context.

```yaml
trigger: none
pr:
  branches:
    include:
      - main

pool:
  vmImage: windows-latest

steps:
  - checkout: self
    fetchDepth: 0          # required so the agent has full git history for the diff

  - task: CopilotPRReviewV2@1
    inputs:
      githubPat: $(GITHUB_PAT)
      useSystemAccessToken: true
```

The Build Service identity needs **Contribute to pull requests** permission on the repository for `useSystemAccessToken: true` to be able to post comments.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `githubPat` | yes | — | GitHub PAT with Copilot access. Used by the Copilot CLI to authenticate. |
| `azureDevOpsPat` | conditional | — | Azure DevOps PAT. Required for Azure DevOps Server (on-prem). For Services (cloud) you can use `useSystemAccessToken` instead. |
| `useSystemAccessToken` | no | `false` | Use the pipeline's OAuth token (`System.AccessToken`) instead of a PAT. Cloud only. Build Service must have **Contribute to pull requests**. |
| `organization` | no | auto | ADO organization name (e.g. `myorg` from `https://dev.azure.com/myorg`). Auto-detected from build context if omitted. |
| `collectionUri` | no | auto | Full collection URI. Use this for Azure DevOps Server. Auto-detected from `System.CollectionUri` if omitted. |
| `project` | no | `$(System.TeamProject)` | ADO project name. |
| `repository` | no | `$(Build.Repository.Name)` | Repository name. |
| `pullRequestId` | no | `$(System.PullRequest.PullRequestId)` | Pull request ID. Auto-set in PR validation builds. |
| `timeout` | no | `15` | Maximum minutes the Copilot review may run. |
| `model` | no | Copilot default | Optional model override (e.g. `gpt-4`, `claude-sonnet`). |
| `prompt` | no | — | Custom prompt text to inject into the default review template (replaces `%CUSTOMPROMPT%`). |
| `promptFile` | no | — | Path to a `.txt` file with custom prompt text. |
| `promptRaw` | no | — | Raw prompt passed verbatim to the Copilot CLI, bypassing the template. |
| `promptFileRaw` | no | — | Path to a file containing a raw prompt (verbatim). |
| `authors` | no | — | Comma-separated list of author emails. Task only runs when the PR author matches. |

Only one of `prompt`, `promptFile`, `promptRaw`, `promptFileRaw` may be set per run.

## Authentication

**GitHub Copilot CLI** needs a GitHub PAT with Copilot access. Create one at https://github.com/settings/tokens and store it as a secret pipeline variable, then pass it via the `githubPat` input.

**Azure DevOps API** (for fetching PR data and posting comments) supports two modes:

- **System access token (recommended for cloud):** set `useSystemAccessToken: true`. Grant the build identity `Contribute to pull requests` on the repository.
- **Personal access token (required for Server / on-prem):** create a PAT with `Code (Read & Write)` and `Pull Request Threads (Read & Write)`, store as a secret, pass via `azureDevOpsPat`.

## Examples

### Custom prompt (inline)

```yaml
- task: CopilotPRReviewV2@1
  inputs:
    githubPat: $(GITHUB_PAT)
    useSystemAccessToken: true
    prompt: |
      Pay extra attention to SQL injection risks and missing input validation
      in any controller or repository changes.
```

### Restrict to specific PR authors

```yaml
- task: CopilotPRReviewV2@1
  inputs:
    githubPat: $(GITHUB_PAT)
    useSystemAccessToken: true
    authors: alice@contoso.com,bob@contoso.com
```

### Azure DevOps Server (on-prem)

```yaml
- task: CopilotPRReviewV2@1
  inputs:
    githubPat: $(GITHUB_PAT)
    azureDevOpsPat: $(ADO_PAT)
    collectionUri: https://tfs.contoso.com/tfs/DefaultCollection
    timeout: 20
```

## Requirements

- Azure DevOps agent running Node.js 20 or 24.
- A GitHub account with Copilot access for the PAT.
- `fetchDepth: 0` in the checkout step so the agent has full history to compute diffs.
- `windows-latest` agents work out of the box (`winget` is preinstalled). On Linux agents the task installs the Copilot CLI via the official install script (curl required).

## How it works

The task writes two context files to the working directory before invoking the Copilot CLI:

- `PR_Details.txt` — PR metadata, reviewers, description, and existing comment threads (including a JSON block of prior Copilot comments so the agent can resolve them when fixed).
- `Iteration_Details.txt` — commits in the PR, list of changed files, and the unified `git diff` covering the entire PR (merge-base to the source branch tip), not just the latest push. This way every changed file is reviewed on every run.

The Copilot CLI is launched with `--allow-all-paths --allow-all-tools --deny-tool 'shell(git push)' --no-color`, so the agent can read the repo and call helper scripts (`add-comment.js`, `update-comment.js`, `delete-comment.js`) but cannot push code.

## Source

Repository: https://github.com/biswajitsamal59/copilot-pr-review

Issues and feedback: https://github.com/biswajitsamal59/copilot-pr-review/issues
