import { Injectable, Inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, of, map, interval, Subject, takeUntil, switchMap, filter, take, tap, scan, throwError } from 'rxjs';
import { APP_CONFIG, AppConfig } from './config.service';

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
  source?: string; // 'proxy' | 'acp_agent' | 'headless_agent'
  had_tool_execution?: boolean; // true if response involved tool calls
  tool_calls?: { name: string; args?: Record<string, unknown>; result?: string }[];
  iterations?: number;
}

export interface LiveResponse {
  content: string;
  user_message: string;
}

/** Live tool calls while headless /agent/prompt is running (poll GET /all-conversations). */
export interface HeadlessProgress {
  tools: {
    name: string;
    args_preview?: string;
    result_preview?: string;
    at?: number;
  }[];
  user_prompt?: string;
}

export interface ZedConversationsResponse {
  conversations: ZedConversation[];
  count: number;
  /** From /all-conversations: true while bridge is handling a chat request (LLM streaming/processing) */
  request_in_progress?: boolean;
  /** Partial assistant text while LLM is still generating */
  live_response?: LiveResponse;
  /** Headless agent only: tools executed so far for the in-flight prompt */
  headless_progress?: HeadlessProgress;
}

export interface SandboxStats {
  gpu: string;
  rendering: 'hardware' | 'software';
  cpu_cores: number;
  cpu_percent: number;
  platform: string;
  memory_total_mb: number;
  memory_available_mb: number;
  memory_used_mb: number;
  memory_percent: number;
  gpu_util_percent: number | null;
  gpu_mem_used_mb: number | null;
  gpu_mem_total_mb: number | null;
  model: string;
  provider: string;
  uptime_seconds: number;
  zed_running: boolean;
  zed_pid: string | null;
  resolution: string;
  conversations_count: number;
  agent_panel_open: boolean;
}

/**
 * Consecutive idle polls (same latest conversation id, no LLM round in flight) before treating
 * the agent as "settled" for Push PR and implementation-complete heuristics.
 */
export const SANDBOX_AGENT_QUIET_POLL_COUNT = 4;

/**
 * Service for interacting with sandbox bridge APIs.
 *
 * All traffic is proxied through the backend at `/api/sandboxes/{id}/bridge/…`
 * so the browser never sees internal sandbox URLs or tokens.
 */
@Injectable({
  providedIn: 'root'
})
export class SandboxBridgeService {
  private apiUrl: string;

  constructor(private http: HttpClient, @Inject(APP_CONFIG) config: AppConfig) {
    this.apiUrl = config.apiUrl;
  }

  private getBridgeUrl(sandboxId: string): string {
    return `${this.apiUrl}/sandboxes/${sandboxId}/bridge`;
  }

  health(sandboxId: string): Observable<HealthResponse> {
    return this.http.get<HealthResponse>(`${this.getBridgeUrl(sandboxId)}/health`).pipe(
      catchError(error => {
        console.error('Bridge health check failed:', error);
        return of({ status: 'error', api_configured: false, model: '', project_path: '' });
      })
    );
  }

  chat(sandboxId: string, message: string): Observable<ChatResponse & { conversation_id?: string }> {
    return this.http.post<ChatResponse & { conversation_id?: string }>(`${this.getBridgeUrl(sandboxId)}/chat`, { message });
  }

  getDebugInfo(sandboxId: string): Observable<{
    status: string;
    api_configured: boolean;
    model: string;
    zed_running: boolean;
    zed_window_id: string | null;
    conversations_count: number;
  }> {
    return this.http.get<any>(`${this.getBridgeUrl(sandboxId)}/debug`).pipe(
      catchError(error => {
        console.error('Debug info failed:', error);
        return of({ status: 'error', api_configured: false, model: '', zed_running: false, zed_window_id: null, conversations_count: 0 });
      })
    );
  }

  analyze(sandboxId: string, focus?: string): Observable<AnalysisResponse> {
    return this.http.post<AnalysisResponse>(`${this.getBridgeUrl(sandboxId)}/analyze`, { focus });
  }

  pasteHostClipboardIntoSandbox(sandboxId: string, text: string): Observable<{ status: string; error?: string }> {
    return this.http.post<{ status: string; error?: string }>(
      `${this.getBridgeUrl(sandboxId)}/clipboard/paste`,
      { text }
    );
  }

  openZedAgent(sandboxId: string): Observable<{ status: string; window_id?: string }> {
    return this.http.post<{ status: string; window_id?: string }>(
      `${this.getBridgeUrl(sandboxId)}/zed/open-agent`,
      {}
    );
  }

  abortStream(sandboxId: string): Observable<{ status: string }> {
    return this.http.post<{ status: string }>(
      `${this.getBridgeUrl(sandboxId)}/stream/abort`,
      {}
    ).pipe(
      catchError(error => {
        console.error('Failed to abort stream:', error);
        return of({ status: 'error' });
      })
    );
  }

  /**
   * Headless agent (same tool loop as ACP / Zed fallback) — POST only, no xdotool/Zed route.
   * Bridge runs the task in a background thread; poll {@link getAllConversations} for {@code prompt_id}.
   *
   * Optional {@code conversationHistory}: prior user/assistant turns (e.g. restored from DB) so the
   * model keeps context when in-container conversation storage is empty or stale.
   */
  sendHeadlessAgentPrompt(
    sandboxId: string,
    prompt: string,
    conversationHistory?: ConversationMessage[]
  ): Observable<{
    status: string;
    prompt_id?: string;
    error?: string;
  }> {
    const body: { prompt: string; conversation_history?: ConversationMessage[] } = { prompt };
    if (conversationHistory && conversationHistory.length > 0) {
      body.conversation_history = conversationHistory;
    }
    return this.http.post<{ status: string; prompt_id?: string; error?: string }>(
      `${this.getBridgeUrl(sandboxId)}/agent/prompt`,
      body
    );
  }

  /** True while the sandbox bridge is running a headless agent task (HTTP 409 if a second starts). */
  getAgentRunningStatus(sandboxId: string): Observable<{ running: boolean }> {
    return this.http.get<{ running: boolean }>(`${this.getBridgeUrl(sandboxId)}/agent/status`).pipe(
      catchError(() => of({ running: false }))
    );
  }

  sendZedPrompt(sandboxId: string, prompt: string): Observable<{ status: string; prompt_sent?: string; prompt_id?: string }> {
    const bridgeUrl = this.getBridgeUrl(sandboxId);

    return this.http.post<{ status: string; prompt_sent?: string; prompt_id?: string }>(
      `${bridgeUrl}/zed/send-prompt`,
      { prompt }
    ).pipe(
      catchError(() => {
        console.warn('[sendZedPrompt] xdotool route failed, falling back to headless agent');
        return this.http.post<{ status: string; prompt_sent?: string; prompt_id?: string }>(
          `${bridgeUrl}/agent/prompt`,
          { prompt }
        );
      })
    );
  }

  waitForZedAndSendPrompt(
    sandboxId: string,
    prompt: string,
    maxWaitMs: number = 90000
  ): Observable<{ status: string; prompt_sent?: string; prompt_id?: string }> {
    const startTime = Date.now();
    const pollInterval = 3000;

    return new Observable(observer => {
      const checkBridge = () => {
        const elapsed = Date.now() - startTime;

        if (elapsed > maxWaitMs) {
          observer.error(new Error('Timeout waiting for bridge to be ready'));
          return;
        }

        console.log(`[WaitForBridge] Checking bridge health... (${Math.round(elapsed/1000)}s elapsed)`);

        this.http.get<any>(`${this.getBridgeUrl(sandboxId)}/health`).subscribe({
          next: (health) => {
            console.log('[WaitForBridge] Health response:', health);

            if (health.status === 'ok' && health.api_configured) {
              console.log('[WaitForBridge] Bridge ready — sending prompt to Zed...');
              this.sendZedPrompt(sandboxId, prompt).subscribe({
                next: (result) => {
                  observer.next(result);
                  observer.complete();
                },
                error: (err) => observer.error(err)
              });
            } else {
              setTimeout(checkBridge, pollInterval);
            }
          },
          error: (err) => {
            console.log('[WaitForBridge] Health check failed, retrying...', err.message);
            setTimeout(checkBridge, pollInterval);
          }
        });
      };

      setTimeout(checkBridge, 3000);
    });
  }

  getHistory(sandboxId: string): Observable<ConversationMessage[]> {
    return this.http.get<{ history: ConversationMessage[] }>(`${this.getBridgeUrl(sandboxId)}/history`).pipe(
      map(res => res.history)
    );
  }

  clearHistory(sandboxId: string): Observable<{ status: string }> {
    return this.http.delete<{ status: string }>(`${this.getBridgeUrl(sandboxId)}/history`);
  }

  listFiles(sandboxId: string): Observable<{ files: ProjectFile[]; path: string }> {
    return this.http.get<{ files: ProjectFile[]; path: string }>(`${this.getBridgeUrl(sandboxId)}/project/files`);
  }

  readFile(sandboxId: string, filepath: string): Observable<{ content: string; path: string }> {
    return this.http.post<{ content: string; path: string }>(
      `${this.getBridgeUrl(sandboxId)}/project/read`,
      { path: filepath }
    );
  }

  triggerAutoAnalysis(sandboxId: string): Observable<{ status: string; prompt_sent?: string }> {
    const prompt = 'Please analyze this repository and give me an overview of the project structure, main technologies used, and any potential improvements or issues you notice.';
    return this.sendZedPrompt(sandboxId, prompt);
  }

  pushAndCreatePr(
    sandboxId: string,
    params: {
      branchName: string;
      commitMessage: string;
      prTitle: string;
      prBody?: string;
      gitCredentials?: string;
    }
  ): Observable<{ status: string; branch: string; pr_title: string; pr_body: string }> {
    return this.http.post<{ status: string; branch: string; pr_title: string; pr_body: string }>(
      `${this.getBridgeUrl(sandboxId)}/git/push-and-create-pr`,
      {
        branch_name: params.branchName,
        commit_message: params.commitMessage,
        pr_title: params.prTitle,
        pr_body: params.prBody ?? '',
        git_credentials: params.gitCredentials
      }
    );
  }

  // ============================================================
  // Zed Conversation Endpoints (captures AI responses via proxy)
  // ============================================================

  getZedConversations(sandboxId: string): Observable<ZedConversationsResponse> {
    return this.http.get<ZedConversationsResponse>(`${this.getBridgeUrl(sandboxId)}/zed/conversations`).pipe(
      catchError(error => {
        console.error('Failed to get Zed conversations:', error);
        return of({ conversations: [], count: 0 });
      })
    );
  }

  getLatestZedConversation(sandboxId: string): Observable<ZedConversation | null> {
    return this.http.get<ZedConversation>(`${this.getBridgeUrl(sandboxId)}/zed/latest`).pipe(
      catchError(error => {
        console.error('Failed to get latest conversation:', error);
        return of(null);
      })
    );
  }

  pollForNewConversation(sandboxId: string, lastKnownId?: string): Observable<ZedConversation | null> {
    return this.getLatestZedConversation(sandboxId).pipe(
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

  getAcpConversations(sandboxId: string): Observable<ZedConversationsResponse> {
    return this.http.get<ZedConversationsResponse>(`${this.getBridgeUrl(sandboxId)}/acp/conversations`).pipe(
      catchError(error => {
        console.error('Failed to get ACP conversations:', error);
        return of({ conversations: [], count: 0 });
      })
    );
  }

  getLatestAcpConversation(sandboxId: string): Observable<ZedConversation | null> {
    return this.http.get<ZedConversation>(`${this.getBridgeUrl(sandboxId)}/acp/latest`).pipe(
      catchError(error => {
        console.error('Failed to get latest ACP conversation:', error);
        return of(null);
      })
    );
  }

  /** Fails the observable on HTTP errors so callers can stop polling when the sandbox is gone. */
  getAllConversations(sandboxId: string, storyIdForPersistence?: string): Observable<ZedConversationsResponse> {
    const base = `${this.getBridgeUrl(sandboxId)}/all-conversations`;
    const sid = storyIdForPersistence?.trim() ?? '';
    const isStoryGuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sid);
    const url = sid && isStoryGuid ? `${base}?storyId=${encodeURIComponent(sid)}` : base;
    return this.http.get<ZedConversationsResponse>(url);
  }

  /**
   * Wait for implementation to complete.
   *
   * Heuristic: require (1) at least one conversation after `promptSentTimestamp`, (2) while not
   * in progress, the *latest* such conversation id unchanged for `stableIdlePolls` consecutive
   * polls. That approximates "quiet period after the last stored assistant reply".
   */
  waitForImplementationComplete(
    sandboxId: string,
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
        return this.getAllConversations(sandboxId);
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

  checkHealth(sandboxId: string): Observable<HealthResponse | null> {
    return this.http.get<HealthResponse>(`${this.getBridgeUrl(sandboxId)}/health`).pipe(
      catchError(() => of(null))
    );
  }

  getSystemInfo(sandboxId: string): Observable<SandboxStats | null> {
    return this.http.get<SandboxStats>(`${this.getBridgeUrl(sandboxId)}/system-info`).pipe(
      catchError(() => of(null))
    );
  }
}
