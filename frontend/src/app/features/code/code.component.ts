import { Component, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { 
  RepositoryService, 
  RepositoryTree, 
  RepositoryTreeItem, 
  RepositoryFileContent,
  RepositoryBranch,
  PullRequest
} from '../../core/services/repository.service';
import { Repository } from '../../shared/models/repository.model';
import { CodeHighlightPipe } from '../../shared/pipes/code-highlight.pipe';

// Extended tree item with children and state
export interface TreeNode extends RepositoryTreeItem {
  children?: TreeNode[];
  isExpanded?: boolean;
  isLoading?: boolean;
  depth: number;
}

export type TabType = 'code' | 'pullRequests';

/**
 * Code browser component - VS Code-like file explorer
 * Displays repository files as expandable tree
 */
@Component({
  selector: 'app-code',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, CodeHighlightPipe],
  templateUrl: './code.component.html',
  styleUrl: './code.component.css'
})
export class CodeComponent implements OnInit {
  // State signals
  repository = signal<Repository | null>(null);
  repositoryId = signal<string>('');
  currentBranch = signal<string>('');
  branches = signal<RepositoryBranch[]>([]);
  treeNodes = signal<TreeNode[]>([]);
  selectedFile = signal<RepositoryFileContent | null>(null);
  selectedFilePath = signal<string | null>(null);
  loading = signal<boolean>(false);
  fileLoading = signal<boolean>(false);
  error = signal<string | null>(null);
  showBranchDropdown = signal<boolean>(false);
  
  // Tab and PR state
  activeTab = signal<TabType>('code');
  pullRequests = signal<PullRequest[]>([]);
  prLoading = signal<boolean>(false);
  prFilter = signal<'all' | 'open' | 'closed'>('open');

  // Computed: flattened tree for display
  flattenedTree = computed(() => {
    const result: TreeNode[] = [];
    const flatten = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (node.isExpanded && node.children) {
          flatten(node.children);
        }
      }
    };
    flatten(this.treeNodes());
    return result;
  });

  fileLines = computed(() => {
    const file = this.selectedFile();
    if (!file || file.isBinary) return [];
    return file.content.split('\n');
  });

  /** Lines with index for @for track (track by index) */
  fileLinesWithIndex = computed(() => {
    const lines = this.fileLines();
    return lines.map((line, index) => ({ line, index }));
  });

  /** Language for syntax highlighting (from file.language or file extension) */
  fileLanguage = computed(() => {
    const file = this.selectedFile();
    if (!file) return null;
    if (file.language) return file.language;
    const name = file.name || '';
    const dot = name.lastIndexOf('.');
    if (dot >= 0) return name.slice(dot + 1);
    if (name.toLowerCase() === 'dockerfile') return 'dockerfile';
    return null;
  });

  // PR computed values
  filteredPullRequests = computed(() => {
    const prs = this.pullRequests();
    const filter = this.prFilter();
    if (filter === 'all') return prs;
    if (filter === 'open') return prs.filter(pr => pr.state === 'open');
    return prs.filter(pr => pr.state === 'closed' || pr.state === 'merged');
  });

  openPrCount = computed(() => this.pullRequests().filter(pr => pr.state === 'open').length);
  closedPrCount = computed(() => this.pullRequests().filter(pr => pr.state !== 'open').length);

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private repositoryService: RepositoryService
  ) {}

  ngOnInit(): void {
    const repoId = this.route.snapshot.paramMap.get('repositoryId');
    if (repoId) {
      this.repositoryId.set(repoId);
      this.loadRepository(repoId);
    } else {
      this.error.set('Repository ID is required');
    }
  }

  private async loadRepository(repositoryId: string): Promise<void> {
    let repo = this.repositoryService.getRepositoryById(repositoryId);
    
    if (!repo) {
      this.repositoryService.getRepositories().subscribe({
        next: () => {
          repo = this.repositoryService.getRepositoryById(repositoryId);
          if (repo) {
            this.repository.set(repo);
            this.loadBranchesAndTree(repositoryId);
          } else {
            this.error.set('Repository not found');
          }
        },
        error: (err) => {
          this.error.set(err.message || 'Failed to load repository');
        }
      });
    } else {
      this.repository.set(repo);
      this.loadBranchesAndTree(repositoryId);
    }
  }

  private loadBranchesAndTree(repositoryId: string): void {
    this.loading.set(true);
    this.error.set(null);

    this.repositoryService.getBranches(repositoryId).subscribe({
      next: (branches) => {
        this.branches.set(branches);
        const defaultBranch = branches.find(b => b.isDefault)?.name || branches[0]?.name || 'main';
        this.currentBranch.set(defaultBranch);
        this.loadRootTree();
      },
      error: (err) => {
        console.warn('Failed to load branches:', err);
        this.currentBranch.set(this.repository()?.defaultBranch || 'main');
        this.loadRootTree();
      }
    });
  }

  loadRootTree(): void {
    const repoId = this.repositoryId();
    const branch = this.currentBranch();

    this.loading.set(true);

    this.repositoryService.getRepositoryTree(repoId, undefined, branch || undefined).subscribe({
      next: (tree) => {
        const nodes = this.convertToTreeNodes(tree.items, 0);
        this.treeNodes.set(nodes);
        this.loading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to load repository contents');
        this.loading.set(false);
      }
    });
  }

  private convertToTreeNodes(items: RepositoryTreeItem[], depth: number): TreeNode[] {
    return items.map(item => ({
      ...item,
      depth,
      isExpanded: false,
      isLoading: false,
      children: item.type === 'dir' ? undefined : undefined
    }));
  }

  toggleFolder(node: TreeNode): void {
    if (node.type !== 'dir') return;

    if (node.isExpanded) {
      // Collapse
      this.updateNode(node.path, { isExpanded: false });
    } else {
      // Expand - load children if not loaded
      if (!node.children) {
        this.loadFolderContents(node);
      } else {
        this.updateNode(node.path, { isExpanded: true });
      }
    }
  }

  private loadFolderContents(node: TreeNode): void {
    const repoId = this.repositoryId();
    const branch = this.currentBranch();

    this.updateNode(node.path, { isLoading: true });

    this.repositoryService.getRepositoryTree(repoId, node.path, branch || undefined).subscribe({
      next: (tree) => {
        const children = this.convertToTreeNodes(tree.items, node.depth + 1);
        this.updateNode(node.path, { 
          children, 
          isExpanded: true, 
          isLoading: false 
        });
      },
      error: (err) => {
        console.error('Failed to load folder contents:', err);
        this.updateNode(node.path, { isLoading: false });
      }
    });
  }

  private updateNode(path: string, updates: Partial<TreeNode>): void {
    const updateRecursive = (nodes: TreeNode[]): TreeNode[] => {
      return nodes.map(node => {
        if (node.path === path) {
          return { ...node, ...updates };
        }
        if (node.children) {
          return { ...node, children: updateRecursive(node.children) };
        }
        return node;
      });
    };

    this.treeNodes.update(nodes => updateRecursive(nodes));
  }

  onNodeClick(node: TreeNode): void {
    if (node.type === 'dir') {
      this.toggleFolder(node);
    } else if (node.type === 'file') {
      this.loadFileContent(node.path);
    }
  }

  loadFileContent(path: string): void {
    const repoId = this.repositoryId();
    const branch = this.currentBranch();

    this.fileLoading.set(true);
    this.selectedFilePath.set(path);

    this.repositoryService.getFileContent(repoId, path, branch || undefined).subscribe({
      next: (content) => {
        this.selectedFile.set(content);
        this.fileLoading.set(false);
      },
      error: (err) => {
        this.error.set(err.error?.message || err.message || 'Failed to load file content');
        this.fileLoading.set(false);
      }
    });
  }

  closeFile(): void {
    this.selectedFile.set(null);
    this.selectedFilePath.set(null);
  }

  copyFileContent(): void {
    const file = this.selectedFile();
    if (!file || file.isBinary) return;
    navigator.clipboard.writeText(file.content).then(
      () => { /* optional: show toast */ },
      () => { /* fallback or ignore */ }
    );
  }

  toggleBranchDropdown(): void {
    this.showBranchDropdown.update(v => !v);
  }

  selectBranch(branch: RepositoryBranch): void {
    this.currentBranch.set(branch.name);
    this.showBranchDropdown.set(false);
    this.selectedFile.set(null);
    this.selectedFilePath.set(null);
    this.loadRootTree();
  }

  getFileIcon(item: TreeNode | RepositoryTreeItem): string {
    if (item.type === 'dir') {
      return 'folder';
    }
    
    const ext = item.name.split('.').pop()?.toLowerCase() || '';
    const iconMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'py': 'python',
      'java': 'java',
      'cs': 'csharp',
      'go': 'go',
      'rs': 'rust',
      'rb': 'ruby',
      'php': 'php',
      'html': 'html',
      'css': 'css',
      'scss': 'css',
      'json': 'json',
      'xml': 'xml',
      'yaml': 'yaml',
      'yml': 'yaml',
      'md': 'markdown',
      'sql': 'database',
      'sh': 'terminal',
      'dockerfile': 'docker',
      'png': 'image',
      'jpg': 'image',
      'jpeg': 'image',
      'gif': 'image',
      'svg': 'image',
      'pdf': 'pdf',
      'zip': 'archive',
      'tar': 'archive',
      'gz': 'archive',
    };

    return iconMap[ext] || 'file';
  }

  formatFileSize(size?: number): string {
    if (!size) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  goBack(): void {
    this.router.navigate(['/repositories']);
  }

  // Tab methods
  switchTab(tab: TabType): void {
    this.activeTab.set(tab);
    if (tab === 'pullRequests' && this.pullRequests().length === 0) {
      this.loadPullRequests();
    }
  }

  loadPullRequests(): void {
    const repoId = this.repositoryId();
    this.prLoading.set(true);

    this.repositoryService.getPullRequests(repoId, 'all').subscribe({
      next: (prs) => {
        this.pullRequests.set(prs);
        this.prLoading.set(false);
      },
      error: (err) => {
        console.error('Failed to load pull requests:', err);
        this.prLoading.set(false);
      }
    });
  }

  setPrFilter(filter: 'all' | 'open' | 'closed'): void {
    this.prFilter.set(filter);
  }

  getRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);
    const diffWeek = Math.floor(diffDay / 7);
    const diffMonth = Math.floor(diffDay / 30);

    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin} minute${diffMin > 1 ? 's' : ''} ago`;
    if (diffHour < 24) return `${diffHour} hour${diffHour > 1 ? 's' : ''} ago`;
    if (diffDay < 7) return `${diffDay} day${diffDay > 1 ? 's' : ''} ago`;
    if (diffWeek < 4) return `${diffWeek} week${diffWeek > 1 ? 's' : ''} ago`;
    return `${diffMonth} month${diffMonth > 1 ? 's' : ''} ago`;
  }

  openPrUrl(url: string): void {
    window.open(url, '_blank');
  }
}
