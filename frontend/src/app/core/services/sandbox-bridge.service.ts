import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, of, map, interval, Subject, takeUntil, switchMap, filter, take, tap } from 'rxjs';
import { VPS_CONFIG } from '../config/vps.config';

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
}

@Injectable({
  providedIn: 'root'
})
export class SandboxBridgeService {
  private http = inject(HttpClient);

  /**
   * Get the bridge API URL for a sandbox
   */
  private getBridgeUrl(bridgePort: number): string {
    return `http://${VPS_CONFIG.ip}:${bridgePort}`;
  }

  /**
   * Check if the bridge API is healthy
   */
  health(bridgePort: number): Observable<HealthResponse> {
    return this.http.get<HealthResponse>(`${this.getBridgeUrl(bridgePort)}/health`).pipe(
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
    return this.http.post<ChatResponse & { conversation_id?: string }>(`${this.getBridgeUrl(bridgePort)}/chat`, { message });
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
    return this.http.get<any>(`${this.getBridgeUrl(bridgePort)}/debug`).pipe(
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
    return this.http.post<AnalysisResponse>(`${this.getBridgeUrl(bridgePort)}/analyze`, { focus });
  }

  /**
   * Open Zed's agent panel
   */
  openZedAgent(bridgePort: number): Observable<{ status: string; window_id?: string }> {
    return this.http.post<{ status: string; window_id?: string }>(
      `${this.getBridgeUrl(bridgePort)}/zed/open-agent`,
      {}
    );
  }

  /**
   * Send a prompt to Zed's agent panel
   */
  sendZedPrompt(bridgePort: number, prompt: string): Observable<{ status: string; prompt_sent?: string }> {
    return this.http.post<{ status: string; prompt_sent?: string }>(
      `${this.getBridgeUrl(bridgePort)}/zed/send-prompt`,
      { prompt }
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
        
        this.http.get<any>(`${this.getBridgeUrl(bridgePort)}/health`).subscribe({
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
    return this.http.get<{ history: ConversationMessage[] }>(`${this.getBridgeUrl(bridgePort)}/history`).pipe(
      map(res => res.history)
    );
  }

  /**
   * Clear conversation history
   */
  clearHistory(bridgePort: number): Observable<{ status: string }> {
    return this.http.delete<{ status: string }>(`${this.getBridgeUrl(bridgePort)}/history`);
  }

  /**
   * List project files
   */
  listFiles(bridgePort: number): Observable<{ files: ProjectFile[]; path: string }> {
    return this.http.get<{ files: ProjectFile[]; path: string }>(`${this.getBridgeUrl(bridgePort)}/project/files`);
  }

  /**
   * Read a file from the project
   */
  readFile(bridgePort: number, filepath: string): Observable<{ content: string; path: string }> {
    return this.http.post<{ content: string; path: string }>(
      `${this.getBridgeUrl(bridgePort)}/project/read`,
      { path: filepath }
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
      }
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
    return this.http.get<ZedConversationsResponse>(`${this.getBridgeUrl(bridgePort)}/zed/conversations`).pipe(
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
    return this.http.get<ZedConversation>(`${this.getBridgeUrl(bridgePort)}/zed/latest`).pipe(
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
    return this.http.get<ZedConversationsResponse>(`${this.getBridgeUrl(bridgePort)}/acp/conversations`).pipe(
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
    return this.http.get<ZedConversation>(`${this.getBridgeUrl(bridgePort)}/acp/latest`).pipe(
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
    return this.http.get<ZedConversationsResponse>(`${this.getBridgeUrl(bridgePort)}/all-conversations`).pipe(
      catchError(error => {
        console.error('Failed to get all conversations:', error);
        return of({ conversations: [], count: 0 });
      })
    );
  }

  /**
   * Wait for implementation to complete.
   * Polls the conversations endpoint and detects when the AI has finished responding.
   * Waits for a conversation to appear and then stabilize (no new conversations for a while).
   * 
   * @param bridgePort The bridge port
   * @param promptSentTimestamp The timestamp when the prompt was sent (to ignore older conversations)
   * @param pollIntervalMs Poll interval in milliseconds (default 5000 = 5s)
   * @param timeoutMs Maximum time to wait (default 600000 = 10 minutes)
   */
  waitForImplementationComplete(
    bridgePort: number,
    promptSentTimestamp: number,
    pollIntervalMs: number = 5000,
    timeoutMs: number = 600000
  ): Observable<ZedConversation> {
    const stop$ = new Subject<void>();
    const startTime = Date.now();
    let lastConversationId: string | null = null;
    let lastChangeTime: number = Date.now();
    let latestConversation: ZedConversation | null = null;
    const stabilityThresholdMs = 30000; // Wait 30s without changes to consider "done"

    console.log('[WaitForImpl] Starting to monitor for implementation completion...');
    console.log('[WaitForImpl] Will wait for AI to be idle for 30s before marking as ready');

    return interval(pollIntervalMs).pipe(
      takeUntil(stop$),
      switchMap(() => {
        const elapsed = Date.now() - startTime;
        
        // Check timeout
        if (elapsed > timeoutMs) {
          console.log('[WaitForImpl] Timeout waiting for implementation');
          stop$.next();
          throw new Error('Timeout waiting for implementation to complete');
        }

        console.log(`[WaitForImpl] Polling... (${Math.round(elapsed/1000)}s elapsed)`);
        return this.getZedConversations(bridgePort);
      }),
      map(response => {
        // Find conversations that happened after we sent the prompt
        const recentConversations = response.conversations.filter(
          c => c.timestamp > promptSentTimestamp
        );

        if (recentConversations.length > 0) {
          // Get the most recent one
          const latest = recentConversations[recentConversations.length - 1];
          
          // Check if this is a new conversation we haven't seen
          if (latest.id !== lastConversationId) {
            lastConversationId = latest.id;
            lastChangeTime = Date.now();
            latestConversation = latest;
            console.log('[WaitForImpl] New conversation detected:', {
              id: latest.id,
              responseLength: latest.assistant_message?.length || 0,
              hadToolExecution: latest.had_tool_execution
            });
          }
          
          // Check if we have a conversation and it's been stable for a while
          const timeSinceLastChange = Date.now() - lastChangeTime;
          if (latestConversation && timeSinceLastChange >= stabilityThresholdMs) {
            console.log(`[WaitForImpl] AI has been idle for ${Math.round(timeSinceLastChange/1000)}s - marking as complete`);
            return latestConversation;
          } else if (latestConversation) {
            console.log(`[WaitForImpl] Waiting for stability... ${Math.round(timeSinceLastChange/1000)}s since last change`);
          }
        }
        return null;
      }),
      filter((conv): conv is ZedConversation => conv !== null),
      take(1), // Complete after stable conversation detected
      tap(conv => {
        console.log('[WaitForImpl] Implementation complete!', conv.id);
        stop$.next();
      })
    );
  }
}
