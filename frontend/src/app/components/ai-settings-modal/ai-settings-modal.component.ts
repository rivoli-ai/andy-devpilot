import { Component, signal, computed, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AIConfigService, AIProviderConfig } from '../../core/services/ai-config.service';

@Component({
  selector: 'app-ai-settings-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="modal-backdrop" (click)="close.emit()"></div>
    <div class="modal-container">
      <div class="modal-header">
        <div class="header-title">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2a4 4 0 014 4c0 1.1-.9 2-2 2h-4a2 2 0 01-2-2 4 4 0 014-4z"/>
            <path d="M12 8v6M9 18h6M12 14v4"/>
          </svg>
          <h2>AI Configuration</h2>
        </div>
        <button class="close-btn" (click)="close.emit()">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="modal-content">
        <!-- Status Banner -->
        <div class="status-banner" [class.configured]="isConfigured()">
          @if (isConfigured()) {
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
            <span>AI is configured and ready</span>
          } @else {
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>Configure your AI provider to enable Zed AI features</span>
          }
        </div>

        <!-- Provider Selection -->
        <div class="form-group">
          <label>Provider</label>
          <div class="provider-grid">
            <button 
              class="provider-btn" 
              [class.active]="provider() === 'openai'"
              (click)="setProvider('openai')">
              <span class="provider-icon">🤖</span>
              <span class="provider-name">OpenAI</span>
            </button>
            <button 
              class="provider-btn" 
              [class.active]="provider() === 'anthropic'"
              (click)="setProvider('anthropic')">
              <span class="provider-icon">🧠</span>
              <span class="provider-name">Anthropic</span>
            </button>
            <button 
              class="provider-btn" 
              [class.active]="provider() === 'ollama'"
              (click)="setProvider('ollama')">
              <span class="provider-icon">🦙</span>
              <span class="provider-name">Ollama</span>
            </button>
            <button 
              class="provider-btn" 
              [class.active]="provider() === 'custom'"
              (click)="setProvider('custom')">
              <span class="provider-icon">⚙️</span>
              <span class="provider-name">Custom</span>
            </button>
          </div>
        </div>

        <!-- API Key -->
        @if (provider() !== 'ollama') {
          <div class="form-group">
            <label for="apiKey">API Key</label>
            <div class="input-wrapper">
              <input 
                [type]="showApiKey() ? 'text' : 'password'"
                id="apiKey"
                [ngModel]="apiKey()"
                (ngModelChange)="apiKey.set($event)"
                placeholder="Enter your API key"
                class="form-input" />
              <button class="toggle-visibility" (click)="showApiKey.set(!showApiKey())">
                @if (showApiKey()) {
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                } @else {
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                }
              </button>
            </div>
            <p class="form-hint">
              @switch (provider()) {
                @case ('openai') { Get your key from <a href="https://platform.openai.com/api-keys" target="_blank">OpenAI Dashboard</a> }
                @case ('anthropic') { Get your key from <a href="https://console.anthropic.com/" target="_blank">Anthropic Console</a> }
                @case ('custom') { Enter your custom provider's API key }
              }
            </p>
          </div>
        }

        <!-- Base URL (for Ollama/Custom) -->
        @if (provider() === 'ollama' || provider() === 'custom') {
          <div class="form-group">
            <label for="baseUrl">Base URL</label>
            <input 
              type="text"
              id="baseUrl"
              [ngModel]="baseUrl()"
              (ngModelChange)="baseUrl.set($event)"
              [placeholder]="provider() === 'ollama' ? 'http://localhost:11434' : 'https://api.example.com'"
              class="form-input" />
            <p class="form-hint">
              @if (provider() === 'ollama') {
                Ollama server URL (default: http://localhost:11434)
              } @else {
                Your custom API endpoint URL
              }
            </p>
          </div>
        }

        <!-- Model Selection -->
        <div class="form-group">
          <label for="model">Model</label>
          @if (provider() === 'openai') {
            <select id="model" [ngModel]="model()" (ngModelChange)="model.set($event)" class="form-select">
              <option value="gpt-4o">GPT-4o (Recommended)</option>
              <option value="gpt-4o-mini">GPT-4o Mini (Faster)</option>
              <option value="gpt-4-turbo">GPT-4 Turbo</option>
              <option value="gpt-4">GPT-4</option>
              <option value="o1-preview">o1-preview (Reasoning)</option>
              <option value="o1-mini">o1-mini</option>
            </select>
          } @else if (provider() === 'anthropic') {
            <select id="model" [ngModel]="model()" (ngModelChange)="model.set($event)" class="form-select">
              <option value="claude-sonnet-4-20250514">Claude Sonnet 4 (Latest)</option>
              <option value="claude-3-5-sonnet-20241022">Claude 3.5 Sonnet</option>
              <option value="claude-3-opus-20240229">Claude 3 Opus</option>
              <option value="claude-3-haiku-20240307">Claude 3 Haiku (Fast)</option>
            </select>
          } @else {
            <input 
              type="text"
              id="model"
              [ngModel]="model()"
              (ngModelChange)="model.set($event)"
              [placeholder]="provider() === 'ollama' ? 'llama3.1' : 'model-name'"
              class="form-input" />
          }
        </div>

        <!-- Divider -->
        <div class="section-divider">
          <span>Repository Access</span>
        </div>

        <!-- GitHub Token -->
        <div class="form-group">
          <label for="githubToken">GitHub Token (for private repos)</label>
          <div class="input-wrapper">
            <input 
              [type]="showGithubToken() ? 'text' : 'password'"
              id="githubToken"
              [ngModel]="githubToken()"
              (ngModelChange)="githubToken.set($event)"
              placeholder="ghp_xxxxxxxxxxxx"
              class="form-input" />
            <button class="toggle-visibility" (click)="showGithubToken.set(!showGithubToken())">
              @if (showGithubToken()) {
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              } @else {
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              }
            </button>
          </div>
          <p class="form-hint">
            Required for cloning private repositories. 
            <a href="https://github.com/settings/tokens/new?scopes=repo" target="_blank">Generate token</a> with "repo" scope.
          </p>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" (click)="close.emit()">Cancel</button>
        <button class="btn btn-primary" (click)="saveConfig()" [disabled]="!canSave()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
            <polyline points="17 21 17 13 7 13 7 21"/>
            <polyline points="7 3 7 8 15 8"/>
          </svg>
          Save Configuration
        </button>
      </div>
    </div>
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      z-index: 1000;
      animation: fadeIn 0.2s ease;
    }

    .modal-container {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 90%;
      max-width: 520px;
      max-height: 90vh;
      background: var(--surface-elevated, #1e1e2e);
      border: 1px solid var(--border-light, rgba(255, 255, 255, 0.1));
      border-radius: 16px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
      z-index: 1001;
      display: flex;
      flex-direction: column;
      animation: slideUp 0.3s ease;
      overflow: hidden;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translate(-50%, -45%); }
      to { opacity: 1; transform: translate(-50%, -50%); }
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-light);
    }

    .header-title {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .header-title svg {
      color: var(--primary, #6366f1);
    }

    .header-title h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .close-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      background: transparent;
      border: none;
      border-radius: 8px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
    }

    .close-btn:hover {
      background: var(--surface-hover, rgba(255, 255, 255, 0.1));
      color: var(--text-primary);
    }

    .modal-content {
      flex: 1;
      padding: 24px;
      overflow-y: auto;
    }

    .status-banner {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.2);
      border-radius: 10px;
      margin-bottom: 24px;
      font-size: 14px;
      color: #f59e0b;
    }

    .status-banner.configured {
      background: rgba(34, 197, 94, 0.1);
      border-color: rgba(34, 197, 94, 0.2);
      color: #22c55e;
    }

    .form-group {
      margin-bottom: 20px;
    }

    .form-group label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .provider-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }

    .provider-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 14px 8px;
      background: var(--surface-ground, #0f0f1a);
      border: 2px solid transparent;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .provider-btn:hover {
      background: var(--surface-hover, rgba(255, 255, 255, 0.05));
      border-color: var(--border-light);
    }

    .provider-btn.active {
      background: rgba(99, 102, 241, 0.1);
      border-color: var(--primary, #6366f1);
    }

    .provider-icon {
      font-size: 24px;
    }

    .provider-name {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .provider-btn.active .provider-name {
      color: var(--primary, #6366f1);
    }

    .input-wrapper {
      position: relative;
    }

    .form-input, .form-select {
      width: 100%;
      padding: 12px 16px;
      background: var(--surface-ground, #0f0f1a);
      border: 1px solid var(--border-light);
      border-radius: 10px;
      font-size: 14px;
      color: var(--text-primary);
      transition: all 0.2s;
      box-sizing: border-box;
    }

    .input-wrapper .form-input {
      padding-right: 48px;
    }

    .form-input:focus, .form-select:focus {
      outline: none;
      border-color: var(--primary, #6366f1);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    }

    .form-input::placeholder {
      color: var(--text-tertiary);
    }

    .form-select {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      padding-right: 40px;
    }

    .toggle-visibility {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      background: transparent;
      border: none;
      color: var(--text-tertiary);
      cursor: pointer;
      padding: 4px;
    }

    .toggle-visibility:hover {
      color: var(--text-primary);
    }

    .form-hint {
      margin: 8px 0 0;
      font-size: 12px;
      color: var(--text-tertiary);
    }

    .form-hint a {
      color: var(--primary, #6366f1);
      text-decoration: none;
    }

    .form-hint a:hover {
      text-decoration: underline;
    }

    .section-divider {
      display: flex;
      align-items: center;
      margin: 24px 0 16px;
      gap: 12px;
    }

    .section-divider::before,
    .section-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border-light);
    }

    .section-divider span {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding: 16px 24px;
      border-top: 1px solid var(--border-light);
    }

    .btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-secondary {
      background: transparent;
      border: 1px solid var(--border-light);
      color: var(--text-secondary);
    }

    .btn-secondary:hover {
      background: var(--surface-hover);
      color: var(--text-primary);
    }

    .btn-primary {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      border: none;
      color: white;
    }

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
    }

    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Light mode */
    :host-context([data-theme="light"]) .modal-container {
      background: var(--surface-card, #ffffff);
    }

    :host-context([data-theme="light"]) .provider-btn,
    :host-context([data-theme="light"]) .form-input,
    :host-context([data-theme="light"]) .form-select {
      background: var(--surface-ground, #f3f4f6);
    }

    @media (max-width: 480px) {
      .provider-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }
  `]
})
export class AISettingsModalComponent implements OnInit {
  @Output() close = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  provider = signal<'openai' | 'anthropic' | 'ollama' | 'custom'>('openai');
  apiKey = signal<string>('');
  model = signal<string>('gpt-4o');
  baseUrl = signal<string>('');
  showApiKey = signal<boolean>(false);
  githubToken = signal<string>('');
  showGithubToken = signal<boolean>(false);

  constructor(private aiConfigService: AIConfigService) {}

  ngOnInit(): void {
    // Load existing config
    const config = this.aiConfigService.defaultProvider();
    this.provider.set(config.provider);
    this.apiKey.set(config.apiKey);
    this.model.set(config.model);
    this.baseUrl.set(config.baseUrl || '');
    this.githubToken.set(this.aiConfigService.getGithubToken());
  }

  isConfigured = computed(() => this.aiConfigService.isConfigured());

  canSave = computed(() => {
    const p = this.provider();
    if (p === 'ollama') {
      return this.model().trim() !== '';
    }
    return this.apiKey().trim() !== '' && this.model().trim() !== '';
  });

  setProvider(p: 'openai' | 'anthropic' | 'ollama' | 'custom'): void {
    this.provider.set(p);
    
    // Set default models for each provider
    switch (p) {
      case 'openai':
        this.model.set('gpt-4o');
        break;
      case 'anthropic':
        this.model.set('claude-sonnet-4-20250514');
        break;
      case 'ollama':
        this.model.set('llama3.1');
        this.baseUrl.set('http://localhost:11434');
        break;
      case 'custom':
        this.model.set('');
        break;
    }
  }

  saveConfig(): void {
    this.aiConfigService.updateDefaultProvider({
      provider: this.provider(),
      apiKey: this.apiKey(),
      model: this.model(),
      baseUrl: this.baseUrl() || undefined
    });
    // Save GitHub token separately
    this.aiConfigService.setGithubToken(this.githubToken());
    this.saved.emit();
    this.close.emit();
  }
}
