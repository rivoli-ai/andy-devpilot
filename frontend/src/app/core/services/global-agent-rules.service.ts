import { Injectable, inject } from '@angular/core';
import { firstValueFrom, Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface GlobalAgentRuleDto {
  id: string;
  name: string;
  body: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string | null;
}

export interface SaveGlobalAgentRuleRequest {
  name: string;
  body: string;
  sortOrder: number;
}

@Injectable({
  providedIn: 'root'
})
export class GlobalAgentRulesService {
  private api = inject(ApiService);

  list(): Observable<GlobalAgentRuleDto[]> {
    return this.api.get<GlobalAgentRuleDto[]>('/GlobalAgentRules');
  }

  getById(id: string) {
    return this.api.get<GlobalAgentRuleDto>(`/GlobalAgentRules/${id}`);
  }

  create(body: SaveGlobalAgentRuleRequest) {
    return this.api.post<GlobalAgentRuleDto>('/GlobalAgentRules', body);
  }

  update(id: string, body: SaveGlobalAgentRuleRequest) {
    return this.api.put<void>(`/GlobalAgentRules/${id}`, body);
  }

  remove(id: string) {
    return this.api.delete<void>(`/GlobalAgentRules/${id}`);
  }

  async listAsync(): Promise<GlobalAgentRuleDto[]> {
    return (await firstValueFrom(this.list())) ?? [];
  }
}
