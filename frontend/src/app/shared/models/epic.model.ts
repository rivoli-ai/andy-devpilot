import { Feature } from './feature.model';

export interface Epic {
  id: string;
  title: string;
  description?: string;
  repositoryId: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  features: Feature[];
}
