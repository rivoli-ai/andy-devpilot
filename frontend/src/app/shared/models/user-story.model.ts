import { Task } from './task.model';

export interface UserStory {
  id: string;
  title: string;
  description?: string;
  featureId: string;
  status: string;
  acceptanceCriteria?: string;
  prUrl?: string; // Pull Request URL when implemented
  storyPoints?: number;
  priority?: string;
  /** "Manual" | "AzureDevOps" | "GitHub" */
  source?: string;
  azureDevOpsWorkItemId?: number;
  createdAt: string;
  updatedAt?: string;
  tasks: Task[];
}
