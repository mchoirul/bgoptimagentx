import { ApplicationConfig, SecurityContext } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { provideMarkdown } from 'ngx-markdown';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    // S3: Use Angular's HTML sanitizer to neutralize any HTML/JS that the LLM
    // (or a prompt-injected payload in user SQL) might emit. This is critical
    // because the chat feed renders agent output verbatim through <markdown>.
    provideMarkdown({
      sanitize: SecurityContext.HTML
    })
  ]
};
