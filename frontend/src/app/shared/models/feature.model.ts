import { UserStory } from './user-story.model';

export interface Feature {
  id: string;
  title: string;
  description?: string;
  epicId: string;
  status: string;
  /** "Manual" | "AzureDevOps" | "GitHub" */
  source?: string;
  azureDevOpsWorkItemId?: number;
  createdAt: string;
  updatedAt?: string;
  userStories: UserStory[];
}
