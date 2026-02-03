export interface Task {
  id: string;
  title: string;
  description?: string;
  userStoryId: string;
  status: string;
  complexity: string;
  assignedTo?: string;
  createdAt: string;
  updatedAt?: string;
}
