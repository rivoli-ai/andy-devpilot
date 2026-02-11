# Browsing a GitHub repo without cloning

When your network blocks `git clone` (e.g. enterprise firewall) but you can still open the repo in the browser, you can **explore the code without cloning** by using the GitHub API instead of Git.

## How it works

- **List directory:** `GET /repos/{owner}/{repo}/contents/{path}` (empty `path` = repo root).
- **Get file content:** Same endpoint with a file path; response includes `content` (base64) and `encoding`.

So you can build a "Browse repo" flow: a file tree + a viewer that fetches file contents via this API. Optionally use `?ref=branch` to choose a branch.

## In this codebase

The backend already has the building blocks:

- **`IGitHubService.GetRepositoryTreeAsync`** – lists directory contents (files and folders).
- **File content** – the Contents API returns file content (base64-decoded in Octokit).

A future "Browse repo" feature could:

1. Let the user enter a repo URL (or pick an already-added repo).
2. Call the backend (or GitHub API) to list the root directory.
3. Show a tree; when the user opens a folder, fetch that path; when they open a file, fetch and display its content (with optional syntax highlighting).

## Caveat

If the enterprise network blocks **both** `git clone` and `api.github.com`, this approach would only work if the app (or a backend proxy) can reach the GitHub API over a different path (e.g. backend on a network that is not restricted).
