import { Feature } from './feature.model';

export interface Epic {
  id: string;
  title: string;
  description?: string;
  repositoryId: string;
  status: string;
  /** "Manual" | "AzureDevOps" | "GitHub" */
  source?: string;
  azureDevOpsWorkItemId?: number;
  createdAt: string;
  updatedAt?: string;
  features: Feature[];
}
