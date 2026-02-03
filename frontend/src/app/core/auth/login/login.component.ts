import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { CardComponent } from '../../../shared/components';

/**
 * Login component supporting multiple authentication methods:
 * - Email/Password (login and register)
 * - GitHub OAuth
 * - Microsoft OAuth
 */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, CardComponent],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css'
})
export class LoginComponent implements OnInit {
  // UI State
  loading = signal<boolean>(false);
  error = signal<string | null>(null);
  isRegisterMode = signal<boolean>(false);
  
  // Form fields
  email = '';
  password = '';
  name = '';
  confirmPassword = '';

  constructor(
    private authService: AuthService,
    private router: Router
  ) {}

  ngOnInit(): void {
    // If already authenticated, redirect to repositories
    if (this.authService.isLoggedIn()) {
      this.router.navigate(['/repositories']);
    }
  }

  toggleMode(): void {
    this.isRegisterMode.update(value => !value);
    this.error.set(null);
    // Clear form when toggling
    this.password = '';
    this.confirmPassword = '';
  }

  async submitForm(): Promise<void> {
    // Validation
    if (!this.email || !this.password) {
      this.error.set('Email and password are required');
      return;
    }

    if (this.isRegisterMode()) {
      if (this.password !== this.confirmPassword) {
        this.error.set('Passwords do not match');
        return;
      }
      if (this.password.length < 8) {
        this.error.set('Password must be at least 8 characters');
        return;
      }
    }

    this.loading.set(true);
    this.error.set(null);

    try {
      if (this.isRegisterMode()) {
        await this.authService.register(this.email, this.password, this.name || undefined);
      } else {
        await this.authService.login(this.email, this.password);
      }
      this.router.navigate(['/repositories']);
    } catch (err: any) {
      this.error.set(err.error?.message || err.message || 'Authentication failed');
    } finally {
      this.loading.set(false);
    }
  }

  loginWithGitHub(): void {
    this.loading.set(true);
    this.error.set(null);

    this.authService.loginWithGitHub().catch(err => {
      this.error.set(err.message || 'Failed to initiate GitHub login');
      this.loading.set(false);
    });
  }

  loginWithMicrosoft(): void {
    this.loading.set(true);
    this.error.set(null);

    this.authService.loginWithMicrosoft().catch(err => {
      this.error.set(err.message || 'Failed to initiate Microsoft login');
      this.loading.set(false);
    });
  }
}
