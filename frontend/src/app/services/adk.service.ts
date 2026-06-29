import { Injectable, signal } from '@angular/core';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { v4 as uuidv4 } from 'uuid';

export interface Session {
  id: string;
  created_at?: string;
  updated_at?: string;
  title?: string;
}

export interface AdkEvent {
  message: string;
  role?: string;
  actions?: any[];
  [key: string]: any;
}

@Injectable({
  providedIn: 'root'
})
export class AdkService {
  private readonly baseUrl = '';
  private readonly userPath = '/apps/app/users/default_user';

  // State using Signals
  sessions = signal<Session[]>([]);
  activeSessionId = signal<string | null>(null);
  
  // Chat / Streaming State
  chatHistory = signal<AdkEvent[]>([]);
  currentStreamingMessage = signal<string>('');
  isStreaming = signal<boolean>(false);
  activeTool = signal<any | null>(null);
  selectedMessageIndex = signal<number | null>(null);
  
  // Simulation / Offline Mode for Sandbox environment
  simulationMode = signal<boolean>(false); // Active by default is FALSE to be transparent and not misleading (U1)
  backendUnavailable = signal<boolean>(false); // Tracks if the backend server is unreachable

  // Error/Status Notification System (U3)
  notification = signal<{type: 'error' | 'info' | 'success', message: string} | null>(null);

  // P1/P3: Streaming throttle state.
  // Concatenating into an array and joining once per flush avoids O(n^2)
  // string growth. A timer flushes the buffer to the signal at most every
  // STREAM_FLUSH_INTERVAL_MS so the markdown view does not re-render per token.
  private static readonly STREAM_FLUSH_INTERVAL_MS = 100;
  private streamBuffer: string[] = [];
  private streamFlushTimer: any = null;
  private streamPendingFlush = false;

  // U3: Display a temporary toast notification
  notify(type: 'error' | 'info' | 'success', message: string) {
    this.notification.set({ type, message });
    setTimeout(() => {
      const curr = this.notification();
      if (curr && curr.message === message) {
        this.notification.set(null);
      }
    }, 5000);
  }

  // U4: Persisted session titles helpers
  private getPersistedTitles(): Record<string, string> {
    try {
      const stored = localStorage.getItem('bq-session-titles');
      return stored ? JSON.parse(stored) : {};
    } catch (e) {
      return {};
    }
  }

  private persistTitle(id: string, title: string) {
    try {
      const titles = this.getPersistedTitles();
      titles[id] = title;
      localStorage.setItem('bq-session-titles', JSON.stringify(titles));
    } catch (e) {}
  }

  constructor() {
    this.loadSessions();
  }

  // ---- Streaming helpers (P1, P3) ----

  private resetStreamBuffer() {
    this.streamBuffer = [];
    this.streamPendingFlush = false;
    if (this.streamFlushTimer !== null) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }
  }

  private appendStreamChunk(chunk: string) {
    if (!chunk) return;
    this.streamBuffer.push(chunk);
    if (this.streamPendingFlush) return;
    this.streamPendingFlush = true;
    this.streamFlushTimer = setTimeout(() => {
      this.streamPendingFlush = false;
      this.currentStreamingMessage.set(this.streamBuffer.join(''));
    }, AdkService.STREAM_FLUSH_INTERVAL_MS);
  }

  private finalizeStream(): string {
    if (this.streamFlushTimer !== null) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }
    this.streamPendingFlush = false;
    const finalText = this.streamBuffer.join('');
    this.currentStreamingMessage.set(finalText);
    this.streamBuffer = [];
    return finalText;
  }

  async loadSessions() {
    try {
      const res = await fetch(`${this.baseUrl}${this.userPath}/sessions`);
      if (res.ok) {
        const data = await res.json();
        let rawSessions: any[] = [];
        if (Array.isArray(data)) {
           rawSessions = data.map(s => typeof s === 'string' ? {id: s} : s);
        } else if (data.sessions) {
           rawSessions = data.sessions;
        } else if (typeof data === 'object') {
           rawSessions = Object.keys(data).map(k => ({id: k}));
        }
        
        // Merge persisted titles (U4)
        const cachedTitles = this.getPersistedTitles();
        this.sessions.set(rawSessions.map(s => ({
          ...s,
          title: cachedTitles[s.id] || s.title || undefined
        })));
        this.backendUnavailable.set(false);
      } else {
        throw new Error(`Server returned error status: ${res.status}`);
      }
    } catch (err) {
      console.warn('Failed to load sessions, defaulting to offline mode:', err);
      this.simulationMode.set(true);
      this.backendUnavailable.set(true);
      this.notify('info', 'Backend unreachable — switched to Offline Simulation Mode. Some features will be simulated.');
    }
  }

  async createNewSession() {
    try {
      if (this.simulationMode()) {
         const fallbackId = uuidv4();
         const mockSession = { id: fallbackId };
         this.sessions.update(s => [mockSession, ...s]);
         this.selectSession(fallbackId);
         return;
      }

      const res = await fetch(`${this.baseUrl}${this.userPath}/sessions`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        const newSessionId = data.id || data;
        // P4: The server returned the new session ID; prepend it locally
        // instead of re-fetching the entire sessions list (which would also
        // trigger an extra session detail fetch via selectSession).
        const newSession: Session = typeof data === 'object' && data !== null
          ? { id: newSessionId, created_at: data.created_at, updated_at: data.updated_at }
          : { id: newSessionId };
        this.sessions.update(s => {
          // Avoid duplicates if the server happens to echo an existing id.
          if (s.some(x => x.id === newSessionId)) return s;
          return [newSession, ...s];
        });
        this.selectSession(newSessionId);
      } else {
        throw new Error(`Failed to create session: ${res.status}`);
      }
    } catch (err) {
      console.error('Failed to create session, activating local simulation mode:', err);
      this.simulationMode.set(true);
      this.notify('error', 'Failed to create real-time session. Switched to offline simulation mode.');
      const fallbackId = uuidv4();
      this.sessions.update(s => [{ id: fallbackId }, ...s]);
      this.selectSession(fallbackId);
    }
  }

  async selectSession(sessionId: string) {
    this.activeSessionId.set(sessionId);
    this.chatHistory.set([]);
    this.currentStreamingMessage.set('');
    this.activeTool.set(null);
    this.selectedMessageIndex.set(null);
    
    if (this.simulationMode()) {
      // Add a greeting for simulated sessions
      this.chatHistory.set([
        {
          role: 'agent',
          message: `👋 Welcome to the BQ Tuning Studio (Simulated Offline Mode).\n\nSince this sandbox environment cannot reach Google OAuth2 endpoints to call Gemini and BigQuery directly, we are running locally in offline simulation.\n\nYou can select any query template below, or type your own, and watch how BQ Tuning Studio dynamically optimizes the SQL, tests it using Dry Runs, and builds execution traces!`
        }
      ]);
      return;
    }

    try {
      const res = await fetch(`${this.baseUrl}${this.userPath}/sessions/${sessionId}`);
      if (res.ok) {
        const data = await res.json();
        const events = data.events || (Array.isArray(data) ? data : []);
        
        const mappedEvents: AdkEvent[] = events.map((ev: any) => {
          let text = '';
          if (ev.content && ev.content.parts) {
            text = ev.content.parts
              .map((p: any) => p.text || '')
              .join('');
          }
          
          let role = ev.author || ev.role || 'agent';
          if (role === 'user') {
             role = 'user';
          } else {
             role = 'agent';
          }

          let actions: any[] = [];
          if (ev.actions) {
             actions = [ev.actions];
          }

          return {
            message: text,
            role: role,
            actions: actions
          };
        }).filter((ev: AdkEvent) => ev.message.trim() !== '');

        this.chatHistory.set(mappedEvents);

        // U4: Derive and persist title from the first user message
        const firstUserMsg = mappedEvents.find(e => e.role === 'user');
        if (firstUserMsg && firstUserMsg.message) {
          let title = firstUserMsg.message.trim();
          title = title.replace(/```[\s\S]*?```/g, '').trim(); // Remove raw SQL blocks
          title = title.split('\n')[0].trim(); // Take the first line
          if (title.length > 35) {
            title = title.substring(0, 32) + '...';
          }
          if (title) {
            this.persistTitle(sessionId, title);
            this.sessions.update(s => s.map(x => x.id === sessionId ? { ...x, title } : x));
          }
        }
      } else {
        throw new Error(`Failed to load history: ${res.status}`);
      }
    } catch (err) {
      console.error('Failed to load session history', err);
      this.notify('error', 'Failed to load session history. Check network connectivity.');
    }
  }

  async deleteSession(sessionId: string) {
    // Delete from persisted cache (U4)
    try {
      const titles = this.getPersistedTitles();
      if (sessionId in titles) {
        delete titles[sessionId];
        localStorage.setItem('bq-session-titles', JSON.stringify(titles));
      }
    } catch (e) {}

    if (this.simulationMode()) {
      this.sessions.update(s => s.filter(x => x.id !== sessionId));
      if (this.activeSessionId() === sessionId) {
        const remaining = this.sessions();
        if (remaining.length > 0) {
          this.selectSession(remaining[0].id);
        } else {
          this.activeSessionId.set(null);
          this.chatHistory.set([]);
          this.selectedMessageIndex.set(null);
        }
      }
      this.notify('success', 'Session deleted successfully.');
      return;
    }

    try {
      const res = await fetch(`${this.baseUrl}${this.userPath}/sessions/${sessionId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        this.sessions.update(s => s.filter(x => x.id !== sessionId));
        if (this.activeSessionId() === sessionId) {
          const remaining = this.sessions();
          if (remaining.length > 0) {
            this.selectSession(remaining[0].id);
          } else {
            this.activeSessionId.set(null);
            this.chatHistory.set([]);
            this.selectedMessageIndex.set(null);
          }
        }
        this.notify('success', 'Session deleted successfully.');
      } else {
        throw new Error(`Failed to delete session: ${res.status}`);
      }
    } catch (err) {
      console.error('Failed to delete session:', err);
      this.notify('error', 'Failed to delete session. Check network connection.');
    }
  }

  async uploadArtifact(file: File) {
    const sessionId = this.activeSessionId();
    if (!sessionId) {
      this.notify('error', 'No active session selected. Start a session before uploading SQL.');
      return;
    }
    
    try {
      const content = await file.text();
      const payload = {
        filename: file.name,
        artifact: {
          text: content
        }
      };

      if (this.simulationMode()) {
        this.chatHistory.update(h => [...h, { message: `I uploaded a file: ${file.name}. Please review it.`, role: 'user' }]);
        this.isStreaming.set(true);
        this.currentStreamingMessage.set('');
        this.activeTool.set(null);
        this.runSimulationFlow(`analyzing artifact ${file.name}`);
        return;
      }

      const res = await fetch(`${this.baseUrl}${this.userPath}/sessions/${sessionId}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        this.notify('success', `File '${file.name}' uploaded successfully.`);
        this.sendMessage(`I uploaded a file: ${file.name}. Please review it.`);
      } else {
        throw new Error(`Failed to upload artifact: ${res.status}`);
      }
    } catch (err) {
      console.error('Failed to upload artifact', err);
      this.notify('error', `Failed to upload SQL file: ${file.name}. Check your connection.`);
    }
  }

  async sendMessage(message: string) {
    let sessionId = this.activeSessionId();
    if (!sessionId) {
      await this.createNewSession();
      sessionId = this.activeSessionId();
    }

    if (!sessionId) return;

    this.chatHistory.update(h => [...h, { message: message, role: 'user' }]);

    this.isStreaming.set(true);
    this.currentStreamingMessage.set('');
    this.activeTool.set(null);
    this.selectedMessageIndex.set(null);
    this.resetStreamBuffer();

    if (this.simulationMode()) {
      this.runSimulationFlow(message);
      return;
    }

    // EXACT correct ADK payload matching RunAgentRequest schema
    const payload = {
      appName: 'app',
      userId: 'default_user',
      sessionId: sessionId,
      newMessage: {
        parts: [
          {
            text: message
          }
        ],
        role: 'user'
      },
      streaming: true
    };

    const currentActions: any[] = [];

    fetchEventSource(`${this.baseUrl}/run_sse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify(payload),
      onmessage: (ev) => {
        try {
          const data = JSON.parse(ev.data);

          if (data.actions) {
             currentActions.push(data.actions);
          }

          if (data.content && data.content.parts) {
            for (const part of data.content.parts) {
              if (part.text) {
                // P1+P3: buffered, throttled append.
                this.appendStreamChunk(part.text);
              }

              const fCall = part.functionCall || part.function_call;
              if (fCall) {
                this.activeTool.set({
                  status: 'running',
                  name: fCall.name || fCall.function_name
                });
              }

              const fResp = part.functionResponse || part.function_response;
              if (fResp) {
                this.activeTool.set({
                  status: 'completed',
                  name: fResp.name || fResp.function_name,
                  response: fResp.response || fResp.output
                });
              }
            }
          }
        } catch (e) {
          if (ev.data) {
             this.appendStreamChunk(ev.data);
          }
        }
      },
      onclose: () => {
        const finalText = this.finalizeStream();
        this.isStreaming.set(false);
        this.chatHistory.update(h => [...h, { message: finalText, role: 'agent', actions: currentActions }]);
        this.currentStreamingMessage.set('');
        this.activeTool.set(null);
      },
      onerror: (err) => {
        console.warn('SSE stream failed or blocked (likely offline). Fallbacking to local Simulation Mode:', err);
        this.resetStreamBuffer();
        this.simulationMode.set(true);
        this.runSimulationFlow(message);
        throw err; // Stop retry loops in fetchEventSource
      }
    });
  }

  // --- Offline high-fidelity simulator ---

  private getSimulatedResponse(message: string): {
    bestPracticesUsed: string;
    dryRunResult: string;
    fullText: string;
  } {
    const lower = message.toLowerCase();
    
    if (lower.includes('partition') || lower.includes('cluster') || lower.includes('date') || lower.includes('timestamp') || lower.includes('where') || lower.includes('full scan')) {
      return {
        bestPracticesUsed: 'read_best_practices',
        dryRunResult: 'Dry run successful: Simulated query successfully compiled and validated in offline mode.',
        fullText: `> ⚠️ **Simulated Sandbox Example:** Running in offline simulation mode. Metrics below are illustrative placeholders.

Here is an analysis and optimization of your BigQuery SQL query to implement proper **Partitioning** and **Clustering**.

### Key Optimization Issues Identified:
1. **Full Table Scans**: The original query filters on \`created_at\` which is a TIMESTAMP column but the underlying table \`analytics.page_views\` is not partitioned. This forces BigQuery to scan the entire dataset even for small date ranges.
2. **Missing Clustering**: Queries regularly filter by \`user_id\` and \`event_type\`. Without clustering, BigQuery cannot prune blocks within partitions, leading to higher slot usage and execution times.

### Applied Best Practices:
* **Time-unit Partitioning**: Re-created the table partitioned by \`DATE(created_at)\` to restrict scanned slots.
* **Multi-column Clustering**: Clustered by \`event_type\` and \`user_id\` to optimize filter and aggregation performance.

### Optimized SQL Query:
\`\`\`sql
-- Partitioned and Clustered Target Table Query
SELECT
  DATE(created_at) AS event_date,
  event_type,
  COUNT(DISTINCT user_id) AS unique_visitors,
  COUNT(1) AS total_events
FROM
  \`my-project.analytics.page_views_partitioned\`
WHERE
  created_at >= TIMESTAMP('2026-06-01 00:00:00')
  AND created_at < TIMESTAMP('2026-07-01 00:00:00')
  AND event_type = 'page_view'
GROUP BY
  1, 2
ORDER BY
  unique_visitors DESC;
\`\`\`

### Dry Run Optimization Metrics:
| Metric | Before Optimization | After Optimization | Reduction (Estimated) |
| :--- | :--- | :--- | :--- |
| **Data Scanned** | [EXAMPLE: ~124.5 GB] | [EXAMPLE: ~2.1 GB] | **~98% reduction** |
| **Estimated Cost** | [EXAMPLE: $0.62] | [EXAMPLE: <$0.01] | **~98% reduction** |
| **Execution Time** | [EXAMPLE: ~14.2 sec] | [EXAMPLE: ~1.8 sec] | **~87% reduction** |`
      };
    }
    
    if (lower.includes('join') || lower.includes('skew') || lower.includes('merge') || lower.includes('large table') || lower.includes('hotkey')) {
      return {
        bestPracticesUsed: 'read_best_practices',
        dryRunResult: 'Dry run successful: Simulated query successfully compiled and validated in offline mode.',
        fullText: `> ⚠️ **Simulated Sandbox Example:** Running in offline simulation mode. Metrics below are illustrative placeholders.

Here is the optimization analysis for your high-volume **BigQuery JOIN** query.

### Key Optimization Issues Identified:
1. **Data Skew (Hot Keys)**: The JOIN on \`user_id\` between \`web_traffic\` and \`user_profiles\` suffers from data skew. A few anonymous or system user IDs account for a massive percentage of rows, bottlenecking specific compute slots.
2. **Shuffle Bottleneck**: Joining two large tables without pre-filtering generates a huge amount of shuffled data, slowing down the query.

### Applied Best Practices:
* **Broadcast JOIN**: Pre-filtered null/anonymous keys before joining to avoid hotkey bottlenecks.
* **Aggregating Before Joining**: Pre-aggregated the web traffic table at the user level before joining with user profiles, drastically reducing the join space.

### Optimized SQL Query:
\`\`\`sql
-- Optimized Join with Pre-Aggregation and Skew Handling
WITH pre_aggregated_traffic AS (
  SELECT
    user_id,
    COUNT(1) AS total_clicks,
    SUM(page_views) AS total_pages
  FROM
    \`my-project.analytics.web_traffic\`
  WHERE
    user_id IS NOT NULL 
    AND user_id != 'anonymous'
    AND _PARTITIONDATE >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
  GROUP BY
    user_id
)
SELECT
  p.user_id,
  u.signup_country,
  u.user_segment,
  t.total_clicks,
  t.total_pages
FROM
  pre_aggregated_traffic t
INNER JOIN
  \`my-project.analytics.user_profiles\` u
  ON t.user_id = u.user_id;
\`\`\`

### Dry Run Optimization Metrics:
| Metric | Before Optimization | After Optimization | Reduction (Estimated) |
| :--- | :--- | :--- | :--- |
| **Data Scanned** | [EXAMPLE: ~452.1 GB] | [EXAMPLE: ~18.9 GB] | **~95% reduction** |
| **Estimated Cost** | [EXAMPLE: $2.26] | [EXAMPLE: ~$0.09] | **~95% reduction** |
| **Execution Time** | [EXAMPLE: ~28.5 sec] | [EXAMPLE: ~3.4 sec] | **~88% reduction** |`
      };
    }
    
    // Default fallback
    return {
      bestPracticesUsed: 'read_best_practices',
      dryRunResult: 'Dry run successful: Simulated query successfully compiled and validated in offline mode.',
      fullText: `> ⚠️ **Simulated Sandbox Example:** Running in offline simulation mode. Metrics below are illustrative placeholders.

Here is the performance analysis and optimized structure for your BigQuery SQL query.

### Key Optimization Issues Identified:
1. **Avoid SELECT ***: The original query retrieves all columns. In columnar databases like BigQuery, this results in full column-width scans, which incurs full pricing even if only a few fields are used.
2. **Subquery overhead**: Nested subqueries evaluated repeatedly. Replacing with Common Table Expressions (CTEs) makes the query more readable and allows BigQuery's query planner to optimize execution paths.

### Applied Best Practices:
* **Explicit Projection**: Selected only the required columns.
* **Common Table Expressions (CTEs)**: Structured nested subqueries into clean WITH blocks.

### Optimized SQL Query:
\`\`\`sql
-- Optimized SQL using explicit columns and CTEs
WITH filtered_transactions AS (
  SELECT
    transaction_id,
    user_id,
    amount,
    transaction_date
  FROM
    \`my-project.sales.transactions\`
  WHERE
    status = 'completed'
    AND transaction_date >= '2026-01-01'
)
SELECT
  t.transaction_date,
  COUNT(DISTINCT t.user_id) AS total_customers,
  SUM(t.amount) AS total_sales_amount,
  AVG(t.amount) AS avg_transaction_value
FROM
  filtered_transactions t
GROUP BY
  1
ORDER BY
  total_sales_amount DESC;
\`\`\`

### Dry Run Optimization Metrics:
| Metric | Before Optimization | After Optimization | Reduction (Estimated) |
| :--- | :--- | :--- | :--- |
| **Data Scanned** | [EXAMPLE: ~18.4 GB] | [EXAMPLE: ~1.1 GB] | **~94% reduction** |
| **Estimated Cost** | [EXAMPLE: $0.09] | [EXAMPLE: <$0.01] | **~94% reduction** |
| **Execution Time** | [EXAMPLE: ~5.3 sec] | [EXAMPLE: ~0.9 sec] | **~83% reduction** |`
    };
  }

  runSimulationFlow(message: string) {
    const sim = this.getSimulatedResponse(message);

    // Phase 1: Running read_best_practices
    this.activeTool.set({ status: 'running', name: 'read_best_practices' });
    this.resetStreamBuffer();

    setTimeout(() => {
      // Phase 2: Start streaming first part of response
      this.activeTool.set({ status: 'completed', name: 'read_best_practices', response: 'Successfully retrieved best practices checklist.' });

      const parts = sim.fullText.split('\n');
      let currentLineIndex = 0;

      const lineInterval = setInterval(() => {
        if (currentLineIndex < parts.length) {
          const line = parts[currentLineIndex];
          // P3: avoid quadratic string growth by pushing chunks into the buffer.
          this.appendStreamChunk((currentLineIndex === 0 ? '' : '\n') + line);
          currentLineIndex++;
        } else {
          clearInterval(lineInterval);
          this.finishSimulation();
        }
      }, 80);

    }, 1200);
  }

  private finishSimulation() {
    const finalText = this.finalizeStream();
    this.isStreaming.set(false);
    this.chatHistory.update(h => [...h, {
      message: finalText,
      role: 'agent',
      actions: [
        { type: 'ToolResponse', tool_name: 'read_best_practices' }
      ]
    }]);
    this.currentStreamingMessage.set('');
    this.activeTool.set(null);
  }

  async getTrace(sessionId: string) {
    if (this.simulationMode()) {
      return {
        session_id: sessionId,
        trace_id: "trace-" + sessionId.substring(0, 8),
        root_agent: "bq_tuner_agent",
        execution_status: "COMPLETED",
        nodes: [
          {
            node_name: "bq_tuner_agent",
            type: "AgentNode",
            status: "COMPLETED",
            start_time: "2026-06-25T04:45:00Z",
            end_time: "2026-06-25T04:45:04Z",
            input: "Optimize a query partitioned on TIMESTAMP column",
            output: "Optimized partition/clustering query successfully.",
            events: [
              {
                event_type: "ToolCall",
                tool_name: "read_best_practices",
                args: {},
                timestamp: "2026-06-25T04:45:01Z"
              },
              {
                event_type: "ToolResponse",
                tool_name: "read_best_practices",
                response: "Best practices loaded successfully.",
                timestamp: "2026-06-25T04:45:02Z"
              },
              {
                event_type: "ToolCall",
                tool_name: "dry_run_query",
                args: { query: "SELECT * FROM `page_views` WHERE created_at..." },
                timestamp: "2026-06-25T04:45:03Z"
              },
              {
                event_type: "ToolResponse",
                tool_name: "dry_run_query",
                response: "Dry run: 2.11 GB scanned.",
                timestamp: "2026-06-25T04:45:04Z"
              }
            ]
          }
        ]
      };
    }

    try {
      const res = await fetch(`${this.baseUrl}/dev/apps/app/debug/trace/session/${sessionId}`);
      if (res.ok) {
         return await res.json();
      }
    } catch(e) {
      console.error(e);
    }
    return null;
  }
}
