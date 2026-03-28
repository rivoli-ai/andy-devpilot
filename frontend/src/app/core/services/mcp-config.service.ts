import { Injectable, signal, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';

export interface McpServerDto {
  id: string;
  name: string;
  serverType: 'stdio' | 'remote';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isEnabled: boolean;
  isShared: boolean;
  hasEnv: boolean;
  hasHeaders: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: string;
}

export interface CreateMcpServerRequest {
  name: string;
  serverType: 'stdio' | 'remote';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isEnabled?: boolean;
}

export interface UpdateMcpServerRequest {
  name?: string;
  serverType?: 'stdio' | 'remote';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isEnabled?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class McpConfigService {
  private api = inject(ApiService);
  private serversSignal = signal<McpServerDto[]>([]);
  private loadedSignal = signal(false);
  private toolsCacheSignal = signal<Record<string, { tools: McpToolInfo[]; loading: boolean; error?: string }>>({});

  servers = this.serversSignal.asReadonly();
  isLoaded = this.loadedSignal.asReadonly();
  toolsCache = this.toolsCacheSignal.asReadonly();

  constructor() {
    this.loadServers();
  }

  async loadServers(): Promise<void> {
    try {
      const list = await firstValueFrom(this.api.get<McpServerDto[]>('/mcp'));
      this.serversSignal.set(list ?? []);
    } catch (e) {
      console.error('Failed to load MCP servers:', e);
      this.serversSignal.set([]);
    } finally {
      this.loadedSignal.set(true);
    }
  }

  /** Returns enabled MCP servers with full secrets (for sandbox injection). */
  async getEnabledServers(): Promise<McpServerDto[]> {
    try {
      return await firstValueFrom(this.api.get<McpServerDto[]>('/mcp/enabled'));
    } catch (e) {
      console.error('Failed to load enabled MCP servers:', e);
      return [];
    }
  }

  async create(request: CreateMcpServerRequest): Promise<McpServerDto> {
    const result = await firstValueFrom(this.api.post<McpServerDto>('/mcp', request));
    await this.loadServers();
    return result;
  }

  async update(id: string, request: UpdateMcpServerRequest): Promise<McpServerDto> {
    const result = await firstValueFrom(this.api.patch<McpServerDto>(`/mcp/${id}`, request));
    await this.loadServers();
    return result;
  }

  async delete(id: string): Promise<void> {
    await firstValueFrom(this.api.delete(`/mcp/${id}`));
    await this.loadServers();
  }

  async toggle(id: string): Promise<McpServerDto> {
    const result = await firstValueFrom(this.api.post<McpServerDto>(`/mcp/${id}/toggle`, {}));
    await this.loadServers();
    return result;
  }

  // Admin shared MCP servers
  async adminCreate(request: CreateMcpServerRequest): Promise<McpServerDto> {
    const result = await firstValueFrom(this.api.post<McpServerDto>('/mcp/admin', request));
    await this.loadServers();
    return result;
  }

  async adminUpdate(id: string, request: UpdateMcpServerRequest): Promise<McpServerDto> {
    const result = await firstValueFrom(this.api.patch<McpServerDto>(`/mcp/admin/${id}`, request));
    await this.loadServers();
    return result;
  }

  async adminDelete(id: string): Promise<void> {
    await firstValueFrom(this.api.delete(`/mcp/admin/${id}`));
    await this.loadServers();
  }

  async discoverTools(id: string): Promise<McpToolInfo[]> {
    this.toolsCacheSignal.update(cache => ({
      ...cache,
      [id]: { tools: [], loading: true, error: undefined },
    }));
    try {
      const tools = await firstValueFrom(this.api.post<McpToolInfo[]>(`/mcp/${id}/tools`, {}));
      this.toolsCacheSignal.update(cache => ({
        ...cache,
        [id]: { tools: tools ?? [], loading: false },
      }));
      return tools ?? [];
    } catch (e: any) {
      const message = e?.error?.message || e?.message || 'Failed to discover tools';
      this.toolsCacheSignal.update(cache => ({
        ...cache,
        [id]: { tools: [], loading: false, error: message },
      }));
      return [];
    }
  }

  getToolsState(id: string): { tools: McpToolInfo[]; loading: boolean; error?: string } | undefined {
    return this.toolsCacheSignal()[id];
  }
}
