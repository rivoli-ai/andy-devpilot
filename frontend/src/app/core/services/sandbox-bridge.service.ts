import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, catchError, of, map, interval, Subject, takeUntil, switchMap, filter, take, tap, scan, throwError } from 'rxjs';
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

  private getBridgeUrl(sandboxId: string): string {
    const viewer = this.vncViewerService.getViewer(sandboxId);
    if (viewer?.bridgeUrl) {
      return viewer.bridgeUrl;
    }
    throw new Error(`No bridge URL found for sandbox ${sandboxId}`);
  }

  private getAuthHeaders(sandboxId: string): HttpHeaders {
    const viewer = this.vncViewerService.getViewer(sandboxId);
    const token = viewer?.sandboxToken;
    return token
      ? new HttpHeaders({ Authorization: `Bearer ${token}` })
      : new HttpHeaders();
  }

  health(sandboxId: string): Observable<HealthResponse> {
    return this.http.get<HealthResponse>(`${this.getBridgeUrl(sandboxId)}/health`, { headers: this.getAuthHeaders(sandboxId) }).pipe(
      catchError(error => {
        console.error('Bridge health check failed:', error);
        return of({ status: 'error', api_configured: false, model: '', project_path: '' });
      })
    );
  }

  chat(sandboxId: string, message: string): Observable<ChatResponse & { conversation_id?: string }> {
    return this.http.post<ChatResponse & { conversation_id?: string }>(`${this.getBridgeUrl(sandboxId)}/chat`, { message }, { headers: this.getAuthHeaders(sandboxId) });
  }

  getDebugInfo(sandboxId: string): Observable<{
    status: string;
    api_configured: boolean;
    model: string;
    zed_running: boolean;
    zed_window_id: string | null;
    conversations_count: number;
  }> {
    return this.http.get<any>(`${this.getBridgeUrl(sandboxId)}/debug`, { headers: this.getAuthHeaders(sandboxId) }).pipe(
      catchError(error => {
        console.error('Debug info failed:', error);
        return of({ status: 'error', api_configured: false, model: '', zed_running: false, zed_window_id: null, conversations_count: 0 });
      })
    );
  }

  analyze(sandboxId: string, focus?: string): Observable<AnalysisResponse> {
    return this.http.post<AnalysisResponse>(`${this.getBridgeUrl(sandboxId)}/analyze`, { focus }, { headers: this.getAuthHeaders(sandboxId) });
  }

  pasteHostClipboardIntoSandbox(sandboxId: string, text: string): Observable<{ status: string; error?: string }> {
    return this.http.post<{ status: string; error?: string }>(
      `${this.getBridgeUrl(sandboxId)}/clipboard/paste`,
      { text },
      { headers: this.getAuthHeaders(sandboxId) }
    );
  }

  openZedAgent(sandboxId: string): Observable<{ status: string; window_id?: string }> {
    return this.http.post<{ status: string; window_id?: string }>(
      `${this.getBridgeUrl(sandboxId)}/zed/open-agent`,
      {},
      { headers: this.getAuthHeaders(sandboxId) }
    );
  }

  sendZedPrompt(sandboxId: string, prompt: string): Observable<{ status: string; prompt_sent?: string }> {
    return this.http.post<{ status: string; prompt_sent?: string }>(
      `${this.getBridgeUrl(sandboxId)}/zed/send-prompt`,
      { prompt },
      { headers: this.getAuthHeaders(sandboxId) }
    );
  }

  waitForZedAndSendPrompt(
    sandboxId: string,
    prompt: string,
    maxWaitMs: number = 90000
  ): Observable<{ status: string; prompt_sent?: string }> {
    const startTime = Date.now();
    const pollInterval = 3000;

    return new Observable(observer => {
      const checkZed = () => {
        const elapsed = Date.now() - startTime;

        if (elapsed > maxWaitMs) {
          observer.error(new Error('Timeout waiting for Zed to be ready'));
          return;
        }

        console.log(`[WaitForZed] Checking Zed status... (${Math.round(elapsed/1000)}s elapsed)`);

        this.http.get<any>(`${this.getBridgeUrl(sandboxId)}/health`, { headers: this.getAuthHeaders(sandboxId) }).subscribe({
          next: (health) => {
            console.log('[WaitForZed] Health response:', health);

            if (health.zed_running && health.zed_window_id) {
              console.log('[WaitForZed] Zed is ready! Sending prompt...');
              setTimeout(() => {
                this.sendZedPrompt(sandboxId, prompt).subscribe({
                  next: (result) => {
                    observer.next(result);
                    observer.complete();
                  },
                  error: (err) => observer.error(err)
                });
              }, 5000);
            } else {
              setTimeout(checkZed, pollInterval);
            }
          },
          error: (err) => {
            console.log('[WaitForZed] Health check failed, retrying...', err.message);
            setTimeout(checkZed, pollInterval);
          }
        });
      };

      setTimeout(checkZed, 5000);
    });
  }

  getHistory(sandboxId: string): Observable<ConversationMessage[]> {
    return this.http.get<{ history: ConversationMessage[] }>(`${this.getBridgeUrl(sandboxId)}/history`, { headers: this.getAuthHeaders(sandboxId) }).pipe(
      map(res => res.history)
    );
  }

  clearHistory(sandboxId: string): Observable<{ status: string }> {
    return this.http.delete<{ status: string }>(`${this.getBridgeUrl(sandboxId)}/history`, { headers: this.getAuthHeaders(sandboxId) });
  }

  listFiles(sandboxId: string): Observable<{ files: ProjectFile[]; path: string }> {
    return this.http.get<{ files: ProjectFile[]; path: string }>(`${this.getBridgeUrl(sandboxId)}/project/files`, { headers: this.getAuthHeaders(sandboxId) });
  }

  readFile(sandboxId: string, filepath: string): Observable<{ content: string; path: string }> {
    return this.http.post<{ content: string; path: string }>(
      `${this.getBridgeUrl(sandboxId)}/project/read`,
      { path: filepath },
      { headers: this.getAuthHeaders(sandboxId) }
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
      },
      { headers: this.getAuthHeaders(sandboxId) }
    );
  }

  // ============================================================
  // Zed Conversation Endpoints (captures AI responses via proxy)
  // ============================================================

  getZedConversations(sandboxId: string): Observable<ZedConversationsResponse> {
    return this.http.get<ZedConversationsResponse>(`${this.getBridgeUrl(sandboxId)}/zed/conversations`, { headers: this.getAuthHeaders(sandboxId) }).pipe(
      catchError(error => {
        console.error('Failed to get Zed conversations:', error);
        return of({ conversations: [], count: 0 });
      })
    );
  }

  getLatestZedConversation(sandboxId: string): Observable<ZedConversation | null> {
    return this.http.get<ZedConversation>(`${this.getBridgeUrl(sandboxId)}/zed/latest`, { headers: this.getAuthHeaders(sandboxId) }).pipe(
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
    return this.http.get<ZedConversationsResponse>(`${this.getBridgeUrl(sandboxId)}/acp/conversations`, { headers: this.getAuthHeaders(sandboxId) }).pipe(
      catchError(error => {
        console.error('Failed to get ACP conversations:', error);
        return of({ conversations: [], count: 0 });
      })
    );
  }

  getLatestAcpConversation(sandboxId: string): Observable<ZedConversation | null> {
    return this.http.get<ZedConversation>(`${this.getBridgeUrl(sandboxId)}/acp/latest`, { headers: this.getAuthHeaders(sandboxId) }).pipe(
      catchError(error => {
        console.error('Failed to get latest ACP conversation:', error);
        return of(null);
      })
    );
  }

  getAllConversations(sandboxId: string): Observable<ZedConversationsResponse> {
    return this.http.get<ZedConversationsResponse>(`${this.getBridgeUrl(sandboxId)}/all-conversations`, { headers: this.getAuthHeaders(sandboxId) }).pipe(
      catchError(error => {
        console.error('Failed to get all conversations:', error);
        return of({ conversations: [], count: 0 });
      })
    );
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
}
