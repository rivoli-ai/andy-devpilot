import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

export interface AnalysisResult {
  reasoning: string;
  epics: EpicAnalysis[];
  metadata: {
    analysisTimestamp: string;
    model: string;
    reasoning: string;
  };
}

export interface EpicAnalysis {
  title: string;
  description: string;
  features: FeatureAnalysis[];
}

export interface FeatureAnalysis {
  title: string;
  description: string;
  userStories: UserStoryAnalysis[];
}

export interface UserStoryAnalysis {
  title: string;
  description: string;
  acceptanceCriteria: string;
  tasks: TaskAnalysis[];
}

export interface TaskAnalysis {
  title: string;
  description: string;
  complexity: string;
}

export interface AnalyzeRepositoryRequest {
  repositoryContent?: string;
  saveResults?: boolean;
}

/**
 * Service for analyzing repositories using AI
 */
@Injectable({
  providedIn: 'root'
})
export class AnalysisService {
  constructor(private apiService: ApiService) {}

  /**
   * Analyze a repository and optionally save results
   * @param repositoryId Repository ID to analyze
   * @param request Analysis request with optional content and save flag
   */
  analyzeRepository(repositoryId: string, request?: AnalyzeRepositoryRequest): Observable<AnalysisResult> {
    return this.apiService.post<AnalysisResult>(`/repositories/${repositoryId}/analyze`, request || {});
  }

  /**
   * Analyze and save results in one call
   * @param repositoryId Repository ID to analyze
   * @param repositoryContent Optional repository content
   */
  analyzeAndSave(repositoryId: string, repositoryContent?: string): Observable<{ analysis: AnalysisResult; itemsSaved: number; message: string }> {
    return this.apiService.post<{ analysis: AnalysisResult; itemsSaved: number; message: string }>(
      `/repositories/${repositoryId}/analyze`,
      { repositoryContent, saveResults: true }
    );
  }

  /**
   * Save existing analysis results to database
   * @param repositoryId Repository ID
   * @param analysisResult Analysis result to save
   */
  saveAnalysisResults(repositoryId: string, analysisResult: AnalysisResult): Observable<{ itemsSaved: number; message: string }> {
    return this.apiService.post<{ itemsSaved: number; message: string }>(
      `/repositories/${repositoryId}/analyze/save`,
      analysisResult
    );
  }
}
