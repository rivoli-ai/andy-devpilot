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
  gitHubIssueNumber?: number;
  /** When set, sandbox agent rules use this named repository profile instead of the repo default. */
  repositoryAgentRuleId?: string | null;
  createdAt: string;
  updatedAt?: string;
  tasks: Task[];
}
