import { Injectable, Inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { APP_CONFIG, AppConfig } from './config.service';

/** Matches Code Ask UI messages; persisted server-side per user + repository + branch. */
export interface CodeAskPersistedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCallsSummary?: string;
}

@Injectable({
  providedIn: 'root'
})
export class CodeAskConversationService {
  constructor(
    private http: HttpClient,
    @Inject(APP_CONFIG) private config: AppConfig
  ) {}

  getMessages(repositoryId: string, branch: string): Observable<CodeAskPersistedMessage[]> {
    const q = encodeURIComponent(branch);
    return this.http
      .get<{ messages: CodeAskPersistedMessage[] }>(
        `${this.config.apiUrl}/repositories/${repositoryId}/code-ask?branch=${q}`
      )
      .pipe(map(r => r.messages ?? []));
  }

  saveMessages(repositoryId: string, branch: string, messages: CodeAskPersistedMessage[]): Observable<void> {
    return this.http
      .put<void>(`${this.config.apiUrl}/repositories/${repositoryId}/code-ask`, {
        repo_branch: branch,
        messages
      })
      .pipe(map(() => undefined));
  }
}
