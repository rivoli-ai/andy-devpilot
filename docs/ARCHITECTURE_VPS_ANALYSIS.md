# VPS-Based Repository Analysis Architecture

## Overview

This document describes the architecture for performing repository analysis using VPS (Virtual Private Server) infrastructure with isolated Zed IDE containers.

## Flow Diagram

```
┌─────────────┐
│   Angular   │
│    UI       │
└──────┬──────┘
       │ Click "Analyze"
       ▼
┌─────────────────────────────────────┐
│   API Controller                    │
│   RepositoriesController            │
│   POST /repositories/{id}/analyze   │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│   MediatR Command                   │
│   AnalyzeRepositoryCommand          │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│   Command Handler                   │
│   AnalyzeRepositoryCommandHandler   │
│                                     │
│   ┌──────────────────────────────┐  │
│   │  Check: VPS enabled?         │  │
│   └──────┬───────────────────────┘  │
│          │                           │
│    ┌─────┴─────┐                    │
│    │           │                    │
│   YES         NO                    │
│    │           │                    │
│    ▼           ▼                    │
│ ┌─────────┐ ┌──────────────┐       │
│ │  VPS    │ │  Direct AI   │       │
│ │ Service │ │  Analysis    │       │
│ └────┬────┘ └──────────────┘       │
└──────┼──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│   VPSAnalysisService                │
│   (Orchestrator)                    │
└──────┬──────────────────────────────┘
       │
       ├──────────────────────────┐
       │                          │
       ▼                          ▼
┌──────────────┐        ┌──────────────┐
│ ZedSession   │        │  ACP Client  │
│ Service      │        │              │
└──────┬───────┘        └──────┬───────┘
       │                       │
       │                       │
       │ Create Session        │ Connect WebSocket
       │                       │
       ▼                       ▼
┌─────────────────────────────────────┐
│   VPS Gateway (HTTP API)            │
│   - Creates Docker container        │
│   - Returns session info            │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│   Zed Container                     │
│   - Ubuntu base                     │
│   - Zed IDE                         │
│   - Git                             │
│   - AI tools                        │
└──────┬──────────────────────────────┘
       │
       │ ACP Commands via WebSocket
       │
       ├─ INIT_SESSION
       ├─ CLONE_REPOSITORY (git clone)
       ├─ RUN_COMMAND (analyze files)
       ├─ ANALYZE_REPOSITORY (generate backlog)
       └─ CLOSE_SESSION
       │
       ▼
┌─────────────────────────────────────┐
│   Analysis Results                  │
│   - RepositoryAnalysisResult        │
│   - Epics, Features, User Stories   │
└──────┬──────────────────────────────┘
       │
       │ Return to API
       │
       ▼
┌─────────────────────────────────────┐
│   Save to Database                  │
│   (if saveResults=true)             │
└─────────────────────────────────────┘
```

## Component Details

### 1. AnalyzeRepositoryCommandHandler

**Location:** `src/Application/UseCases/AnalyzeRepositoryCommandHandler.cs`

**Responsibilities:**
- Receives analysis command
- Fetches repository from database
- Decides between VPS and direct AI analysis
- Returns analysis results

**Key Logic:**
```csharp
if (_vpsAnalysisService != null)
{
    // Use VPS/Zed infrastructure
    analysisResult = await _vpsAnalysisService.AnalyzeRepositoryViaVPSAsync(...);
}
else
{
    // Fallback to direct AI analysis
    analysisResult = await _analysisService.AnalyzeRepositoryAsync(...);
}
```

### 2. VPSAnalysisService

**Location:** `src/Infrastructure/VPS/VPSAnalysisService.cs`

**Responsibilities:**
- Orchestrates the entire VPS analysis workflow
- Creates Zed session
- Manages ACP communication
- Handles cleanup

**Workflow:**
1. Create Zed session via `IZedSessionService`
2. Connect ACP client to session
3. Initialize session in container
4. Clone repository
5. Run analysis commands
6. Get results
7. Clean up (close session, destroy container)

### 3. ZedSessionService

**Location:** `src/Infrastructure/Zed/ZedSessionService.cs`

**Responsibilities:**
- Communicates with VPS Gateway via HTTP
- Creates/destroys Zed containers
- Manages session lifecycle

**VPS Gateway API:**
- `POST /api/sessions` - Create session
- `DELETE /api/sessions/{sessionId}` - Destroy session
- `GET /api/sessions/{sessionId}/status` - Get status

### 4. ACPClient

**Location:** `src/Infrastructure/ACP/ACPClient.cs`

**Responsibilities:**
- WebSocket communication with Zed containers
- ACP protocol implementation
- Command/response handling

**ACP Protocol:**
- JSON-over-WebSocket
- Messages: `{ sessionId, command, payload, correlationId }`
- Commands: `INIT_SESSION`, `CLONE_REPOSITORY`, `RUN_COMMAND`, `ANALYZE_REPOSITORY`, `CLOSE_SESSION`

## Configuration

### appsettings.json

```json
{
  "VPS": {
    "GatewayUrl": "http://localhost:8081",
    "SessionTimeoutMinutes": 60,
    "Enabled": false  // Set to true to enable VPS analysis
  }
}
```

When `VPS:Enabled` is `false`, the system falls back to direct AI analysis (current behavior).

When `VPS:Enabled` is `true`, the system uses VPS/Zed containers for analysis.

## VPS Gateway Service (To Be Implemented)

The VPS Gateway service runs on the VPS server and:

1. **Manages Docker containers:**
   - Creates `zed-session-{sessionId}` containers on demand
   - Provides isolated workspaces per session
   - Cleans up containers after timeout/completion

2. **Exposes HTTP API:**
   - Session creation/deletion endpoints
   - Health check endpoints
   - Status monitoring

3. **Handles WebSocket connections:**
   - Accepts ACP protocol connections
   - Routes commands to appropriate containers
   - Streams logs and responses back

4. **Security:**
   - Validates JWT tokens
   - Enforces session isolation
   - Manages resource limits

## Docker Container Setup

Each Zed container includes:

- **Base:** Ubuntu 22.04 LTS
- **IDE:** Zed editor
- **Tools:** Git, Node.js, .NET SDK (as needed)
- **AI Tools:** Analysis scripts, OpenAI client
- **Network:** Isolated, internet access only for git cloning

## ACP Protocol Commands

### INIT_SESSION
Initialize a new session in the container.

**Request:**
```json
{
  "sessionId": "uuid",
  "command": "INIT_SESSION",
  "payload": { "sessionId": "uuid" },
  "correlationId": "uuid"
}
```

### CLONE_REPOSITORY
Clone a Git repository into the container workspace.

**Request:**
```json
{
  "sessionId": "uuid",
  "command": "CLONE_REPOSITORY",
  "payload": {
    "cloneUrl": "https://github.com/user/repo.git",
    "branch": "main"
  },
  "correlationId": "uuid"
}
```

### RUN_COMMAND
Execute a shell command in the container.

**Request:**
```json
{
  "sessionId": "uuid",
  "command": "RUN_COMMAND",
  "payload": {
    "command": "ls -la",
    "workingDirectory": "/workspace"
  },
  "correlationId": "uuid"
}
```

### ANALYZE_REPOSITORY
High-level command to analyze repository and generate backlog.

**Request:**
```json
{
  "sessionId": "uuid",
  "command": "ANALYZE_REPOSITORY",
  "payload": {
    "repositoryName": "user/repo"
  },
  "correlationId": "uuid"
}
```

**Response:**
Returns `RepositoryAnalysisResult` as JSON.

### CLOSE_SESSION
Close session and trigger cleanup.

**Request:**
```json
{
  "sessionId": "uuid",
  "command": "CLOSE_SESSION",
  "payload": {},
  "correlationId": "uuid"
}
```

## Error Handling

- **Session creation failure:** Falls back to direct AI analysis
- **Container errors:** Logged and session cleaned up
- **Network errors:** Retry with exponential backoff
- **Timeout:** Sessions expire after configured timeout

## Benefits

1. **Isolation:** Each analysis runs in its own container
2. **Security:** Containers are isolated and cleaned up after use
3. **Scalability:** Can run multiple analyses in parallel
4. **Real code analysis:** Clones actual repositories instead of using metadata
5. **Flexibility:** Can run custom analysis scripts in containers

## Next Steps

1. **Implement VPS Gateway Service** - Docker container management API
2. **Create Zed Base Image** - Dockerfile for Zed containers
3. **Implement ACP Protocol in Gateway** - WebSocket handling
4. **Add Analysis Scripts** - Repository analysis logic for containers
5. **Add Monitoring** - Health checks, metrics, logging
6. **Testing** - Integration tests with mock VPS gateway
