import { Injectable, signal, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';

export interface ArtifactFeedDto {
  id: string;
  name: string;
  organization: string;
  feedName: string;
  projectName?: string;
  feedType: 'nuget' | 'npm' | 'pip';
  isEnabled: boolean;
}

export interface AzureDevOpsFeedDto {
  id: string;
  name: string;
  fullyQualifiedName?: string;
  project?: string;
  url?: string;
}

export interface CreateArtifactFeedRequest {
  name: string;
  organization: string;
  feedName: string;
  projectName?: string;
  feedType: 'nuget' | 'npm' | 'pip';
  isEnabled?: boolean;
}

export interface UpdateArtifactFeedRequest {
  name?: string;
  organization?: string;
  feedName?: string;
  projectName?: string;
  feedType?: 'nuget' | 'npm' | 'pip';
  isEnabled?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class ArtifactFeedService {
  private api = inject(ApiService);
  private feedsSignal = signal<ArtifactFeedDto[]>([]);
  private loadedSignal = signal(false);

  feeds = this.feedsSignal.asReadonly();
  isLoaded = this.loadedSignal.asReadonly();

  constructor() {
    this.loadFeeds();
  }

  async loadFeeds(): Promise<void> {
    try {
      const list = await firstValueFrom(this.api.get<ArtifactFeedDto[]>('/artifact'));
      this.feedsSignal.set(list ?? []);
    } catch (e) {
      console.error('Failed to load artifact feeds:', e);
      this.feedsSignal.set([]);
    } finally {
      this.loadedSignal.set(true);
    }
  }

  async browseAzureFeeds(organization: string): Promise<AzureDevOpsFeedDto[]> {
    try {
      return await firstValueFrom(
        this.api.get<AzureDevOpsFeedDto[]>(`/artifact/feeds?organization=${encodeURIComponent(organization)}`)
      );
    } catch (e) {
      console.error('Failed to browse Azure DevOps feeds:', e);
      throw e;
    }
  }

  async create(request: CreateArtifactFeedRequest): Promise<ArtifactFeedDto> {
    const result = await firstValueFrom(this.api.post<ArtifactFeedDto>('/artifact', request));
    await this.loadFeeds();
    return result;
  }

  async update(id: string, request: UpdateArtifactFeedRequest): Promise<ArtifactFeedDto> {
    const result = await firstValueFrom(this.api.patch<ArtifactFeedDto>(`/artifact/${id}`, request));
    await this.loadFeeds();
    return result;
  }

  async delete(id: string): Promise<void> {
    await firstValueFrom(this.api.delete(`/artifact/${id}`));
    await this.loadFeeds();
  }

  async getEnabledFeeds(): Promise<ArtifactFeedDto[]> {
    try {
      return await firstValueFrom(this.api.get<ArtifactFeedDto[]>('/artifact/enabled'));
    } catch (e) {
      console.error('Failed to load enabled artifact feeds:', e);
      return [];
    }
  }
}
