# Contributing to DevPilot

Thank you for your interest in contributing to DevPilot! This document provides guidelines and information for contributors.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/DevPilot.git`
3. Create a branch: `git checkout -b feature/your-feature-name`
4. Make your changes
5. Test your changes
6. Commit: `git commit -m "Add your feature"`
7. Push: `git push origin feature/your-feature-name`
8. Open a Pull Request

## Development Setup

### Prerequisites

- Node.js 18+
- .NET 9 SDK
- PostgreSQL 14+
- Docker (for sandbox development)

### Backend Setup

```bash
cd src/API
cp appsettings.Development.json.template appsettings.Development.json
# Edit appsettings.Development.json with your settings
dotnet ef database update
dotnet watch run
```

### Frontend Setup

```bash
cd frontend
npm install
npm start
```

## Code Style

### Backend (.NET)

- Follow Microsoft C# coding conventions
- Use async/await for I/O operations
- Follow Clean Architecture patterns
- Add XML documentation for public APIs

### Frontend (Angular)

- Use standalone components
- Prefer signals over BehaviorSubject
- Follow Angular style guide
- Use TypeScript strict mode

## Commit Messages

Use clear, descriptive commit messages:

- `feat: Add backlog export feature`
- `fix: Resolve Azure DevOps sync issue`
- `docs: Update README with setup instructions`
- `refactor: Simplify auth service`
- `test: Add unit tests for repository service`

## Pull Requests

1. Ensure your code builds without errors
2. Update documentation if needed
3. Add tests for new features
4. Keep PRs focused on a single feature/fix
5. Link related issues in the PR description

## Reporting Issues

When reporting bugs, include:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, browser, etc.)
- Screenshots if applicable

## Questions?

Feel free to open an issue for questions or discussions.
