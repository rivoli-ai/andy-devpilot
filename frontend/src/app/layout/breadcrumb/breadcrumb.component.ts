import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';
import { RepositoryService } from '../../core/services/repository.service';

export interface BreadcrumbSegment {
  label: string;
  link: string[] | null;
}

@Component({
  selector: 'app-breadcrumb',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './breadcrumb.component.html',
  styleUrl: './breadcrumb.component.css'
})
export class BreadcrumbComponent {
  private readonly router = inject(Router);
  private readonly repositoryService = inject(RepositoryService);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.router.url),
      startWith(this.router.url)
    ),
    { initialValue: this.router.url }
  );

  private readonly repositories = this.repositoryService.repositories;

  readonly segments = computed(() => {
    const path = this.url().split('?')[0];
    this.repositories();
    return this.buildSegments(path);
  });

  private buildSegments(path: string): BreadcrumbSegment[] {
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'login' || parts[0] === 'auth') {
      return [];
    }

    if (parts.length === 0 || (parts[0] === 'repositories' && parts.length === 1)) {
      return [{ label: 'Repositories', link: null }];
    }

    // Settings is a top-level area (sidebar sibling of Repositories), not a child route.
    if (parts[0] === 'settings' && parts.length === 1) {
      return [{ label: 'Settings', link: null }];
    }

    if (parts[0] === 'backlog' && parts[1]) {
      const repoId = parts[1];
      const name = this.repoLabel(repoId);
      return [
        { label: 'Repositories', link: ['/repositories'] },
        { label: name, link: null },
        { label: 'Backlog', link: null }
      ];
    }

    if (parts[0] === 'code' && parts[1]) {
      const repoId = parts[1];
      const name = this.repoLabel(repoId);
      return [
        { label: 'Repositories', link: ['/repositories'] },
        { label: name, link: null },
        { label: 'Code', link: null }
      ];
    }

    return [{ label: 'Repositories', link: ['/repositories'] }];
  }

  private repoLabel(repositoryId: string): string {
    const repo = this.repositoryService.getRepositoryById(repositoryId);
    if (repo) {
      return repo.fullName || repo.name;
    }
    const id = String(repositoryId);
    if (id.length > 10) {
      return `Repository ${id.slice(0, 8)}…`;
    }
    return id || 'Repository';
  }
}
