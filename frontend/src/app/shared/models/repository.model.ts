/**
 * Repository model matching the backend DTO
 */
export interface Repository {
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  description?: string;
  isPrivate: boolean;
  provider: string;
  organizationName: string;
  defaultBranch?: string;
  createdAt: string;
  updatedAt?: string;
}
