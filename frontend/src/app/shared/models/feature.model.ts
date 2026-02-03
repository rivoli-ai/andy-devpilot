import { UserStory } from './user-story.model';

export interface Feature {
  id: string;
  title: string;
  description?: string;
  epicId: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  userStories: UserStory[];
}
