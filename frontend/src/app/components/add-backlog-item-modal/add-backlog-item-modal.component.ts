import { Component, input, output, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BacklogService } from '../../core/services/backlog.service';
import { AIConfigService } from '../../core/services/ai-config.service';

export type AddItemType = 'epic' | 'feature' | 'story';

export interface EpicOption {
  id: string;
  title: string;
}

export interface FeatureOption {
  id: string;
  title: string;
  epicTitle: string;
}

export interface EditItemData {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  storyPoints?: number;
  status?: string;
}

@Component({
  selector: 'app-add-backlog-item-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="modal-backdrop" (click)="cancel.emit()">
      <div class="modal-box" [class]="'type-' + itemType()" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <div class="modal-header-left">
            <span class="type-badge" [class]="itemType()">{{ itemType() === 'epic' ? 'E' : itemType() === 'feature' ? 'F' : 'S' }}</span>
            <h3>{{ isEditMode() ? 'Edit' : 'Add' }} {{ typeLabel() }}</h3>
          </div>
          <button type="button" class="close-btn" (click)="cancel.emit()" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <form (ngSubmit)="onSubmit()" class="modal-body">
          @if (itemType() === 'feature' && needsParentSelection() && !isEditMode()) {
            <div class="form-section">
              <h4 class="section-title">Parent</h4>
              <div class="form-group">
                <label for="parentEpic">Epic *</label>
                <select id="parentEpic" [(ngModel)]="selectedEpicId" name="parentEpic" required>
                  <option value="">Select an epic...</option>
                  @for (epic of epics(); track epic.id) {
                    <option [value]="epic.id">{{ epic.title }}</option>
                  }
                </select>
              </div>
            </div>
          }
          @if (itemType() === 'story' && needsParentSelection() && !isEditMode()) {
            <div class="form-section">
              <h4 class="section-title">Parent</h4>
              <div class="form-group">
                <label for="parentFeature">Feature *</label>
                <select id="parentFeature" [(ngModel)]="selectedFeatureId" name="parentFeature" required>
                  <option value="">Select a feature...</option>
                  @for (f of features(); track f.id) {
                    <option [value]="f.id">{{ f.epicTitle }} › {{ f.title }}</option>
                  }
                </select>
              </div>
            </div>
          }

          <div class="form-section">
            <h4 class="section-title">Details</h4>
            <div class="form-group">
              <label for="title">Title *</label>
              <input id="title" type="text" [(ngModel)]="title" name="title" required [placeholder]="itemType() === 'story' ? 'e.g. As a user, I want to...' : itemType() === 'feature' ? 'e.g. User authentication' : 'e.g. Core platform capabilities'" />
            </div>
            <div class="form-group">
              <div class="label-row">
                <label for="description">Description</label>
                @if (aiConfigService.isConfigured()) {
                  <button type="button" class="ai-suggest-btn" (click)="suggestDescription()" [disabled]="suggestingDescription || !title.trim()">
                    @if (suggestingDescription) {
                      <span class="ai-spinner"></span>
                      <span>Generating...</span>
                    } @else {
                      <svg class="ai-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M12 2l2.09 6.26L20.18 10l-6.09 1.74L12 18l-2.09-6.26L3.82 10l6.09-1.74L12 2z"/>
                        <path d="M5 3l.88 2.65L8.52 6.5 5.88 7.38 5 10l-.88-2.62L1.48 6.5l2.64-.85L5 3z" opacity="0.6"/>
                      </svg>
                      <span>Suggest with AI</span>
                    }
                  </button>
                }
              </div>
              <textarea id="description" [(ngModel)]="description" name="description" rows="6" [placeholder]="itemType() === 'story' ? 'Describe the user need and context...' : 'Provide context and scope...'" [class.ai-updated]="descriptionAiUpdated"></textarea>
              @if (aiError) {
                <p class="ai-error">{{ aiError }}</p>
              }
            </div>
          </div>

          @if (itemType() === 'story') {
            <div class="form-layout-story">
              <div class="form-section form-section-main">
                <div class="label-row">
                  <h4 class="section-title" style="margin-bottom:0">Acceptance Criteria</h4>
                  @if (aiConfigService.isConfigured()) {
                    <button type="button" class="ai-suggest-btn" (click)="suggestAcceptanceCriteria()" [disabled]="suggestingAcceptanceCriteria || !title.trim()">
                      @if (suggestingAcceptanceCriteria) {
                        <span class="ai-spinner"></span>
                        <span>Generating...</span>
                      } @else {
                        <svg class="ai-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                          <path d="M12 2l2.09 6.26L20.18 10l-6.09 1.74L12 18l-2.09-6.26L3.82 10l6.09-1.74L12 2z"/>
                          <path d="M5 3l.88 2.65L8.52 6.5 5.88 7.38 5 10l-.88-2.62L1.48 6.5l2.64-.85L5 3z" opacity="0.6"/>
                        </svg>
                        <span>Suggest with AI</span>
                      }
                    </button>
                  }
                </div>
                <p class="field-hint">Define what must be true for this story to be considered done. Given/When/Then format.</p>
                @if (editingAC || !acceptanceCriteria.trim()) {
                  <div class="form-group">
                    <textarea id="acceptanceCriteria" [(ngModel)]="acceptanceCriteria" name="acceptanceCriteria" rows="8" placeholder="- Given I am a user, When I log in with valid credentials, Then I am redirected to the dashboard&#10;- Given I enter invalid credentials, When I submit the form, Then an error message is displayed&#10;- Given I am logged in, When I refresh the page, Then my session persists" [class.ai-updated]="acAiUpdated"></textarea>
                    @if (acceptanceCriteria.trim()) {
                      <button type="button" class="ac-toggle-btn" (click)="editingAC = false">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>
                        Done editing
                      </button>
                    }
                  </div>
                } @else {
                  <div class="ac-rendered" [class.ai-updated]="acAiUpdated">
                    @for (criterion of parsedCriteria(); track $index) {
                      <div class="ac-card">
                        <span class="ac-number">{{ $index + 1 }}</span>
                        <div class="ac-content">
                          @if (criterion.given) {
                            <div class="ac-part"><span class="ac-keyword given">Given</span> {{ criterion.given }}</div>
                          }
                          @if (criterion.when) {
                            <div class="ac-part"><span class="ac-keyword when">When</span> {{ criterion.when }}</div>
                          }
                          @if (criterion.then) {
                            <div class="ac-part"><span class="ac-keyword then">Then</span> {{ criterion.then }}</div>
                          }
                          @if (!criterion.given && !criterion.when && !criterion.then) {
                            <div class="ac-part ac-plain">{{ criterion.raw }}</div>
                          }
                        </div>
                      </div>
                    }
                    <button type="button" class="ac-toggle-btn" (click)="editingAC = true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      Edit criteria
                    </button>
                  </div>
                }
                @if (hasStoryWarning()) {
                  <div class="form-warning">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                      <line x1="12" y1="9" x2="12" y2="13"/>
                      <line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                    <span>{{ getStoryWarningMessage() }}</span>
                  </div>
                }
              </div>
              <div class="form-section form-section-sidebar">
                <h4 class="section-title">Story Points</h4>
                <div class="story-points-row">
                  <div class="story-points-grid">
                    @for (pts of [1, 2, 3, 5, 8]; track pts) {
                      <button type="button" class="story-point-btn" [class.selected]="storyPoints === pts" (click)="storyPoints = storyPoints === pts ? null : pts">
                        {{ pts }}
                      </button>
                    }
                  </div>
                  <button type="button" class="story-point-clear" (click)="storyPoints = null" [class.active]="storyPoints == null">
                    Clear
                  </button>
                </div>
              </div>
            </div>
          }

        </form>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" (click)="cancel.emit()">Cancel</button>
          <button type="button" class="btn-primary" [disabled]="!canSubmit()" (click)="onSubmit()">
            {{ isEditMode() ? 'Save changes' : 'Add ' + typeLabel() }}
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 1.5rem;
    }
    .modal-box {
      background: var(--surface-elevated, #1e1e2e);
      border-radius: 12px;
      min-width: 560px;
      max-width: 720px;
      width: 100%;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 24px 48px rgba(0, 0, 0, 0.4);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border-default, rgba(255,255,255,0.08));
      flex-shrink: 0;
    }
    .modal-header-left {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .type-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 0.9rem;
      flex-shrink: 0;
    }
    .type-badge.epic {
      background: rgba(139, 92, 246, 0.2);
      color: #a78bfa;
    }
    .type-badge.feature {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
    }
    .type-badge.story {
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
    }
    .modal-header h3 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
    }
    .close-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      color: var(--text-muted, #94a3b8);
      cursor: pointer;
      padding: 0.35rem;
      border-radius: 6px;
    }
    .close-btn:hover {
      background: var(--surface-hover, rgba(255,255,255,0.06));
      color: var(--text-primary);
    }
    .modal-body {
      padding: 1.5rem;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    .form-section {
      margin-bottom: 1.5rem;
    }
    .form-section:last-of-type {
      margin-bottom: 0;
    }
    .section-title {
      margin: 0 0 0.75rem;
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted, #94a3b8);
    }
    .field-hint {
      margin: -0.35rem 0 0.5rem;
      font-size: 0.8rem;
      color: var(--text-muted, #64748b);
    }
    .form-group {
      margin-bottom: 1rem;
    }
    .form-group:last-child {
      margin-bottom: 0;
    }
    .form-group label {
      display: block;
      font-size: 0.9rem;
      font-weight: 500;
      margin-bottom: 0.4rem;
      color: var(--text-secondary);
    }
    .form-group input,
    .form-group textarea,
    .form-group select {
      width: 100%;
      padding: 0.6rem 0.85rem;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      border-radius: 8px;
      background: var(--bg-primary, rgba(0,0,0,0.2));
      color: var(--text-primary);
      font-size: 0.95rem;
      transition: border-color 0.15s;
    }
    .form-group input:focus,
    .form-group textarea:focus,
    .form-group select:focus {
      outline: none;
      border-color: var(--brand-primary, #6366f1);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }
    .form-group textarea {
      resize: vertical;
      min-height: 120px;
    }
    .form-group textarea#acceptanceCriteria {
      min-height: 160px;
    }
    .form-layout-story {
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .form-section-main {
      min-width: 0;
    }
    .form-section-sidebar {
      background: var(--surface-card, rgba(255,255,255,0.03));
      border-radius: 10px;
      padding: 1rem 1.25rem;
    }
    .story-points-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .story-points-grid {
      display: flex;
      gap: 0.4rem;
      flex-shrink: 0;
    }
    .story-point-btn {
      width: 38px;
      height: 38px;
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      border-radius: 8px;
      background: var(--bg-primary, rgba(0,0,0,0.2));
      color: var(--text-secondary);
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      flex-shrink: 0;
    }
    .story-point-btn:hover {
      border-color: rgba(59, 130, 246, 0.5);
      color: #60a5fa;
    }
    .story-point-btn.selected {
      border-color: #3b82f6;
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
    }
    .story-point-clear {
      display: inline-flex;
      padding: 0.35rem 0.6rem;
      border: none;
      background: none;
      color: var(--text-muted);
      font-size: 0.8rem;
      cursor: pointer;
      border-radius: 4px;
      white-space: nowrap;
      margin-left: 0.25rem;
    }
    .story-point-clear:hover,
    .story-point-clear.active {
      color: var(--text-secondary);
    }
    /* AI suggest button styles */
    .label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.4rem;
    }
    .label-row label {
      margin-bottom: 0 !important;
    }
    .ai-suggest-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.3rem 0.65rem;
      border: 1px solid rgba(139, 92, 246, 0.35);
      border-radius: 6px;
      background: rgba(139, 92, 246, 0.1);
      color: #a78bfa;
      font-size: 0.78rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .ai-suggest-btn:hover:not(:disabled) {
      background: rgba(139, 92, 246, 0.2);
      border-color: rgba(139, 92, 246, 0.6);
      color: #c4b5fd;
    }
    .ai-suggest-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .ai-icon {
      flex-shrink: 0;
    }
    .ai-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(139, 92, 246, 0.3);
      border-top-color: #a78bfa;
      border-radius: 50%;
      animation: ai-spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    @keyframes ai-spin {
      to { transform: rotate(360deg); }
    }
    .ai-error {
      margin: 0.35rem 0 0;
      font-size: 0.8rem;
      color: #ef4444;
    }
    .ai-updated {
      border-color: rgba(139, 92, 246, 0.5) !important;
      animation: ai-glow 1.5s ease-out;
    }
    @keyframes ai-glow {
      0% { box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.3); }
      100% { box-shadow: 0 0 0 0px rgba(139, 92, 246, 0); }
    }
    /* Rendered acceptance criteria */
    .ac-rendered {
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      border-radius: 8px;
      background: var(--bg-primary, rgba(0,0,0,0.2));
      padding: 0.5rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      transition: border-color 0.15s;
    }
    .ac-card {
      display: flex;
      gap: 0.6rem;
      padding: 0.6rem 0.75rem;
      background: var(--surface-card, rgba(255,255,255,0.04));
      border-radius: 6px;
      border-left: 3px solid rgba(99, 102, 241, 0.5);
    }
    .ac-number {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: rgba(99, 102, 241, 0.15);
      color: #818cf8;
      font-size: 0.72rem;
      font-weight: 700;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .ac-content {
      flex: 1;
      min-width: 0;
    }
    .ac-part {
      font-size: 0.88rem;
      color: var(--text-primary);
      line-height: 1.45;
      margin-bottom: 0.15rem;
    }
    .ac-part:last-child {
      margin-bottom: 0;
    }
    .ac-plain {
      color: var(--text-secondary);
    }
    .ac-keyword {
      display: inline-block;
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 0.1rem 0.4rem;
      border-radius: 3px;
      margin-right: 0.35rem;
      vertical-align: middle;
    }
    .ac-keyword.given {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
    }
    .ac-keyword.when {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
    }
    .ac-keyword.then {
      background: rgba(34, 197, 94, 0.15);
      color: #4ade80;
    }
    .ac-toggle-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.35rem 0.65rem;
      margin-top: 0.4rem;
      border: none;
      background: none;
      color: var(--text-muted, #94a3b8);
      font-size: 0.8rem;
      cursor: pointer;
      border-radius: 4px;
      align-self: flex-start;
    }
    .ac-toggle-btn:hover {
      color: var(--text-secondary);
      background: var(--surface-hover, rgba(255,255,255,0.06));
    }
    .ac-toggle-btn svg {
      flex-shrink: 0;
    }
    .form-warning {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.4);
      border-radius: 8px;
      color: #f59e0b;
      font-size: 0.85rem;
      margin-top: 1rem;
    }
    .form-warning svg {
      flex-shrink: 0;
    }
    .modal-actions {
      display: flex;
      gap: 0.75rem;
      justify-content: flex-end;
      padding: 1.25rem 1.5rem;
      border-top: 1px solid var(--border-default, rgba(255,255,255,0.08));
      flex-shrink: 0;
      background: var(--surface-elevated, #1e1e2e);
      border-radius: 0 0 12px 12px;
    }
    .btn-primary {
      padding: 0.6rem 1.25rem;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: white;
      border: none;
      border-radius: 8px;
      font-weight: 500;
      font-size: 0.95rem;
      cursor: pointer;
    }
    .btn-primary:hover:not(:disabled) {
      opacity: 0.95;
    }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-secondary {
      padding: 0.6rem 1.25rem;
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid var(--border-default, rgba(255,255,255,0.12));
      border-radius: 8px;
      font-size: 0.95rem;
      cursor: pointer;
    }
    .btn-secondary:hover {
      background: var(--surface-hover, rgba(255,255,255,0.06));
    }
  `]
})
export class AddBacklogItemModalComponent implements OnInit {
  private backlogService = inject(BacklogService);
  aiConfigService = inject(AIConfigService);

  itemType = input.required<AddItemType>();
  /** Pre-selected parent ID (epicId for feature, featureId for story). When set, no parent picker shown. */
  parentId = input<string | null>(null);
  epics = input<EpicOption[]>([]);
  features = input<FeatureOption[]>([]);
  /** If provided, modal is in edit mode */
  editData = input<EditItemData | null>(null);

  add = output<{
    id?: string; // Present when editing
    title: string;
    description?: string;
    acceptanceCriteria?: string;
    storyPoints?: number;
    parentId?: string; // epicId for feature, featureId for story (when user selected from dropdown)
  }>();
  cancel = output<void>();

  title = '';
  description = '';
  acceptanceCriteria = '';
  storyPoints: number | null = null;
  selectedEpicId = '';
  selectedFeatureId = '';

  // AI suggest state
  suggestingDescription = false;
  suggestingAcceptanceCriteria = false;
  aiError = '';
  descriptionAiUpdated = false;
  acAiUpdated = false;

  // Acceptance criteria display mode
  editingAC = false;

  ngOnInit(): void {
    // Initialize with edit data if provided
    const data = this.editData();
    if (data) {
      this.title = data.title;
      this.description = data.description || '';
      this.acceptanceCriteria = data.acceptanceCriteria || '';
      this.storyPoints = data.storyPoints ?? null;
    }
  }

  isEditMode(): boolean {
    return !!this.editData();
  }

  typeLabel = () => {
    const t = this.itemType();
    return t === 'epic' ? 'Epic' : t === 'feature' ? 'Feature' : 'User Story';
  };

  needsParentSelection(): boolean {
    return !this.parentId();
  }

  canSubmit(): boolean {
    if (!this.title.trim()) return false;
    if (!this.isEditMode()) {
      if (this.itemType() === 'feature' && this.needsParentSelection() && !this.selectedEpicId) return false;
      if (this.itemType() === 'story' && this.needsParentSelection() && !this.selectedFeatureId) return false;
    }
    return true;
  }

  hasStoryWarning(): boolean {
    if (this.itemType() !== 'story') return false;
    const hasAc = this.acceptanceCriteria != null && String(this.acceptanceCriteria).trim().length > 0;
    const hasPoints = this.storyPoints != null && this.storyPoints > 0;
    return !hasAc || !hasPoints;
  }

  getStoryWarningMessage(): string {
    if (!this.hasStoryWarning()) return '';
    const missing: string[] = [];
    const hasAc = this.acceptanceCriteria != null && String(this.acceptanceCriteria).trim().length > 0;
    const hasPoints = this.storyPoints != null && this.storyPoints > 0;
    if (!hasAc) missing.push('acceptance criteria');
    if (!hasPoints) missing.push('story points');
    return `Consider adding ${missing.join(' and ')} for better tracking.`;
  }

  parsedCriteria(): { given: string; when: string; then: string; raw: string }[] {
    if (!this.acceptanceCriteria?.trim()) return [];
    return this.acceptanceCriteria
      .split('\n')
      .map(line => line.replace(/^[-•*]\s*/, '').trim())
      .filter(line => line.length > 0)
      .map(line => {
        const givenMatch = line.match(/^Given\s+(.+?)(?:,\s*When\s+|$)/i);
        const whenMatch = line.match(/When\s+(.+?)(?:,\s*Then\s+|$)/i);
        const thenMatch = line.match(/Then\s+(.+)$/i);
        return {
          given: givenMatch?.[1]?.trim() || '',
          when: whenMatch?.[1]?.trim() || '',
          then: thenMatch?.[1]?.trim() || '',
          raw: line
        };
      });
  }

  suggestDescription(): void {
    if (this.suggestingDescription || !this.title.trim()) return;
    this.suggestingDescription = true;
    this.aiError = '';
    this.descriptionAiUpdated = false;

    this.backlogService.suggestWithAI(
      'description',
      this.itemType(),
      this.title.trim(),
      this.description.trim() || undefined
    ).subscribe({
      next: (res) => {
        this.description = res.suggestion;
        this.suggestingDescription = false;
        this.descriptionAiUpdated = true;
        setTimeout(() => this.descriptionAiUpdated = false, 1500);
      },
      error: (err) => {
        this.suggestingDescription = false;
        this.aiError = err?.error?.error || 'AI suggestion failed. Please try again.';
        setTimeout(() => this.aiError = '', 5000);
      }
    });
  }

  suggestAcceptanceCriteria(): void {
    if (this.suggestingAcceptanceCriteria || !this.title.trim()) return;
    this.suggestingAcceptanceCriteria = true;
    this.aiError = '';
    this.acAiUpdated = false;

    this.backlogService.suggestWithAI(
      'acceptanceCriteria',
      this.itemType(),
      this.title.trim(),
      this.acceptanceCriteria.trim() || undefined,
      this.description.trim() || undefined
    ).subscribe({
      next: (res) => {
        this.acceptanceCriteria = res.suggestion;
        this.suggestingAcceptanceCriteria = false;
        this.editingAC = false; // Switch to rendered view
        this.acAiUpdated = true;
        setTimeout(() => this.acAiUpdated = false, 1500);
      },
      error: (err) => {
        this.suggestingAcceptanceCriteria = false;
        this.aiError = err?.error?.error || 'AI suggestion failed. Please try again.';
        setTimeout(() => this.aiError = '', 5000);
      }
    });
  }

  onSubmit(): void {
    if (!this.canSubmit()) return;
    
    const editDataValue = this.editData();
    const parentId = this.parentId()
      ?? (this.itemType() === 'feature' ? this.selectedEpicId || undefined : undefined)
      ?? (this.itemType() === 'story' ? this.selectedFeatureId || undefined : undefined);
    
    this.add.emit({
      ...(editDataValue && { id: editDataValue.id }),
      title: this.title.trim(),
      description: this.description.trim() || undefined,
      acceptanceCriteria: this.acceptanceCriteria.trim() || undefined,
      storyPoints: this.storyPoints ?? undefined,
      ...(!editDataValue && parentId && { parentId })
    });
    
    this.resetForm();
  }

  private resetForm(): void {
    this.title = '';
    this.description = '';
    this.acceptanceCriteria = '';
    this.storyPoints = null;
    this.selectedEpicId = '';
    this.selectedFeatureId = '';
  }
}
