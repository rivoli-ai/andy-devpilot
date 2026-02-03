import { Injectable } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { Subject } from 'rxjs';

/**
 * SignalR service for real-time communication with backend
 * Handles board updates, task execution logs, and IDE session status
 */
@Injectable({
  providedIn: 'root'
})
export class SignalRService {
  private connection?: signalR.HubConnection;
  private connectionSubject = new Subject<boolean>();
  public connectionStatus$ = this.connectionSubject.asObservable();

  constructor() {}

  /**
   * Start SignalR connection
   */
  async startConnection(): Promise<void> {
    if (this.connection) {
      return;
    }

    this.connection = new signalR.HubConnectionBuilder()
      .withUrl('http://localhost:8080/hubs/board') // Using port 8080 per user preference
      .withAutomaticReconnect()
      .build();

    try {
      await this.connection.start();
      this.connectionSubject.next(true);
      console.log('SignalR connection started');
    } catch (err) {
      console.error('Error starting SignalR connection:', err);
      this.connectionSubject.next(false);
    }

    // Handle reconnection
    this.connection.onreconnecting(() => {
      console.log('SignalR reconnecting...');
    });

    this.connection.onreconnected(() => {
      console.log('SignalR reconnected');
      this.connectionSubject.next(true);
    });

    this.connection.onclose(() => {
      console.log('SignalR connection closed');
      this.connectionSubject.next(false);
    });
  }

  /**
   * Stop SignalR connection
   */
  async stopConnection(): Promise<void> {
    if (this.connection) {
      await this.connection.stop();
      this.connection = undefined;
      this.connectionSubject.next(false);
    }
  }

  /**
   * Join a board group for a specific repository
   */
  async joinBoardGroup(repositoryId: string): Promise<void> {
    if (!this.connection) {
      await this.startConnection();
    }
    if (this.connection) {
      await this.connection.invoke('JoinBoardGroup', repositoryId);
    }
  }

  /**
   * Leave a board group
   */
  async leaveBoardGroup(repositoryId: string): Promise<void> {
    if (this.connection) {
      await this.connection.invoke('LeaveBoardGroup', repositoryId);
    }
  }

  /**
   * Subscribe to board updates
   */
  onBoardUpdate(callback: (data: any) => void): void {
    if (this.connection) {
      this.connection.on('BoardUpdated', callback);
    }
  }

  /**
   * Unsubscribe from board updates
   */
  offBoardUpdate(callback: (data: any) => void): void {
    if (this.connection) {
      this.connection.off('BoardUpdated', callback);
    }
  }

  /**
   * Get the underlying SignalR connection
   */
  getConnection(): signalR.HubConnection | undefined {
    return this.connection;
  }
}
