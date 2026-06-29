import { Component, inject, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MarkdownModule } from 'ngx-markdown';
import { AdkService } from '../../services/adk.service';
import { SidebarComponent } from '../../components/sidebar/sidebar.component';
import { SqlBlockComponent } from '../../components/sql-block/sql-block.component';

@Component({
  selector: 'app-tuning-studio',
  standalone: true,
  imports: [CommonModule, FormsModule, SidebarComponent, SqlBlockComponent, MarkdownModule],
  template: `
    <div class="studio-layout">
      <!-- U3: Status and Error Notifications Toast -->
      <div class="toast-container" *ngIf="adk.notification() as notif" [class]="notif.type" (click)="adk.notification.set(null)">
        <i class="fas" [class.fa-exclamation-circle]="notif.type === 'error'" [class.fa-info-circle]="notif.type === 'info'" [class.fa-check-circle]="notif.type === 'success'"></i>
        <span class="toast-message">{{ notif.message }}</span>
        <span class="toast-close">&times;</span>
      </div>

      <app-sidebar></app-sidebar>
      <main class="studio-main">
        <header class="studio-header">
          <div class="title-group">
            <h1>BigQuery Tuning Studio</h1>
            <span class="badge-simulation" *ngIf="adk.simulationMode()">Simulated</span>
          </div>
          <div class="header-actions">
            <button class="btn-toggle-sim" (click)="toggleSimulation()" [class.active]="adk.simulationMode()">
               <i class="fas" [class.fa-bolt]="!adk.simulationMode()" [class.fa-wifi-slash]="adk.simulationMode()"></i>
               {{ adk.simulationMode() ? 'Simulation Mode' : 'Real-time Mode' }}
            </button>
            <a href="/ui/observability" class="btn-secondary"><i class="fas fa-chart-line"></i> Observability</a>
          </div>
        </header>
        
        <div class="simulation-banner" *ngIf="adk.simulationMode()">
          <i class="fas fa-info-circle"></i> 
          <strong>Simulated Sandbox Mode Active:</strong> This sandbox environment is offline & cannot reach Google APIs. We are running realistic simulated query tunings, dry runs, and execution traces so you can test all features.
        </div>

        <div class="workspace">
          <div class="chat-feed" #chatFeed>
            <!-- U8: Onboarding empty-state panel for real and simulated modes -->
            <div class="empty-state-card" *ngIf="adk.chatHistory().length === 0 && !adk.isStreaming()">
              <div class="logo-box">
                <i class="fas fa-magic fa-2x"></i>
              </div>
              <h2>Welcome to BigQuery Tuning Studio</h2>
              <p>Optimize your query performance and reduce cloud billing scanning costs using our code-first Gemini tuning agent.</p>
              <div class="onboarding-steps">
                <div class="step-col">
                  <div class="icon-circle"><i class="fas fa-paste"></i></div>
                  <h3>1. Input SQL</h3>
                  <p>Paste your BigQuery SQL or upload a .sql file in the sidebar.</p>
                </div>
                <div class="step-col">
                  <div class="icon-circle"><i class="fas fa-running"></i></div>
                  <h3>2. Analyze & Tune</h3>
                  <p>Our agent analyzes queries against Google Cloud best practices.</p>
                </div>
                <div class="step-col">
                  <div class="icon-circle"><i class="fas fa-play"></i></div>
                  <h3>3. Dry Run</h3>
                  <p>Run immediate dry runs on both queries to verify scanned bytes.</p>
                </div>
              </div>
              <p class="empty-hint">Select a quick scenario below, or paste your query in the textbox to begin!</p>
            </div>

            <div *ngFor="let msg of adk.chatHistory(); let i = index" 
                 class="message" 
                 [class.user]="msg.role === 'user'"
                 [class.agent]="msg.role !== 'user'"
                 [class.clickable]="hasSql(msg.message)"
                 [class.selected]="adk.selectedMessageIndex() === i"
                 (click)="selectMessage(i, msg.message)">
              <div class="msg-content">
                <markdown [data]="msg.message"></markdown>
              </div>
              
              <!-- SQL block indicator -->
              <div class="sql-msg-badge" *ngIf="hasSql(msg.message)">
                <span class="badge-pill" [class.active-pill]="adk.selectedMessageIndex() === i">
                  <i class="fas" [class.fa-check-circle]="adk.selectedMessageIndex() === i" [class.fa-code]="adk.selectedMessageIndex() !== i"></i>
                  {{ adk.selectedMessageIndex() === i ? 'Active in Workspace' : 'Click to Load SQL in Workspace' }}
                </span>
              </div>
              
              <div *ngIf="msg.actions && msg.actions.length > 0" class="actions-list">
                <div *ngFor="let act of msg.actions" class="action-item">
                  <span class="badge completed" *ngIf="act.type === 'ToolResponse' || act.tool_name">
                    <i class="fas fa-check-circle"></i> {{ act.tool_name || act }}
                  </span>
                </div>
              </div>
            </div>

            <div class="message agent streaming" *ngIf="adk.isStreaming() && adk.currentStreamingMessage()">
              <div class="msg-content">
                <markdown [data]="adk.currentStreamingMessage()"></markdown>
                <span class="cursor"></span>
              </div>
              <div class="sql-msg-badge" *ngIf="hasSql(adk.currentStreamingMessage())">
                <span class="badge-pill active-pill">
                  <i class="fas fa-sync fa-spin"></i> Live Streaming SQL...
                </span>
              </div>
            </div>

            <!-- Preloader for tool execution -->
            <div class="active-tool" *ngIf="adk.activeTool() as tool">
              <span class="badge running" *ngIf="tool.status === 'running'">
                <i class="fas fa-circle-notch fa-spin"></i> Running tool: <strong>{{ tool.name }}</strong>...
              </span>
              <span class="badge completed-badge" *ngIf="tool.status === 'completed' && tool.response">
                <i class="fas fa-check-double"></i> {{ tool.name }} result: <em>{{ tool.response }}</em>
              </span>
            </div>
          </div>

          <div class="sql-area">
             <div class="sql-header">
                <h3>Optimized SQL Workspace</h3>
                <span class="badge-live" *ngIf="adk.isStreaming()">Streaming</span>
                <span class="badge-selection" *ngIf="!adk.isStreaming() && adk.selectedMessageIndex() !== null">Historical Version</span>
                <span class="badge-latest" *ngIf="!adk.isStreaming() && adk.selectedMessageIndex() === null">Latest Version</span>
             </div>
             <app-sql-block></app-sql-block>
          </div>
        </div>

        <!-- Predefined prompt templates for easy testing -->
        <div class="templates-bar">
          <span class="label">Quick Optimization Scenarios:</span>
          <button class="template-btn" (click)="loadTemplate('Optimize high-volume nested JOINs with data skew keys')">
             <i class="fas fa-project-diagram"></i> Data Skew JOIN
          </button>
          <button class="template-btn" (click)="loadTemplate('Fix full table scan by using Partitioning & Clustering on timestamp columns')">
             <i class="fas fa-filter"></i> Partition & Cluster
          </button>
          <button class="template-btn" (click)="loadTemplate('Refactor subqueries into CTEs and remove SELECT *')">
             <i class="fas fa-code"></i> CTE Refactoring
          </button>
        </div>

        <div class="input-area">
           <textarea [(ngModel)]="prompt" 
                     placeholder="Describe your BigQuery performance issue or paste SQL... (Enter to send, Shift+Enter for newline, ↑ to recall)" 
                     (keydown)="onKeydown($event)"></textarea>
           <button (click)="send()" [disabled]="adk.isStreaming()" class="send-btn"><i class="fas fa-paper-plane"></i></button>
        </div>
      </main>
    </div>
  `,
  styleUrls: ['./tuning-studio.component.scss']
})
export class TuningStudioComponent {
  adk = inject(AdkService);
  prompt = '';
  private lastPromptRecalled = '';

  // U6: Host listeners for global window shortcuts
  @HostListener('document:keydown.control.k', ['$event'])
  onCtrlK(event: KeyboardEvent) {
    event.preventDefault();
    this.adk.createNewSession();
  }

  send(event?: Event) {
    if (event) event.preventDefault();
    if (!this.prompt.trim() || this.adk.isStreaming()) return;
    
    // Store in global window memory for ArrowUp recall (U6)
    (window as any)._lastPrompt = this.prompt;
    
    this.adk.sendMessage(this.prompt);
    this.prompt = '';
  }

  loadTemplate(text: string) {
    this.prompt = text;
  }

  toggleSimulation() {
     this.adk.simulationMode.set(!this.adk.simulationMode());
     this.adk.createNewSession();
  }

  hasSql(text: string | null): boolean {
    if (!text) return false;
    return /```(?:sql|googlesql)\b/i.test(text);
  }

  selectMessage(index: number, text: string) {
    if (this.hasSql(text)) {
      this.adk.selectedMessageIndex.set(index);
    }
  }

  // U6: Advanced keyboard and prompt recall handler
  onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      if (!event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    } else if (event.key === 'ArrowUp') {
      const textarea = event.target as HTMLTextAreaElement;
      // Only recall if the cursor is at the very beginning of the textarea
      if (textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        const last = (window as any)._lastPrompt;
        if (last && this.prompt !== last) {
          event.preventDefault();
          this.prompt = last;
        }
      }
    }
  }
}
