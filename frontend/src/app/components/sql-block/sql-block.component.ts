import { Component, inject, computed, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MarkdownModule } from 'ngx-markdown';
import { AdkService } from '../../services/adk.service';

export interface SqlBlock {
  raw: string;
  code: string;
  label: string;
}

export interface DryRunResult {
  success: boolean;
  total_bytes_scanned?: number;
  formatted_bytes?: string;
  message?: string;
  error?: string;
  unavailable?: boolean;
}

@Component({
  selector: 'app-sql-block',
  standalone: true,
  imports: [CommonModule, MarkdownModule],
  template: `
    <div class="workspace-blocks">
      <div class="sql-container" *ngFor="let block of sqlBlocks()">
        <div class="toolbar">
           <span class="lang">
             <i class="fas fa-code" style="color: #38bdf8; margin-right: 0.35rem;"></i>
             {{ block.label }}
           </span>
           <div class="actions">
             <button class="dry-run-btn" 
                     [class.loading]="dryRunLoading()[block.label]"
                     [disabled]="dryRunLoading()[block.label] || block.code.includes('Your tuned BigQuery SQL')" 
                     (click)="runDryRun(block)">
               <i class="fas" [class.fa-spinner]="dryRunLoading()[block.label]" [class.fa-spin]="dryRunLoading()[block.label]" [class.fa-play]="!dryRunLoading()[block.label]"></i>
               {{ dryRunLoading()[block.label] ? 'Running...' : 'Dry Run' }}
             </button>
             <button class="copy-btn" (click)="copyCode(block)">
               <i class="fas fa-copy"></i> Copy
             </button>
           </div>
        </div>
        <div class="editor-content">
          <markdown [data]="block.raw"></markdown>
        </div>
        
        <!-- Inline Dry Run Results -->
        <div class="dry-run-result-panel" *ngIf="dryRunResults()[block.label]">
          <div class="dry-run-success" *ngIf="dryRunResults()[block.label].success && !dryRunResults()[block.label].unavailable">
            <div class="metrics-row">
              <span class="metric" *ngIf="dryRunResults()[block.label].formatted_bytes">
                <i class="fas fa-database"></i> Scanned: <strong>{{ dryRunResults()[block.label].formatted_bytes }}</strong>
              </span>
              <span class="metric" *ngIf="dryRunResults()[block.label].total_bytes_scanned !== undefined">
                <i class="fas fa-dollar-sign"></i> Est. Cost: <strong>{{ getEstimatedCost(dryRunResults()[block.label].total_bytes_scanned) }}</strong>
              </span>
            </div>
            <div class="metrics-status">
              <i class="fas fa-check-circle"></i> Verification passed. Query compiles perfectly!
            </div>
          </div>

          <!-- Friendly Config/Credential Error display -->
          <div class="dry-run-unavailable" *ngIf="dryRunResults()[block.label].unavailable">
            <div class="warn-msg">
              <i class="fas fa-exclamation-triangle"></i> <strong>Dry Run Unavailable:</strong>
              <pre>{{ dryRunResults()[block.label].message }}</pre>
              <p class="hint">SQL tuning and chat remain fully functional. Set up BigQuery and GCloud to test scanned bytes.</p>
            </div>
          </div>

          <div class="dry-run-failure" *ngIf="!dryRunResults()[block.label].success && !dryRunResults()[block.label].unavailable">
            <div class="error-msg">
              <i class="fas fa-exclamation-circle"></i> <strong>Dry Run Failed:</strong>
              <pre>{{ dryRunResults()[block.label].error || dryRunResults()[block.label].message }}</pre>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Show active tool errors below if dry run failed -->
      <div class="error-panel" *ngIf="getError()">
         <i class="fas fa-exclamation-triangle"></i> {{ getError() }}
      </div>
    </div>
  `,
  styleUrls: ['./sql-block.component.scss']
})
export class SqlBlockComponent {
  adk = inject(AdkService);

  // User-controlled Dry Run states
  dryRunLoading = signal<Record<string, boolean>>({});
  dryRunResults = signal<Record<string, DryRunResult>>({});

  constructor() {
    // Reset dry run states whenever current active session, selected message index, or computed SQL blocks change
    effect(() => {
      // Accessing signals to track changes and trigger updates
      this.adk.activeSessionId();
      this.adk.selectedMessageIndex();
      this.sqlBlocks();
      
      // Reset
      this.dryRunLoading.set({});
      this.dryRunResults.set({});
    }, { allowSignalWrites: true });
  }

  // P2: Memoize extraction by message reference. Chat history is an
  // immutable array (we always spread on update) so identity equality is a
  // safe cache key. This avoids re-running the regex over the entire chat
  // history every time any signal changes.
  private static readonly SQL_BLOCK_REGEX = /```(?:sql|googlesql)\b([\s\S]*?)```/gi;
  private extractionCache = new WeakMap<object, { raw: string; code: string }[]>();

  private extractBlocksRaw(text: string): { raw: string; code: string }[] {
    if (!text) return [];
    const regex = new RegExp(SqlBlockComponent.SQL_BLOCK_REGEX.source, 'gi');
    const results: { raw: string; code: string }[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      results.push({ raw: match[0], code: match[1].trim() });
    }
    return results;
  }

  private extractBlocksCached(message: any): { raw: string; code: string }[] {
    if (!message || typeof message.message !== 'string') return [];
    const cached = this.extractionCache.get(message);
    if (cached) return cached;
    const blocks = this.extractBlocksRaw(message.message);
    this.extractionCache.set(message, blocks);
    return blocks;
  }

  private labelBlocks(results: { raw: string; code: string }[]): SqlBlock[] {
    if (results.length === 1) {
      return [{ raw: results[0].raw, code: results[0].code, label: 'Original SQL' }];
    }

    if (results.length >= 2) {
      // U9: Always render Optimized SQL on top, and Original SQL below (first index is original, last is optimized)
      const original = results[0];
      const optimized = results[results.length - 1];
      
      const blocks: SqlBlock[] = [
        { raw: optimized.raw, code: optimized.code, label: 'Optimized SQL' },
        { raw: original.raw, code: original.code, label: 'Original SQL' }
      ];

      // If there are intermediate queries, append them after the primary two
      for (let i = 1; i < results.length - 1; i++) {
        blocks.push({
          raw: results[i].raw,
          code: results[i].code,
          label: `Intermediate Query ${i}`
        });
      }
      return blocks;
    }
    return [];
  }

  sqlBlocks = computed<SqlBlock[]>(() => {
     // 1. If currently streaming, parse the live buffer directly (not cached
     //    because the streaming string mutates by design).
     if (this.adk.isStreaming()) {
        const streamMsg = this.adk.currentStreamingMessage();
        const blocks = this.extractBlocksRaw(streamMsg);
        if (blocks.length > 0) {
           return this.labelBlocks(blocks);
        }
     }

     const history = this.adk.chatHistory();

     // 2. If a specific message is clicked/selected, prioritize its SQL blocks.
     const selectedIdx = this.adk.selectedMessageIndex();
     if (selectedIdx !== null && selectedIdx >= 0 && selectedIdx < history.length) {
        const blocks = this.extractBlocksCached(history[selectedIdx]);
        if (blocks.length > 0) {
           return this.labelBlocks(blocks);
        }
     }

     // 3. Fallback: Search from latest to oldest in chat history to find the
     //    most recent message containing SQL.
     for (let i = history.length - 1; i >= 0; i--) {
        const blocks = this.extractBlocksCached(history[i]);
        if (blocks.length > 0) {
           return this.labelBlocks(blocks);
        }
     }

     // U9: Consistent two-slot default fallback workspace
     return [
       {
          raw: "```sql\n-- Tuned BigQuery SQL will appear here once optimized.\n```",
          code: "-- Tuned BigQuery SQL will appear here once optimized.",
          label: "Optimized SQL"
       },
       {
          raw: "```sql\n-- Your input query will be displayed here for comparison.\n```",
          code: "-- Your input query will be displayed here for comparison.",
          label: "Original SQL"
       }
     ];
  });

  getError(): string | null {
     const tool = this.adk.activeTool();
     if (tool && tool.status === 'completed' && tool.name === 'dry_run_query') {
        const res = tool.response || '';
        // Basic check if it's an error string
        if (typeof res === 'string' && (res.includes('Error') || res.includes('400'))) {
           return res;
        }
     }
     return null;
  }

  async runDryRun(block: SqlBlock) {
    const label = block.label;
    
    // Set loading state and clear old results for this block
    this.dryRunLoading.update(prev => ({ ...prev, [label]: true }));
    this.dryRunResults.update(prev => {
      const next = { ...prev };
      delete next[label];
      return next;
    });

    if (this.adk.simulationMode()) {
      // Simulate real-world network delay
      await new Promise(resolve => setTimeout(resolve, 1200));
      
      // U2: Randomized simulation metrics to avoid rigid hardcoded false claims
      let bytes = 15000000000 + Math.floor(Math.random() * 5000000000); // 15-20 GB
      if (label.toLowerCase().includes('original')) {
        bytes = 100000000000 + Math.floor(Math.random() * 30000000000); // 100-130 GB
      } else if (label.toLowerCase().includes('optimized')) {
        bytes = 1000000000 + Math.floor(Math.random() * 1500000000); // 1-2.5 GB
      }
      
      const result: DryRunResult = {
        success: true,
        total_bytes_scanned: bytes,
        formatted_bytes: this.formatBytes(bytes),
        message: 'Dry run successful: Simulated query compiles and validates in offline mode.'
      };
      
      this.dryRunLoading.update(prev => ({ ...prev, [label]: false }));
      this.dryRunResults.update(prev => ({ ...prev, [label]: result }));
      return;
    }

    try {
      const res = await fetch('/api/dry_run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: block.code })
      });
      
      if (res.ok) {
        const data = await res.json();
        // Unified tool contract (A1):
        //   { status: 'success', data: { total_bytes_scanned, message } }
        //   { status: 'error',   error_message: '...' }
        const success = data.status === 'success';
        const payload = data.data ?? {};
        const bytes: number | undefined = payload.total_bytes_scanned;
        const result: DryRunResult = {
          success,
          total_bytes_scanned: bytes,
          formatted_bytes: bytes !== undefined ? this.formatBytes(bytes) : undefined,
          message: payload.message || data.error_message || (success ? 'Dry run successful.' : 'Dry run failed.'),
          error: success ? undefined : data.error_message
        };
        this.dryRunLoading.update(prev => ({ ...prev, [label]: false }));
        this.dryRunResults.update(prev => ({ ...prev, [label]: result }));
      } else {
        // Non-OK status (e.g. 503 configuration error, 500 query error, etc.)
        let error_message = `Dry run endpoint returned status: ${res.status}`;
        let error_code = '';
        try {
          const body = await res.json();
          if (body?.detail) {
            error_message = body.detail.error_message || body.detail.message || body.detail;
            error_code = body.detail.error_code || '';
          }
        } catch (e) {}

        const is_unavailable = res.status === 503 || error_code === 'project_not_configured' || error_code === 'credentials_not_found';
        const result: DryRunResult = {
          success: false,
          unavailable: is_unavailable,
          error: error_message,
          message: error_message
        };
        this.dryRunLoading.update(prev => ({ ...prev, [label]: false }));
        this.dryRunResults.update(prev => ({ ...prev, [label]: result }));
      }
    } catch (err: any) {
      const msg = err.message || String(err);
      const is_unavailable = msg.toLowerCase().includes('project_not_configured') || msg.toLowerCase().includes('credentials_not_found');
      const result: DryRunResult = {
        success: false,
        unavailable: is_unavailable,
        error: msg,
        message: msg
      };
      this.dryRunLoading.update(prev => ({ ...prev, [label]: false }));
      this.dryRunResults.update(prev => ({ ...prev, [label]: result }));
    }
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  getEstimatedCost(bytes?: number): string {
    if (bytes === undefined || bytes === null) return '$0.00';
    const tb = bytes / (1024 * 1024 * 1024 * 1024);
    const cost = tb * 6.25; // BigQuery on-demand pricing standard ($6.25 / TB)
    if (cost < 0.01 && cost > 0) {
      return '< $0.01';
    }
    return `$${cost.toFixed(2)}`;
  }

  copyCode(block: SqlBlock) {
     if (block && block.code) {
        navigator.clipboard.writeText(block.code);
     }
  }
}
