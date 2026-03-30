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
  /** True if the current user owns this repository; false if it is shared with them. */
  isOwner?: boolean;
  /** Number of users this repo is shared with (only for owned repos). */
  sharedWithCount?: number;
  /** When shared with you: name of the person who shared it. */
  ownerName?: string;
  /** When shared with you: email of the person who shared it. */
  ownerEmail?: string;
  /** LLM setting ID for this repo (null = use user default). */
  llmSettingId?: string | null;
  /** Display name of the selected LLM when set. */
  llmSettingName?: string | null;
  /** Custom AI agent rules for this repo. Null = use default template. */
  agentRules?: string | null;
}
