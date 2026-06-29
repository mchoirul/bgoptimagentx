import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AdkService } from '../../services/adk.service';

@Component({
  selector: 'app-observability',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="obs-layout">
      <header class="studio-header">
        <h1>Observability & Tracing</h1>
        <a href="/ui" class="btn-secondary">Back to Studio</a>
      </header>
      
      <div class="content" *ngIf="adk.activeSessionId() as sessionId; else noSession">
         <div class="panel">
            <h2>Execution Trace for {{ sessionId.substring(0, 8) }}...</h2>
            <button (click)="loadTrace(sessionId)" class="refresh-btn"><i class="fas fa-sync"></i> Refresh Trace</button>
            <pre class="trace-output">{{ traceData() | json }}</pre>
         </div>

         <div class="panel">
            <h2>Agent Flow Graph</h2>
            <img [src]="'/dev/apps/app/build_graph_image'" alt="Agent flow graph" class="flow-graph" />
         </div>
      </div>
      <ng-template #noSession>
        <div class="empty-state">No active session selected. Go to Studio and select or start a tune.</div>
      </ng-template>
    </div>
  `,
  styleUrls: ['./observability.component.scss']
})
export class ObservabilityComponent implements OnInit {
  adk = inject(AdkService);
  traceData = signal<any>(null);

  ngOnInit() {
    const sid = this.adk.activeSessionId();
    if (sid) {
       this.loadTrace(sid);
    }
  }

  async loadTrace(sessionId: string) {
     const data = await this.adk.getTrace(sessionId);
     this.traceData.set(data);
  }
}
