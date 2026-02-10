import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'repositories',
    pathMatch: 'full'
  },
  {
    path: 'login',
    loadComponent: () => import('./core/auth/login/login.component').then(m => m.LoginComponent)
  },
  {
    // Generic callback route: /auth/callback/:provider (e.g. /auth/callback/GitHub, /auth/callback/AzureAd)
    path: 'auth/callback/:provider',
    loadComponent: () => import('./core/auth/callback/callback.component').then(m => m.CallbackComponent)
  },
  {
    path: 'repositories',
    loadComponent: () => import('./features/repositories/repositories.component').then(m => m.RepositoriesComponent)
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent)
  },
  {
    path: 'backlog/:repositoryId',
    loadComponent: () => import('./features/backlog/backlog.component').then(m => m.BacklogComponent)
  },
  {
    path: 'code/:repositoryId',
    loadComponent: () => import('./features/code/code.component').then(m => m.CodeComponent)
  }
];
