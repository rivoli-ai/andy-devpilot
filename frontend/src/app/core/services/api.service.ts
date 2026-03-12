import { Injectable, Inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { APP_CONFIG, AppConfig } from './config.service';

/**
 * Base API service for making HTTP requests to the backend
 */
@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly apiUrl: string;

  constructor(private http: HttpClient, @Inject(APP_CONFIG) config: AppConfig) {
    this.apiUrl = config.apiUrl;
  }

  /**
   * Generic GET request
   */
  get<T>(endpoint: string): Observable<T> {
    return this.http.get<T>(`${this.apiUrl}${endpoint}`);
  }

  /**
   * Generic POST request
   */
  post<T>(endpoint: string, body: any, options?: { headers?: { [key: string]: string } }): Observable<T> {
    const httpOptions = options?.headers ? { headers: options.headers } : {};
    return this.http.post<T>(`${this.apiUrl}${endpoint}`, body, httpOptions);
  }

  /**
   * Generic PUT request
   */
  put<T>(endpoint: string, body: any): Observable<T> {
    return this.http.put<T>(`${this.apiUrl}${endpoint}`, body);
  }

  /**
   * Generic DELETE request
   */
  delete<T>(endpoint: string): Observable<T> {
    return this.http.delete<T>(`${this.apiUrl}${endpoint}`);
  }

  /**
   * Generic PATCH request
   */
  patch<T>(endpoint: string, body: any): Observable<T> {
    return this.http.patch<T>(`${this.apiUrl}${endpoint}`, body);
  }
}
