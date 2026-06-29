import { Routes } from '@angular/router';
import { TuningStudioComponent } from './pages/tuning-studio/tuning-studio.component';
import { ObservabilityComponent } from './pages/observability/observability.component';

export const routes: Routes = [
  { path: 'tuning', component: TuningStudioComponent },
  { path: 'observability', component: ObservabilityComponent },
  { path: '', redirectTo: 'tuning', pathMatch: 'full' },
  { path: '**', redirectTo: 'tuning' }
];
