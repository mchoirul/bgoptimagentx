import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AdkService } from '../../services/adk.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <aside class="sidebar" [class.collapsed]="isCollapsed()">
      <button class="toggle-collapse-btn top" (click)="toggleCollapse()" [title]="isCollapsed() ? 'Expand Sidebar' : 'Collapse Sidebar'">
        <i class="fas" [class.fa-chevron-left]="!isCollapsed()" [class.fa-chevron-right]="isCollapsed()"></i>
      </button>

      <div class="sidebar-header">
        <button class="new-tune-btn" (click)="adk.createNewSession()" title="New Tune">
          <i class="fas fa-plus"></i>
          <span class="btn-text">New Tune</span>
        </button>
      </div>
      <div class="sessions-list">
        <div class="session-item" 
             *ngFor="let s of adk.sessions()" 
             [class.active]="s.id === adk.activeSessionId()"
             [title]="s.title || ('Session ' + s.id)"
             (click)="adk.selectSession(s.id)">
          <div class="session-info">
            <i class="fas fa-message"></i>
            <span class="session-id">{{ s.title || s.id.substring(0, 8) + '...' }}</span>
          </div>

          <!-- U5: Custom inline glassmorphic delete confirmation -->
          <div class="delete-confirm-box" *ngIf="pendingDelete() === s.id" (click)="$event.stopPropagation()">
            <span class="confirm-text">Sure?</span>
            <button class="btn-confirm-yes" title="Confirm Delete" (click)="confirmDelete(s.id)">Yes</button>
            <button class="btn-confirm-no" title="Cancel" (click)="cancelDelete()">No</button>
          </div>

          <button class="delete-session-btn" *ngIf="pendingDelete() !== s.id" title="Delete Session" (click)="initiateDelete(s.id, $event)">
            <i class="far fa-trash-alt"></i>
          </button>
        </div>
      </div>
      <div class="sidebar-footer">
         <label class="upload-btn" title="Upload SQL">
           <i class="fas fa-upload"></i>
           <span class="btn-text">Upload SQL</span>
           <input type="file" hidden accept=".sql,.txt" (change)="onFileSelected($event)">
         </label>
      </div>
      <button class="toggle-collapse-btn bottom" (click)="toggleCollapse()" [title]="isCollapsed() ? 'Expand Sidebar' : 'Collapse Sidebar'">
        <i class="fas" [class.fa-chevron-left]="!isCollapsed()" [class.fa-chevron-right]="isCollapsed()"></i>
      </button>
    </aside>
  `,
  styleUrls: ['./sidebar.component.scss']
})
export class SidebarComponent {
  adk = inject(AdkService);
  isCollapsed = signal(localStorage.getItem('sidebar_collapsed') === 'true');

  // U5: State for inline custom delete confirmation
  pendingDelete = signal<string | null>(null);

  toggleCollapse() {
    this.isCollapsed.set(!this.isCollapsed());
    localStorage.setItem('sidebar_collapsed', String(this.isCollapsed()));
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.adk.uploadArtifact(input.files[0]);
    }
    input.value = ''; // reset
  }

  initiateDelete(id: string, event: Event) {
    event.stopPropagation();
    this.pendingDelete.set(id);
  }

  confirmDelete(id: string) {
    this.adk.deleteSession(id);
    this.pendingDelete.set(null);
  }

  cancelDelete() {
    this.pendingDelete.set(null);
  }
}
