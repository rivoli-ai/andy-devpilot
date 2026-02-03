import { Component, input, output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

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
      <div class="modal-box" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h3>{{ isEditMode() ? 'Edit' : 'Add' }} {{ typeLabel() }}</h3>
          <button type="button" class="close-btn" (click)="cancel.emit()">×</button>
        </div>
        <form (ngSubmit)="onSubmit()" class="modal-body">
          @if (itemType() === 'feature' && needsParentSelection() && !isEditMode()) {
            <div class="form-group">
              <label for="parentEpic">Parent Epic *</label>
              <select id="parentEpic" [(ngModel)]="selectedEpicId" name="parentEpic" required>
                <option value="">Select an epic...</option>
                @for (epic of epics(); track epic.id) {
                  <option [value]="epic.id">{{ epic.title }}</option>
                }
              </select>
            </div>
          }
          @if (itemType() === 'story' && needsParentSelection() && !isEditMode()) {
            <div class="form-group">
              <label for="parentFeature">Parent Feature *</label>
              <select id="parentFeature" [(ngModel)]="selectedFeatureId" name="parentFeature" required>
                <option value="">Select a feature...</option>
                @for (f of features(); track f.id) {
                  <option [value]="f.id">{{ f.epicTitle }} › {{ f.title }}</option>
                }
              </select>
            </div>
          }
          <div class="form-group">
            <label for="title">Title *</label>
            <input id="title" type="text" [(ngModel)]="title" name="title" required placeholder="Enter title" />
          </div>
          <div class="form-group">
            <label for="description">Description</label>
            <textarea id="description" [(ngModel)]="description" name="description" rows="3" placeholder="Optional description"></textarea>
          </div>
          @if (itemType() === 'story') {
            <div class="form-group">
              <label for="acceptanceCriteria">Acceptance Criteria</label>
              <textarea id="acceptanceCriteria" [(ngModel)]="acceptanceCriteria" name="acceptanceCriteria" rows="2" placeholder="One per line"></textarea>
            </div>
            <div class="form-group">
              <label for="storyPoints">Story Points</label>
              <select id="storyPoints" [(ngModel)]="storyPoints" name="storyPoints">
                <option [ngValue]="null">-</option>
                <option [ngValue]="1">1</option>
                <option [ngValue]="2">2</option>
                <option [ngValue]="3">3</option>
                <option [ngValue]="5">5</option>
                <option [ngValue]="8">8</option>
              </select>
            </div>
          }
          <div class="modal-actions">
            <button type="button" class="btn-secondary" (click)="cancel.emit()">Cancel</button>
            <button type="submit" class="btn-primary" [disabled]="!canSubmit()">{{ isEditMode() ? 'Save' : 'Add' }} {{ typeLabel() }}</button>
          </div>
        </form>
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
    }
    .modal-box {
      background: var(--surface-elevated, #1e1e2e);
      border-radius: 12px;
      min-width: 400px;
      max-width: 500px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border-default);
    }
    .modal-header h3 {
      margin: 0;
      font-size: 1.1rem;
    }
    .close-btn {
      background: none;
      border: none;
      font-size: 1.5rem;
      color: var(--text-muted);
      cursor: pointer;
    }
    .modal-body {
      padding: 1.25rem;
    }
    .form-group {
      margin-bottom: 1rem;
    }
    .form-group label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      margin-bottom: 0.35rem;
      color: var(--text-secondary);
    }
    .form-group input,
    .form-group textarea,
    .form-group select {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 0.9rem;
    }
    .form-group textarea {
      resize: vertical;
    }
    .modal-actions {
      display: flex;
      gap: 0.75rem;
      justify-content: flex-end;
      margin-top: 1.25rem;
    }
    .btn-primary {
      padding: 0.5rem 1rem;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: white;
      border: none;
      border-radius: 6px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-secondary {
      padding: 0.5rem 1rem;
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      cursor: pointer;
    }
  `]
})
export class AddBacklogItemModalComponent implements OnInit {
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
