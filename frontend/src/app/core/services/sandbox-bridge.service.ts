import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, catchError, of, map, interval, Subject, takeUntil, switchMap, filter, take, tap, scan, throwError } from 'rxjs';
import { VPS_CONFIG } from '../config/vps.config';
import { VncViewerService } from './vnc-viewer.service';

export interface ChatResponse {
  response: string;
  model: string;
}

export interface AnalysisResponse {
  analysis: string;
  model: string;
  project_path: string;
}

export interface HealthResponse {
  status: string;
  api_configured: boolean;
  model: string;
  project_path: string;
}

export interface ProjectFile {
  name: string;
  type: 'file' | 'directory';
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ZedConversation {
  id: string;
  timestamp: number;
  user_message: string;
  assistant_message: string;
  model: string;
  source?: string; // 'proxy' or 'acp_agent'
  had_tool_execution?: boolean; // true if response involved tool calls
}

export interface ZedConversationsResponse {
  conversations: ZedConversation[];
  count: number;
  /** From /all-conversations: true while bridge is handling a chat request (LLM streaming/processing) */
  request_in_progress?: boolean;
}

/**
 * Consecutive idle polls (same latest conversation id, no LLM round in flight) before treating
 * the agent as "settled" for Push PR and implementation-complete heuristics.
 */
export const SANDBOX_AGENT_QUIET_POLL_COUNT = 4;

@Injectable({
  providedIn: 'root'
})
export class SandboxBridgeService {
  private http = inject(HttpClient);
  private vncViewerService = inject(VncViewerService);

  /**
   * Get the bridge API URL for a sandbox.
   * Prefer the bridgeUrl stored on the matching VNC viewer (set at sandbox creation),
   * falling back to building the URL from VPS_CONFIG for backwards compatibility.
   */
  private getBridgeUrl(bridgePort: number): string {
    const viewer = this.vncViewerService.getViewerByBridgePort(bridgePort);
    if (viewer?.bridgeUrl) {
      return viewer.bridgeUrl;
    }
    return `http://${VPS_CONFIG.ip}:${bridgePort}`;
  }

  /**
   * Build Authorization headers for a specific bridge port.
   * Looks up the sandbox token from the matching VNC viewer.
   * Returns an empty HttpHeaders object when no token is available.
   */
  private getAuthHeaders(bridgePort: number): HttpHeaders {
    const viewer = this.vncViewerService.getViewerByBridgePort(bridgePort);
    const token = viewer?.sandboxToken;
    return token
      ? new HttpHeaders({ Authorization: `Bearer ${token}` })
      : new HttpHeaders();
  }

  /**
   * Check if the bridge API is healthy
   */
  health(bridgePort: number): Observable<HealthResponse> {
    return this.http.get<HealthResponse>(`${this.getBridgeUrl(bridgePort)}/health`, { headers: this.getAuthHeaders(bridgePort) }).pipe(
      catchError(error => {
        console.error('Bridge health check failed:', error);
        return of({ status: 'error', api_configured: false, model: '', project_path: '' });
      })
    );
  }

  /**
   * Send a chat message to the AI (direct API call, bypasses Zed)
   * Use this as fallback when xdotool-based prompting isn't working
   */
  chat(bridgePort: number, message: string): Observable<ChatResponse & { conversation_id?: string }> {
    return this.http.post<ChatResponse & { conversation_id?: string }>(`${this.getBridgeUrl(bridgePort)}/chat`, { message }, { headers: this.getAuthHeaders(bridgePort) });
  }

  /**
   * Get debug info from the Bridge API
   */
  getDebugInfo(bridgePort: number): Observable<{
    status: string;
    api_configured: boolean;
    model: string;
    zed_running: boolean;
    zed_window_id: string | null;
    conversations_count: number;
  }> {
    return this.http.get<any>(`${this.getBridgeUrl(bridgePort)}/debug`, { headers: this.getAuthHeaders(bridgePort) }).pipe(
      catchError(error => {
        console.error('Debug info failed:', error);
        return of({ status: 'error', api_configured: false, model: '', zed_running: false, zed_window_id: null, conversations_count: 0 });
      })
    );
  }

  /**
   * Analyze the project
   */
  analyze(bridgePort: number, focus?: string): Observable<AnalysisResponse> {
    return this.http.post<AnalysisResponse>(`${this.getBridgeUrl(bridgePort)}/analyze`, { focus }, { headers: this.getAuthHeaders(bridgePort) });
  }

  /**
   * Paste text from the host into the focused X11 app (e.g. Zed) via xclip + xdotool.
   * Use this when browser/VNC clipboard sync fails (common with Zed in noVNC).
   */
  pasteHostClipboardIntoSandbox(bridgePort: number, text: string): Observable<{ status: string; error?: string }> {
    return this.http.post<{ status: string; error?: string }>(
      `${this.getBridgeUrl(bridgePort)}/clipboard/paste`,
      { text },
      { headers: this.getAuthHeaders(bridgePort) }
    );
  }

  /**
   * Open Zed's agent panel
   */
  openZedAgent(bridgePort: number): Observable<{ status: string; window_id?: string }> {
    return this.http.post<{ status: string; window_id?: string }>(
      `${this.getBridgeUrl(bridgePort)}/zed/open-agent`,
      {},
      { headers: this.getAuthHeaders(bridgePort) }
    );
  }

  /**
   * Send a prompt to Zed's agent panel
   */
  sendZedPrompt(bridgePort: number, prompt: string): Observable<{ status: string; prompt_sent?: string }> {
    return this.http.post<{ status: string; prompt_sent?: string }>(
      `${this.getBridgeUrl(bridgePort)}/zed/send-prompt`,
      { prompt },
      { headers: this.getAuthHeaders(bridgePort) }
    );
  }

  /**
   * Wait for Zed to be ready, then send prompt
   * Polls /health every 3s until zed_running=true and zed_window_id exists
   * Times out after maxWaitMs (default 90s)
   */
  waitForZedAndSendPrompt(
    bridgePort: number, 
    prompt: string, 
    maxWaitMs: number = 90000
  ): Observable<{ status: string; prompt_sent?: string }> {
    const startTime = Date.now();
    const pollInterval = 3000; // 3 seconds

    return new Observable(observer => {
      const checkZed = () => {
        const elapsed = Date.now() - startTime;
        
        if (elapsed > maxWaitMs) {
          observer.error(new Error('Timeout waiting for Zed to be ready'));
          return;
        }

        console.log(`[WaitForZed] Checking Zed status... (${Math.round(elapsed/1000)}s elapsed)`);
        
        this.http.get<any>(`${this.getBridgeUrl(bridgePort)}/health`, { headers: this.getAuthHeaders(bridgePort) }).subscribe({
          next: (health) => {
            console.log('[WaitForZed] Health response:', health);
            
            if (health.zed_running && health.zed_window_id) {
              console.log('[WaitForZed] Zed is ready! Sending prompt...');
              // Wait a bit more for dialogs to be handled
              setTimeout(() => {
                this.sendZedPrompt(bridgePort, prompt).subscribe({
                  next: (result) => {
                    observer.next(result);
                    observer.complete();
                  },
                  error: (err) => observer.error(err)
                });
              }, 5000); // 5s extra for dialog handling
            } else {
              // Zed not ready, poll again
              setTimeout(checkZed, pollInterval);
            }
          },
          error: (err) => {
            console.log('[WaitForZed] Health check failed, retrying...', err.message);
            // Bridge not ready yet, poll again
            setTimeout(checkZed, pollInterval);
          }
        });
      };

      // Start polling after initial delay (give sandbox time to start)
      setTimeout(checkZed, 5000);
    });
  }

  /**
   * Get conversation history
   */
  getHistory(bridgePort: number): Observable<ConversationMessage[]> {
    return this.http.get<{ history: ConversationMessage[] }>(`${this.getBridgeUrl(bridgePort)}/history`, { headers: this.getAuthHeaders(bridgePort) }).pipe(
      map(res => res.history)
    );
  }

  /**
   * Clear conversation history
   */
  clearHistory(bridgePort: number): Observable<{ status: string }> {
    return this.http.delete<{ status: string }>(`${this.getBridgeUrl(bridgePort)}/history`, { headers: this.getAuthHeaders(bridgePort) });
  }

  /**
   * List project files
   */
  listFiles(bridgePort: number): Observable<{ files: ProjectFile[]; path: string }> {
    return this.http.get<{ files: ProjectFile[]; path: string }>(`${this.getBridgeUrl(bridgePort)}/project/files`, { headers: this.getAuthHeaders(bridgePort) });
  }

  /**
   * Read a file from the project
   */
  readFile(bridgePort: number, filepath: string): Observable<{ content: string; path: string }> {
    return this.http.post<{ content: string; path: string }>(
      `${this.getBridgeUrl(bridgePort)}/project/read`,
      { path: filepath },
      { headers: this.getAuthHeaders(bridgePort) }
    );
  }

  /**
   * Trigger auto-analysis when sandbox starts
   */
  triggerAutoAnalysis(bridgePort: number): Observable<{ status: string; prompt_sent?: string }> {
    const prompt = 'Please analyze this repository and give me an overview of the project structure, main technologies used, and any potential improvements or issues you notice.';
    return this.sendZedPrompt(bridgePort, prompt);
  }

  /**
   * Push changes and prepare for PR creation.
   * Runs git add, commit, push in the sandbox.
   * Returns branch name for backend to create PR.
   */
  pushAndCreatePr(
    bridgePort: number,
    params: {
      branchName: string;
      commitMessage: string;
      prTitle: string;
      prBody?: string;
      gitCredentials?: string; // PAT or token for git push authentication
    }
  ): Observable<{ status: string; branch: string; pr_title: string; pr_body: string }> {
    return this.http.post<{ status: string; branch: string; pr_title: string; pr_body: string }>(
      `${this.getBridgeUrl(bridgePort)}/git/push-and-create-pr`,
      {
        branch_name: params.branchName,
        commit_message: params.commitMessage,
        pr_title: params.prTitle,
        pr_body: params.prBody ?? '',
        git_credentials: params.gitCredentials
      },
      { headers: this.getAuthHeaders(bridgePort) }
    );
  }

  // ============================================================
  // Zed Conversation Endpoints (captures AI responses via proxy)
  // ============================================================

  /**
   * Get all Zed conversations (captured via Bridge API proxy)
   * Use this to get AI responses from Zed's agent panel
   */
  getZedConversations(bridgePort: number): Observable<ZedConversationsResponse> {
    return this.http.get<ZedConversationsResponse>(`${this.getBridgeUrl(bridgePort)}/zed/conversations`, { headers: this.getAuthHeaders(bridgePort) }).pipe(
      catchError(error => {
        console.error('Failed to get Zed conversations:', error);
        return of({ conversations: [], count: 0 });
      })
    );
  }

  /**
   * Get the latest Zed conversation
   */
  getLatestZedConversation(bridgePort: number): Observable<ZedConversation | null> {
    return this.http.get<ZedConversation>(`${this.getBridgeUrl(bridgePort)}/zed/latest`, { headers: this.getAuthHeaders(bridgePort) }).pipe(
      catchError(error => {
        console.error('Failed to get latest conversation:', error);
        return of(null);
      })
    );
  }

  /**
   * Poll for new conversations (returns observable that emits when new conversation arrives)
   * Use with interval: interval(2000).pipe(switchMap(() => pollForNewConversation(port, lastId)))
   */
  pollForNewConversation(bridgePort: number, lastKnownId?: string): Observable<ZedConversation | null> {
    return this.getLatestZedConversation(bridgePort).pipe(
      map(conversation => {
        if (conversation && conversation.id !== lastKnownId) {
          return conversation;
        }
        return null;
      })
    );
  }

  // ============================================================
  // ACP Agent Conversations (DevPilot external agent)
  // ============================================================

  /**
   * Get conversations from the ACP DevPilot agent
   * These are from when user selects "DevPilot" in Zed's agent panel
   */
  getAcpConversations(bridgePort: number): Observable<ZedConversationsResponse> {
    return this.http.get<ZedConversationsResponse>(`${this.getBridgeUrl(bridgePort)}/acp/conversations`, { headers: this.getAuthHeaders(bridgePort) }).pipe(
      catchError(error => {
        console.error('Failed to get ACP conversations:', error);
        return of({ conversations: [], count: 0 });
      })
    );
  }

  /**
   * Get the latest ACP conversation
   */
  getLatestAcpConversation(bridgePort: number): Observable<ZedConversation | null> {
    return this.http.get<ZedConversation>(`${this.getBridgeUrl(bridgePort)}/acp/latest`, { headers: this.getAuthHeaders(bridgePort) }).pipe(
      catchError(error => {
        console.error('Failed to get latest ACP conversation:', error);
        return of(null);
      })
    );
  }

  /**
   * Get ALL conversations (both proxy and ACP)
   * This is the recommended method for getting all AI responses
   */
  getAllConversations(bridgePort: number): Observable<ZedConversationsResponse> {
    return this.http.get<ZedConversationsResponse>(`${this.getBridgeUrl(bridgePort)}/all-conversations`, { headers: this.getAuthHeaders(bridgePort) }).pipe(
      catchError(error => {
        console.error('Failed to get all conversations:', error);
        return of({ conversations: [], count: 0 });
      })
    );
  }

  /**
   * Wait for implementation to complete.
   *
   * The bridge sets `request_in_progress` only for each upstream /v1/chat/completions call.
   * Zed often performs many rounds (text → tools → text → …); between rounds the bridge looks
   * “idle” even though the agent is not finished. A 200 or a single new assistant message is
   * therefore not a reliable “done” signal.
   *
   * Heuristic: require (1) at least one conversation after `promptSentTimestamp`, (2) while not
   * in progress, the *latest* such conversation id unchanged for `stableIdlePolls` consecutive
   * polls. That approximates “quiet period after the last stored assistant reply”.
   *
   * @param bridgePort The bridge port
   * @param promptSentTimestamp Unix time (seconds) when the prompt was sent
   * @param pollIntervalMs Poll interval (default 5000)
   * @param timeoutMs Max wait (default 600000)
   * @param stableIdlePolls Consecutive idle polls with same latest id (default 4 ≈ 20s at 5s interval)
   */
  waitForImplementationComplete(
    bridgePort: number,
    promptSentTimestamp: number,
    pollIntervalMs: number = 5000,
    timeoutMs: number = 600000,
    stableIdlePolls: number = SANDBOX_AGENT_QUIET_POLL_COUNT
  ): Observable<ZedConversation> {
    const stop$ = new Subject<void>();
    const startTime = Date.now();

    interface Accum {
      stableLatestId: string | null;
      consecutiveStableIdle: number;
      lastComplete: ZedConversation | null;
    }

    const initial: Accum = {
      stableLatestId: null,
      consecutiveStableIdle: 0,
      lastComplete: null
    };

    console.log(
      '[WaitForImpl] Monitoring completion (quiet period + stable latest id,',
      stableIdlePolls,
      'polls)...'
    );

    return interval(pollIntervalMs).pipe(
      takeUntil(stop$),
      switchMap(() => {
        const elapsed = Date.now() - startTime;
        if (elapsed > timeoutMs) {
          stop$.next();
          return throwError(() => new Error('Timeout waiting for implementation to complete'));
        }
        console.log(`[WaitForImpl] Polling... (${Math.round(elapsed / 1000)}s elapsed)`);
        return this.getAllConversations(bridgePort);
      }),
      scan((acc: Accum, response): Accum => {
        const inProgress = response.request_in_progress === true;
        const recent = response.conversations.filter(c => c.timestamp > promptSentTimestamp);

        if (inProgress) {
          if (recent.length > 0) {
            const lid = recent[recent.length - 1].id;
            console.log('[WaitForImpl] LLM round in progress (latest captured id:', lid, ')…');
          } else {
            console.log('[WaitForImpl] LLM round in progress, no post-prompt reply yet…');
          }
          return { ...acc, consecutiveStableIdle: 0, lastComplete: null };
        }

        if (recent.length === 0) {
          return { stableLatestId: null, consecutiveStableIdle: 0, lastComplete: null };
        }

        const latest = recent[recent.length - 1];

        if (acc.stableLatestId !== latest.id) {
          console.log('[WaitForImpl] New assistant message; resetting quiet counter →', latest.id.slice(0, 8));
          return {
            stableLatestId: latest.id,
            consecutiveStableIdle: 0,
            lastComplete: null
          };
        }

        const next = acc.consecutiveStableIdle + 1;
        console.log(`[WaitForImpl] Same latest id, bridge idle — quiet ${next}/${stableIdlePolls}`);

        return {
          stableLatestId: latest.id,
          consecutiveStableIdle: next,
          lastComplete: next >= stableIdlePolls ? latest : null
        };
      }, initial),
      map(acc => acc.lastComplete),
      filter((conv): conv is ZedConversation => conv !== null),
      take(1),
      tap(conv => {
        console.log('[WaitForImpl] Implementation complete (quiet period after last reply):', conv.id);
        stop$.next();
      })
    );
  }
}
