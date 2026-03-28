import { Injectable, signal, computed, inject } from '@angular/core';
import { AuthService, AiSettings, AiSettingsFull, LlmSettingDto } from './auth.service';
import { McpConfigService, McpServerDto } from './mcp-config.service';
import { firstValueFrom } from 'rxjs';

export interface AIProviderConfig {
  provider: 'openai' | 'anthropic' | 'ollama' | 'custom';
  apiKey: string;
  model: string;
  baseUrl?: string;
}

const DEFAULT_CONFIG: AIProviderConfig = {
  provider: 'openai',
  apiKey: '',
  model: 'gpt-4o',
};

/**
 * Service for managing AI configuration (OpenAI, Anthropic, etc.)
 * Configuration is stored in the database and fetched via API
 */
@Injectable({
  providedIn: 'root'
})
export class AIConfigService {
  private authService = inject(AuthService);
  
  // Local cache of the config (updated from API)
  private configSignal = signal<AIProviderConfig>(DEFAULT_CONFIG);
  private loadedSignal = signal<boolean>(false);
  private githubTokenSignal = signal<string>('');
  private llmSettingsSignal = signal<LlmSettingDto[]>([]);

  /** Current AI configuration (default effective config when no repo context) */
  config = this.configSignal.asReadonly();

  /** User's LLM configurations (for settings UI and repo override dropdown) */
  llmSettings = this.llmSettingsSignal.asReadonly();

  /** Check if AI is configured */
  isConfigured = computed(() => {
    const cfg = this.configSignal();
    return cfg.apiKey.trim() !== '';
  });

  /** Get the default provider config */
  defaultProvider = computed(() => this.configSignal());

  /** Check if config has been loaded from server */
  isLoaded = this.loadedSignal.asReadonly();

  constructor() {
    // Load GitHub token from localStorage (for manual PAT entry in AI settings)
    const storedGithubToken = localStorage.getItem('devpilot_github_token');
    if (storedGithubToken) {
      this.githubTokenSignal.set(storedGithubToken);
    }
    
    // Load config from server on init
    this.loadFromServer();
  }

  /**
   * Load configuration from server (default effective config, no repo).
   * Also loads the list of LLM settings.
   */
  async loadFromServer(): Promise<void> {
    try {
      await this.loadLlmSettings();
      // First get the basic settings to check if configured
      const settings = await firstValueFrom(this.authService.getAiSettings());
      
      if (settings.hasApiKey) {
        // Get full settings including API key (default effective = no repositoryId)
        const fullSettings = await firstValueFrom(this.authService.getFullAiSettings());
        this.configSignal.set(this.fullSettingsToConfig(fullSettings));
      } else {
        // Set provider and model without API key
        this.configSignal.set({
          provider: (settings.provider as AIProviderConfig['provider']) || 'openai',
          apiKey: '',
          model: settings.model || 'gpt-4o',
          baseUrl: settings.baseUrl
        });
      }
      
      this.loadedSignal.set(true);
    } catch (e) {
      console.error('Failed to load AI config from server:', e);
      this.loadedSignal.set(true); // Mark as loaded even on error
    }
  }

  /**
   * Load the list of user LLM settings (for settings UI and repo override dropdown).
   */
  async loadLlmSettings(): Promise<void> {
    try {
      const list = await firstValueFrom(this.authService.getLlmSettings());
      this.llmSettingsSignal.set(list ?? []);
    } catch (e) {
      console.error('Failed to load LLM settings:', e);
      this.llmSettingsSignal.set([]);
    }
  }

  /**
   * Get effective AI config for a repository (or default if no repositoryId).
   * Use this when operating in repo context (e.g. backlog, code analysis).
   */
  async getEffectiveConfig(repositoryId?: string): Promise<AIProviderConfig> {
    const full = await firstValueFrom(this.authService.getFullAiSettings(repositoryId));
    return this.fullSettingsToConfig(full);
  }

  private fullSettingsToConfig(full: AiSettingsFull): AIProviderConfig {
    return {
      provider: (full.provider as AIProviderConfig['provider']) || 'openai',
      apiKey: full.apiKey ?? '',
      model: full.model || 'gpt-4o',
      baseUrl: full.baseUrl
    };
  }

  /**
   * Update the default provider configuration (local only).
   * To add or change AI providers, use Settings > AI providers.
   */
  async updateDefaultProvider(config: Partial<AIProviderConfig>): Promise<void> {
    const current = this.configSignal();
    this.configSignal.set({ ...current, ...config });
  }

  /**
   * Get GitHub token for cloning private repos
   */
  getGithubToken(): string {
    return this.githubTokenSignal();
  }

  /**
   * Set GitHub token (stored locally, not in database)
   */
  setGithubToken(token: string): void {
    this.githubTokenSignal.set(token);
    // Store in localStorage for persistence
    if (token) {
      localStorage.setItem('devpilot_github_token', token);
    } else {
      localStorage.removeItem('devpilot_github_token');
    }
  }

  /**
   * Get configuration for sandbox environment
   */
  getSandboxEnvConfig(): Record<string, string> {
    const cfg = this.configSignal();
    const env: Record<string, string> = {};

    if (cfg.apiKey) {
      switch (cfg.provider) {
        case 'openai':
          env['OPENAI_API_KEY'] = cfg.apiKey;
          env['ZED_AI_PROVIDER'] = 'openai';
          env['ZED_AI_MODEL'] = cfg.model || 'gpt-4o';
          break;
        case 'anthropic':
          env['ANTHROPIC_API_KEY'] = cfg.apiKey;
          env['ZED_AI_PROVIDER'] = 'anthropic';
          env['ZED_AI_MODEL'] = cfg.model || 'claude-3-5-sonnet-20241022';
          break;
        case 'ollama':
          env['OLLAMA_BASE_URL'] = cfg.baseUrl || 'http://localhost:11434';
          env['ZED_AI_PROVIDER'] = 'ollama';
          env['ZED_AI_MODEL'] = cfg.model || 'llama3.1';
          break;
        case 'custom':
          env['CUSTOM_AI_API_KEY'] = cfg.apiKey;
          env['CUSTOM_AI_BASE_URL'] = cfg.baseUrl || '';
          env['ZED_AI_PROVIDER'] = 'custom';
          env['ZED_AI_MODEL'] = cfg.model;
          break;
      }
    }

    return env;
  }

  /**
   * Get Zed settings.json content for AI configuration.
   * @param config Optional config to use (e.g. effective config for a repo); otherwise uses default.
   * @param mcpServers Optional list of enabled MCP servers to inject as Zed context_servers.
   */
  getZedSettingsJson(config?: AIProviderConfig, mcpServers?: McpServerDto[]): object {
    const cfg = config ?? this.configSignal();
    
    const zedProvider = cfg.provider === 'custom' ? 'openai' : cfg.provider;
    const model = cfg.model || 'gpt-4o';
    
    const settings: any = {
      "theme": "One Dark",
      "ui_font_size": 14,
      "buffer_font_size": 14,
      
      "agent": {
        "enabled": true,
        "default_model": {
          "provider": zedProvider,
          "model": model
        },
        "always_allow_tool_actions": true
      },
      
      "features": {
        "edit_prediction_provider": "zed"
      },
      
      "terminal": {
        "dock": "bottom",
        "env": {
          "LIBGL_ALWAYS_SOFTWARE": "1"
        }
      },
      
      "worktree": {
        "trust_by_default": true
      },

      "telemetry": {
        "diagnostics": false,
        "metrics": false
      },

      "workspace": {
        "title_bar": {
          "show_onboarding_banner": false
        }
      },

      "show_call_status_icon": false
    };

    if (cfg.provider === 'ollama') {
      settings.language_models = {
        "ollama": {
          "api_url": cfg.baseUrl || "http://localhost:11434"
        }
      };
    } else {
      settings.language_models = {
        "openai": {
          "api_url": "http://localhost:8091/v1",
          "available_models": [
            {
              "name": model,
              "display_name": model,
              "max_tokens": 128000
            }
          ]
        }
      };
    }

    if (mcpServers?.length) {
      settings.context_servers = {} as Record<string, any>;
      for (const mcp of mcpServers) {
        if (mcp.serverType === 'remote') {
          const entry: any = { url: mcp.url };
          if (mcp.headers && Object.keys(mcp.headers).length > 0) {
            entry.headers = mcp.headers;
          }
          settings.context_servers[mcp.name] = entry;
        } else {
          const entry: any = { command: mcp.command };
          if (mcp.args?.length) {
            entry.args = mcp.args;
          }
          if (mcp.env && Object.keys(mcp.env).length > 0) {
            entry.env = mcp.env;
          }
          settings.context_servers[mcp.name] = entry;
        }
      }
    }

    return settings;
  }

  /**
   * Clear local config (e.g. after logout). To remove AI providers, use Settings > AI providers.
   */
  async clearConfig(): Promise<void> {
    this.configSignal.set(DEFAULT_CONFIG);
  }
}
